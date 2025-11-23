// src/controllers/optimized-import.controller.ts
import { Response } from "express";
import multer from "multer";
import { getPrisma } from "../config/prisma";
import { enqueueImport } from "../lib/import-export-queue";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";
import crypto from "crypto";
import { getGcsClient } from "../lib/gcs-client";
import * as XLSX from "xlsx";

const prisma = getPrisma();
const GCS_BUCKET = process.env.GCS_BUCKET || "influencers-import-storage";
const storageClient = getGcsClient();

// Use your existing multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_IMPORT_FILE_MB || 200) * 1024 * 1024,
  },
});

const makeGcsKey = (managerId: string, originalname: string) => {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  const safeName = String(originalname).replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `imports/${managerId}/${ts}-${rand}-${safeName}`;
};

const analyzeFile = async (buffer: Buffer, filename: string) => {
  try {
    let estimatedRows = 0;
    let columns: string[] = [];

    if (filename.endsWith(".xlsx")) {
      const workbook = XLSX.read(buffer, {
        type: "buffer",
        sheetRows: 10,
        cellStyles: false,
        cellHTML: false,
      });

      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const range = XLSX.utils.decode_range(worksheet["!ref"]!);

      estimatedRows = range.e.r;

      if (range.e.r > 0) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c })];
          if (cell && cell.v) {
            columns.push(String(cell.v));
          }
        }
      }
    } else if (filename.endsWith(".csv")) {
      const text = buffer.toString();
      const lines = text.split("\n");
      estimatedRows = Math.max(0, lines.length - 1);

      if (lines.length > 0) {
        columns = lines[0]
          .split(",")
          .map((col) => col.trim().replace(/^"|"$/g, ""));
      }
    }

    return {
      estimatedRows,
      columns,
      hasHeaders: columns.length > 0,
    };
  } catch (error) {
    console.warn("File analysis failed, using defaults:", error);
    return {
      estimatedRows: 1000,
      columns: [],
      hasHeaders: false,
    };
  }
};

const estimateProcessingTime = (rows: number) => {
  if (rows < 1000) return "1-2 minutes";
  if (rows < 5000) return "2-5 minutes";
  if (rows < 20000) return "5-10 minutes";
  if (rows < 50000) return "10-20 minutes";
  if (rows < 100000) return "20-30 minutes";
  return "30+ minutes";
};

export const OptimizedImportController = {
  importInfluencers: [
    upload.single("file"),
    async (req: AuthRequest, res: Response) => {
      try {
        if (!req.user?.id) throw new AppError("Not authenticated", 401);

        const file = (req as any).file as Express.Multer.File;
        if (!file) throw new AppError("File required", 400);

        // Quick analysis for optimization
        const fileAnalysis = await analyzeFile(file.buffer, file.originalname);

        console.log(
          `📊 File analysis: ${fileAnalysis.estimatedRows} rows, ${file.size} bytes`
        );

        // Create import job with analysis data - FIXED: Use proper Prisma types
        const importJob = await prisma.importJob.create({
          data: {
            managerId: req.user.id,
            filename: file.originalname,
            status: "PENDING",
            totalRows: fileAnalysis.estimatedRows,
            metadata: {
              // This will work after schema update
              fileSize: file.size,
              estimatedRows: fileAnalysis.estimatedRows,
              isLargeFile: fileAnalysis.estimatedRows > 10000,
              columns: fileAnalysis.columns,
              hasHeaders: fileAnalysis.hasHeaders,
              analyzedAt: new Date().toISOString(),
            },
          },
        });

        // Upload to GCS
        const key = makeGcsKey(req.user.id, file.originalname);
        const bucket = storageClient.bucket(GCS_BUCKET);
        const gcsFile = bucket.file(key);

        await gcsFile.save(file.buffer, {
          metadata: {
            contentType: file.mimetype,
            metadata: {
              importJobId: importJob.id,
              estimatedRows: fileAnalysis.estimatedRows,
              managerId: req.user.id,
              isLargeFile: fileAnalysis.estimatedRows > 10000,
            },
          },
          resumable: false,
        });

        const filePath = `gs://${GCS_BUCKET}/${key}`;

        // Update import job with file path
        await prisma.importJob.update({
          where: { id: importJob.id },
          data: { filePath },
        });

        // Queue with optimized settings - FIXED: Use updated interface
        await enqueueImport({
          managerId: req.user.id,
          filePath,
          filename: file.originalname,
          importJobId: importJob.id,
          isLargeFile: fileAnalysis.estimatedRows > 10000,
          estimatedRows: fileAnalysis.estimatedRows,
        });

        return res.status(202).json({
          message: "Import queued successfully",
          jobId: importJob.id,
          estimatedRows: fileAnalysis.estimatedRows,
          estimatedTime: estimateProcessingTime(fileAnalysis.estimatedRows),
          isLargeFile: fileAnalysis.estimatedRows > 10000,
        });
      } catch (error) {
        console.error("Import error:", error);
        if (error instanceof AppError) throw error;
        throw new AppError("Failed to process import", 500);
      }
    },
  ],

  getImportStatus: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);

      const { jobId } = req.params;
      if (!jobId) throw new AppError("jobId is required", 400);

      const job = await prisma.importJob.findUnique({
        where: { id: jobId },
        include: {
          manager: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      if (!job) throw new AppError("Not found", 404);
      if (job.managerId !== req.user.id)
        throw new AppError("Not authorized", 403);

      return res.json(job);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to get import status", 500);
    }
  },

  cancelImportJob: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);

      const { jobId } = req.params;
      if (!jobId) throw new AppError("jobId is required", 400);

      const job = await prisma.importJob.findUnique({ where: { id: jobId } });
      if (!job) throw new AppError("Not found", 404);
      if (job.managerId !== req.user.id)
        throw new AppError("Not authorized", 403);

      if (!["PENDING", "PROCESSING"].includes(job.status)) {
        return res.status(400).json({
          message: "Job cannot be cancelled in current status",
          currentStatus: job.status,
        });
      }

      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "CANCELLED",
          errors: [
            {
              error: "Cancelled by user",
              cancelledAt: new Date().toISOString(),
            },
          ] as any,
        },
      });

      return res.json({
        success: true,
        message: "Import job cancelled successfully",
        jobId: jobId,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to cancel import job", 500);
    }
  },
};

export default OptimizedImportController;
