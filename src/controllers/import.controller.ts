// src/controllers/import.controller.ts
import { Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getPrisma } from "../config/prisma";
import { enqueueImport } from "../lib/import-export-queue";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { getGcsClient } from "../lib/gcs-client";

const prisma = getPrisma();
const GCS_BUCKET = process.env.GCS_BUCKET || "influencers-import-storage";

if (!GCS_BUCKET) {
  console.warn(
    "[import.controller] GCS_BUCKET not set — controller cannot upload to GCS"
  );
}

// Google Cloud client
const storageClient = getGcsClient();

/**
 * Multer in-memory storage to upload directly to GCS
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_IMPORT_FILE_MB || 200) * 1024 * 1024,
  },
});

/**
 * Build GCS object key
 */
const makeGcsKey = (managerId: string, originalname: string) => {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  const safeName = String(originalname).replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `imports/${managerId}/${ts}-${rand}-${safeName}`;
};

/**
 * 💥 FIX: Safe, Zero-DB method using Prisma DMMF.
 * This completely avoids the "Argument `id` must not be null" Prisma error.
 */
const importJobFields =
  Prisma.dmmf.datamodel.models
    .find((m) => m.name === "ImportJob")
    ?.fields.map((f) => f.name) ?? [];

const hasImportJobField = (field: string) => {
  return importJobFields.includes(field);
};

export const ImportController = {
  importInfluencers: [
    upload.single("file"),
    async (req: AuthRequest, res: Response) => {
      try {
        if (!req.user?.id) throw new AppError("Not authenticated", 401);

        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) throw new AppError("File required", 400);

        // Create initial ImportJob row
        const jobRecord = await prisma.importJob.create({
          data: {
            managerId: req.user.id,
            filename: file.originalname,
            status: "PENDING",
          },
        });

        let filePath = "";
        let fileUrl: string | null = null;

        if (GCS_BUCKET) {
          const key = makeGcsKey(req.user.id, file.originalname);
          const bucket = storageClient.bucket(GCS_BUCKET);
          const gcsFile = bucket.file(key);

          // Upload file buffer to Google Cloud Storage
          await gcsFile.save(file.buffer, {
            metadata: {
              contentType: file.mimetype || "application/octet-stream",
              metadata: {
                originalName: file.originalname,
                importJobId: jobRecord.id,
              },
            },
            resumable: false,
            public: false,
          });

          filePath = `gs://${GCS_BUCKET}/${key}`;

          // Generate signed URL (optional)
          try {
            const signedUrlArr = await gcsFile.getSignedUrl({
              action: "read",
              expires: Date.now() + 1000 * 60 * 60 * 24, // 24 hours
            });
            fileUrl = signedUrlArr[0];
          } catch (e) {
            console.warn(
              "[import.controller] Failed to generate signed URL:",
              e
            );
          }

          // Update ImportJob record
          try {
            const updateData: any = { filePath };
            if (hasImportJobField("fileUrl") && fileUrl) {
              updateData.fileUrl = fileUrl;
            }

            await prisma.importJob.update({
              where: { id: jobRecord.id },
              data: updateData,
            });
          } catch (uErr) {
            console.warn(
              "[import.controller] Failed to persist GCS metadata:",
              uErr
            );
          }
        } else {
          // fallback: save locally (dev)
          const uploadDir = path.join(process.cwd(), "tmp", "imports");
          fs.mkdirSync(uploadDir, { recursive: true });
          const localName = `${Date.now()}-${file.originalname}`;
          const localPath = path.join(uploadDir, localName);
          await fs.promises.writeFile(localPath, file.buffer);

          filePath = localPath;

          await prisma.importJob.update({
            where: { id: jobRecord.id },
            data: { filePath },
          });
        }

        // enqueue worker job
        await enqueueImport({
          managerId: req.user.id,
          filePath,
          filename: file.originalname,
          importJobId: jobRecord.id,
        });

        return res.status(202).json({
          message: "Import queued",
          jobId: jobRecord.id,
          filePath,
          fileUrl,
        });
      } catch (err) {
        console.error("importInfluencers error:", err);
        if (err instanceof AppError) throw err;
        throw new AppError("Failed to queue import", 500);
      }
    },
  ],

  importMultipleFiles: [
    upload.array("files"),
    async (req: AuthRequest, res: Response) => {
      try {
        if (!req.user?.id) throw new AppError("Not authenticated", 401);

        const files = (req as any).files as Express.Multer.File[] | undefined;
        if (!files || files.length === 0)
          throw new AppError("Files required", 400);

        const supportsFileUrl = hasImportJobField("fileUrl");

        const results: Array<{
          filename: string;
          jobId: string;
          filePath?: string;
          fileUrl?: string | null;
        }> = [];

        for (const file of files) {
          const jobRecord = await prisma.importJob.create({
            data: {
              managerId: req.user.id,
              filename: file.originalname,
              status: "PENDING",
            },
          });

          let filePath = "";
          let fileUrl: string | null = null;

          if (GCS_BUCKET) {
            const key = makeGcsKey(req.user.id, file.originalname);
            const bucket = storageClient.bucket(GCS_BUCKET);
            const gcsFile = bucket.file(key);

            await gcsFile.save(file.buffer, {
              metadata: {
                contentType: file.mimetype || "application/octet-stream",
              },
              resumable: false,
              public: false,
            });

            filePath = `gs://${GCS_BUCKET}/${key}`;

            try {
              const signedUrlArr = await gcsFile.getSignedUrl({
                action: "read",
                expires: Date.now() + 1000 * 60 * 60 * 24,
              });
              fileUrl = signedUrlArr[0];
            } catch (e) {
              fileUrl = null;
            }

            const updateData: any = { filePath };
            if (supportsFileUrl && fileUrl) {
              updateData.fileUrl = fileUrl;
            }

            await prisma.importJob.update({
              where: { id: jobRecord.id },
              data: updateData,
            });
          } else {
            // fallback: local temp file
            const uploadDir = path.join(process.cwd(), "tmp", "imports");
            fs.mkdirSync(uploadDir, { recursive: true });
            const localName = `${Date.now()}-${file.originalname}`;
            const localPath = path.join(uploadDir, localName);
            await fs.promises.writeFile(localPath, file.buffer);
            filePath = localPath;

            await prisma.importJob.update({
              where: { id: jobRecord.id },
              data: { filePath },
            });
          }

          await enqueueImport({
            managerId: req.user.id,
            filePath,
            filename: file.originalname,
            importJobId: jobRecord.id,
          });

          results.push({
            filename: file.originalname,
            jobId: jobRecord.id,
            filePath,
            fileUrl,
          });
        }

        return res.status(202).json({
          message: "Batch import queued",
          jobs: results,
        });
      } catch (err) {
        console.error("importMultipleFiles error:", err);
        if (err instanceof AppError) throw err;
        throw new AppError("Failed to queue batch imports", 500);
      }
    },
  ],

  getImportStatus: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);

      const { jobId } = req.params;
      if (!jobId) throw new AppError("jobId is required", 400);

      const job = await prisma.importJob.findUnique({ where: { id: jobId } });
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
        });
      }

      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "FAILED",
          errors: [{ error: "Cancelled by user" }] as any,
        },
      });

      return res.json({ success: true, message: "Job cancelled" });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to cancel import job", 500);
    }
  },
};

export default ImportController;
