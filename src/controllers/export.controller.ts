// src/controllers/export.controller.ts
import { Response } from "express";
import { getPrisma } from "../config/prisma";
import { enqueueExport } from "../lib/import-export-queue";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";
import path from "path";
import fs from "fs";

const prisma = getPrisma();

export const ExportController = {
  // POST /api/export (body: { filters?: any })
  createExport: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);

      // Accept object or JSON-string; normalize to object or undefined
      let filtersRaw = (req.body && req.body.filters) ?? undefined;
      if (typeof filtersRaw === "string") {
        try {
          filtersRaw = JSON.parse(filtersRaw);
        } catch {
          filtersRaw = undefined;
        }
      }
      const filters = filtersRaw ?? undefined;

      // NOTE: do NOT pass `filename` if your Prisma model doesn't define it.
      // We'll set filePath later from the worker when export completes.
      const jobRecord = await prisma.exportJob.create({
        data: {
          managerId: req.user.id,
          status: "PENDING",
          // Prisma JSON/NullableJson field: pass object or undefined (not string or null)
          filters: filters ?? undefined,
        },
      });

      await enqueueExport({
        managerId: req.user.id,
        exportJobId: jobRecord.id,
        filters,
      });

      return res
        .status(202)
        .json({ message: "Export queued", jobId: jobRecord.id });
    } catch (err) {
      console.error("createExport error:", err);
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to queue export", 500);
    }
  },

  // GET /api/export/:jobId/status
  getExportStatus: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);
      const { jobId } = req.params;
      if (!jobId) throw new AppError("jobId is required", 400);

      const job = await prisma.exportJob.findUnique({ where: { id: jobId } });
      if (!job) throw new AppError("Not found", 404);
      if (job.managerId !== req.user.id)
        throw new AppError("Not authorized", 403);

      return res.json(job);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to get export status", 500);
    }
  },

  // GET /api/export/:jobId/download
  downloadExport: async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.id) throw new AppError("Not authenticated", 401);
      const { jobId } = req.params;
      if (!jobId) throw new AppError("jobId is required", 400);

      const job = await prisma.exportJob.findUnique({ where: { id: jobId } });
      if (!job) throw new AppError("Not found", 404);
      if (job.managerId !== req.user.id)
        throw new AppError("Not authorized", 403);

      if (job.status !== "COMPLETED" || !job.filePath) {
        return res.status(400).json({ message: "Export not ready" });
      }

      const filePath = job.filePath;
      if (!fs.existsSync(filePath))
        return res.status(404).json({ message: "File not found" });

      const filename = path.basename(filePath);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (err) {
      console.error("downloadExport error:", err);
      if (err instanceof AppError) throw err;
      throw new AppError("Failed to download export", 500);
    }
  },
};

export default ExportController;
