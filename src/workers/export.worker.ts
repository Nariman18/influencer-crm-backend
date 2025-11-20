// src/workers/export.worker.ts
import "dotenv/config";
import { Worker, Job } from "bullmq";
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { getPrisma } from "../config/prisma";
import { getIO } from "../lib/socket";
import { connection, publishExportProgress } from "../lib/import-export-queue";

const prisma = getPrisma();

interface ExportJobData {
  managerId: string;
  exportJobId: string;
  filters?: any;
}
const QUEUE_NAME = "influencer-exports";
const PAGE_SIZE = Number(process.env.EXPORT_PAGE_SIZE || 1000);

export const startExportWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<ExportJobData>) => {
      // Skip scheduler / noop / repeat jobs
      const jobName = job?.name ?? "";
      const jobId = job?.id;
      if (jobName && jobName.toString().includes("__scheduler")) {
        console.log("[export.worker] skipping scheduler/noop job", {
          jobId,
          jobName,
        });
        return;
      }
      if (typeof jobId === "string" && jobId.startsWith("repeat:")) {
        console.log("[export.worker] skipping repeat scheduler job", { jobId });
        return;
      }

      const { managerId, exportJobId, filters } = job.data || ({} as any);
      if (!exportJobId) {
        console.warn(
          "[export.worker] missing exportJobId in job data — skipping",
          { jobId, data: job.data }
        );
        return;
      }

      const io = (() => {
        try {
          return getIO();
        } catch {
          return null;
        }
      })();

      const emit = async (payload: any) => {
        try {
          await publishExportProgress(exportJobId, {
            managerId,
            jobId: exportJobId,
            ...payload,
          }).catch(() => {});
        } catch (e) {
          // swallow
        }
        try {
          io?.to(`manager:${managerId}`).emit("export:progress", {
            jobId: exportJobId,
            ...payload,
          });
        } catch (e) {
          // swallow
        }
      };

      await prisma.exportJob.update({
        where: { id: exportJobId },
        data: { status: "PROCESSING" },
      });

      const where: any = { managerId };
      if (filters?.status && filters.status !== "ALL")
        where.status = filters.status;
      if (filters?.search) {
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { name: { contains: filters.search, mode: "insensitive" } },
              { email: { contains: filters.search, mode: "insensitive" } },
              {
                instagramHandle: {
                  contains: filters.search,
                  mode: "insensitive",
                },
              },
            ],
          },
        ];
      }
      if (filters?.emailFilter === "HAS_EMAIL")
        where.AND = [...(where.AND || []), { email: { not: null } }];
      if (filters?.emailFilter === "NO_EMAIL")
        where.AND = [...(where.AND || []), { email: null }];

      const total = await prisma.influencer.count({ where });

      const exportDir = path.join(process.cwd(), "tmp", "exports");
      fs.mkdirSync(exportDir, { recursive: true });
      const filename = `influencers-export-${exportJobId}.xlsx`;
      const filepath = path.join(exportDir, filename);

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: filepath,
      });
      const sheet = workbook.addWorksheet("Influencers");
      sheet
        .addRow([
          "Name",
          "Email",
          "Instagram",
          "Link",
          "Followers",
          "Country",
          "Status",
          "Notes",
          "ManagerEmail",
        ])
        .commit();

      let processed = 0;
      let page = 0;

      try {
        while (true) {
          const rows = await prisma.influencer.findMany({
            where,
            skip: page * PAGE_SIZE,
            take: PAGE_SIZE,
            orderBy: { createdAt: "desc" },
            include: { manager: { select: { email: true } } },
          });
          if (!rows.length) break;
          for (const r of rows) {
            sheet
              .addRow([
                r.name,
                r.email ?? null,
                r.instagramHandle ?? null,
                r.link ?? null,
                r.followers ?? null,
                r.country ?? null,
                r.status ?? null,
                r.notes ?? null,
                r.manager?.email ?? null,
              ])
              .commit();
          }
          processed += rows.length;
          page++;
          await job.updateProgress({ processed, total } as any);
          emit({
            processed,
            total,
            percent: total ? Math.round((processed / total) * 100) : null,
          });
        }

        await workbook.commit();

        // update DB
        await prisma.exportJob.update({
          where: { id: exportJobId },
          data: {
            status: "COMPLETED",
            filePath: filepath,
            totalRows: processed,
          },
        });

        emit({ done: true, processed, total, downloadReady: true });

        return { processed, total, filePath: filepath };
      } catch (err: any) {
        try {
          await prisma.exportJob.update({
            where: { id: exportJobId },
            data: { status: "FAILED", error: err?.message ?? String(err) },
          });
        } catch (uErr) {
          console.error("Failed to update exportJob status after error:", uErr);
        }
        emit({ error: err?.message ?? String(err) });
        throw err;
      }
    },
    {
      connection, // reuse
      concurrency: Number(process.env.EXPORT_WORKER_CONCURRENCY || 1),
    }
  );

  worker.on("failed", (job, err) => {
    console.error("[export.worker] job failed", job?.id, err);
  });

  worker.on("completed", (job) => {
    console.log("[export.worker] job completed", job?.id);
  });

  console.log("[export.worker] started");
  return worker;
};
