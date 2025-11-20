// src/controllers/import.controller.ts
import { Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getPrisma } from "../config/prisma";
import { enqueueImport } from "../lib/import-export-queue";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";

const prisma = getPrisma();

const uploadDir = path.join(process.cwd(), "tmp", "imports");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: {
    fileSize: Number(process.env.MAX_IMPORT_FILE_MB || 200) * 1024 * 1024,
  },
});

export const ImportController = {
  importInfluencers: [
    upload.single("file"),
    async (req: AuthRequest, res: Response) => {
      try {
        console.log("[IMPORT] headers:", {
          authorization: req.headers.authorization,
          cookies: req.headers.cookie,
        });
        console.log("[IMPORT] req.user present:", !!req.user);
        if (!req.user?.id) throw new AppError("Not authenticated", 401);
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) throw new AppError("File required", 400);

        const jobRecord = await prisma.importJob.create({
          data: {
            managerId: req.user.id,
            filename: file.originalname,
            filePath: file.path,
            status: "PENDING",
          },
        });

        await enqueueImport({
          managerId: req.user.id,
          filePath: file.path,
          filename: file.originalname,
          importJobId: jobRecord.id,
        });

        return res
          .status(202)
          .json({ message: "Import queued", jobId: jobRecord.id });
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

        const results: Array<{ filename: string; jobId: string }> = [];

        for (const file of files) {
          const jobRecord = await prisma.importJob.create({
            data: {
              managerId: req.user.id,
              filename: file.originalname,
              filePath: file.path,
              status: "PENDING",
            },
          });

          await enqueueImport({
            managerId: req.user.id,
            filePath: file.path,
            filename: file.originalname,
            importJobId: jobRecord.id,
          });

          results.push({ filename: file.originalname, jobId: jobRecord.id });
        }

        return res
          .status(202)
          .json({ message: "Batch import queued", jobs: results });
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
        return res
          .status(400)
          .json({ message: "Job cannot be cancelled in current status" });
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
