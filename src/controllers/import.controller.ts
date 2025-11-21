// src/controllers/import.controller.ts
import { Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getPrisma } from "../config/prisma";
import { enqueueImport } from "../lib/import-export-queue";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";
import { Storage } from "@google-cloud/storage";
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

// Use explicit keyFilename if provided, otherwise use ADC.
// This avoids crashes in environments where credentials come from VM metadata.
const storageClient = getGcsClient();

/**
 * Use memoryStorage for multer so we can upload directly from buffer to GCS.
 */
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

const hasImportJobField = async (field: string) => {
  // Lightweight runtime check: ask Prisma for select of that field on a non-existing id
  // and see if Prisma throws or accepts the field.
  try {
    // This will throw if field isn't in the model's select type
    await prisma.importJob.findFirst({
      select: { id: true, [field]: true } as any,
      where: { id: null as any },
    });
    return true;
  } catch {
    return false;
  }
};

export const ImportController = {
  importInfluencers: [
    upload.single("file"),
    async (req: AuthRequest, res: Response) => {
      try {
        if (!req.user?.id) throw new AppError("Not authenticated", 401);
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) throw new AppError("File required", 400);

        // Create import job record with PENDING and placeholder filePath (will update)
        const jobRecord = await prisma.importJob.create({
          data: {
            managerId: req.user.id,
            filename: file.originalname,
            status: "PENDING",
          },
        });

        let filePath = file.path || ""; // fallback (should not exist with memoryStorage)
        let fileUrl: string | null = null;

        if (GCS_BUCKET) {
          const key = makeGcsKey(req.user.id, file.originalname);
          const bucket = storageClient.bucket(GCS_BUCKET);
          const gcsFile = bucket.file(key);

          // Upload buffer (non-resumable)
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

          // Optionally generate a signed URL (24h) for UI preview
          try {
            const signedUrl = await gcsFile.getSignedUrl({
              action: "read",
              expires: Date.now() + 1000 * 60 * 60 * 24, // 24h
            });
            fileUrl = Array.isArray(signedUrl) ? signedUrl[0] : signedUrl;
          } catch (e) {
            console.warn("[import.controller] failed to create signed URL:", e);
            fileUrl = null;
          }

          // Update job record: only set fileUrl if the ImportJob model supports it.
          try {
            const supportsFileUrl = await hasImportJobField("fileUrl");
            const updateData: any = { filePath };
            if (supportsFileUrl && fileUrl) updateData.fileUrl = fileUrl;
            // Using `as any` here to avoid polymorphic type complaints in TS if you haven't updated schema.
            await prisma.importJob.update({
              where: { id: jobRecord.id },
              data: updateData as any,
            });
          } catch (uErr) {
            console.warn(
              "[import.controller] failed to persist file metadata to importJob:",
              uErr
            );
          }
        } else {
          // fallback: write to local tmp (keep old behaviour)
          const uploadDir = path.join(process.cwd(), "tmp", "imports");
          fs.mkdirSync(uploadDir, { recursive: true });
          const localName = `${Date.now()}-${file.originalname}`;
          const localPath = path.join(uploadDir, localName);
          await fs.promises.writeFile(localPath, file.buffer);
          filePath = localPath;
          // persist local path
          try {
            await prisma.importJob.update({
              where: { id: jobRecord.id },
              data: { filePath: filePath } as any,
            });
          } catch (uErr) {
            console.warn(
              "[import.controller] failed to persist local filePath to importJob:",
              uErr
            );
          }
        }

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

        const results: Array<{
          filename: string;
          jobId: string;
          filePath?: string;
          fileUrl?: string | null;
        }> = [];

        const supportsFileUrl = await hasImportJobField("fileUrl");

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
              const signedUrl = await gcsFile.getSignedUrl({
                action: "read",
                expires: Date.now() + 1000 * 60 * 60 * 24,
              });
              fileUrl = Array.isArray(signedUrl) ? signedUrl[0] : signedUrl;
            } catch (e) {
              fileUrl = null;
            }

            try {
              const updateData: any = { filePath };
              if (supportsFileUrl && fileUrl) updateData.fileUrl = fileUrl;
              await prisma.importJob.update({
                where: { id: jobRecord.id },
                data: updateData as any,
              });
            } catch (uErr) {
              console.warn(
                "[import.controller] failed to persist imported file metadata:",
                uErr
              );
            }
          } else {
            // fallback local temp storage
            const uploadDir = path.join(process.cwd(), "tmp", "imports");
            fs.mkdirSync(uploadDir, { recursive: true });
            const localName = `${Date.now()}-${file.originalname}`;
            const localPath = path.join(uploadDir, localName);
            await fs.promises.writeFile(localPath, file.buffer);
            filePath = localPath;
            try {
              await prisma.importJob.update({
                where: { id: jobRecord.id },
                data: { filePath } as any,
              });
            } catch (uErr) {
              console.warn(
                "[import.controller] failed to persist local import job metadata:",
                uErr
              );
            }
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
