// src/workers/import.worker.ts
import "dotenv/config";
import { Worker, Job } from "bullmq";
import ExcelJS from "exceljs";
import fs from "fs";
import { getPrisma } from "../config/prisma";
import { getIO } from "../lib/socket";
import { InfluencerStatus, Prisma } from "@prisma/client";
import { connection } from "../lib/import-export-queue";
import {
  parseRowFromHeaders,
  mappedToCreateMany,
  ParsedRow,
} from "../lib/import-helpers";

const prisma = getPrisma();
const QUEUE_NAME = "influencer-imports";
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);

// small helper to detect "DM-like" markers in an email cell
const looksLikeDM = (s: any): boolean => {
  if (!s && s !== "") return false;
  const v = String(s).trim().toLowerCase();
  if (!v) return false;
  const dmMarkers = [
    "dm",
    "d/m",
    "via dm",
    "instagram dm",
    "ig dm",
    "direct message",
    "instagram",
    "no email",
    "n/a",
    "na",
    "-",
    "—",
    "none",
    // other languages you requested
    "директ",
    "дм",
    "дірект",
    "direct",
    "dm",
    "DM",
  ];
  return dmMarkers.some((m) => v === m || v.includes(m));
};

interface ImportJobData {
  managerId: string;
  filePath: string;
  filename: string;
  importJobId: string;
}

export const startImportWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<ImportJobData>) => {
      // SKIP scheduler / noop / repeat jobs that don't contain user payload.
      const jobName = job?.name ?? "";
      const jobId = job?.id;
      if (jobName && jobName.toString().includes("__scheduler")) {
        // scheduler noop job - nothing to do
        console.log("[import.worker] skipping scheduler/noop job", {
          jobId,
          jobName,
        });
        return;
      }
      if (typeof jobId === "string" && jobId.startsWith("repeat:")) {
        console.log("[import.worker] skipping repeat scheduler job", { jobId });
        return;
      }

      // Extract data and defensively check required fields
      const { managerId, filePath, importJobId } = job.data || ({} as any);
      if (!importJobId) {
        console.warn(
          "[import.worker] missing importJobId in job data — skipping",
          { jobId, data: job.data }
        );
        return;
      }

      // socket IO (optional — if not initialized will be null)
      const io = (() => {
        try {
          return getIO();
        } catch {
          return null;
        }
      })();

      const emit = (payload: any) => {
        try {
          io?.to(`manager:${managerId}`).emit("import:progress", {
            jobId: importJobId,
            ...payload,
          });
        } catch (e) {
          // swallow socket errors
        }
      };

      // mark job processing
      await prisma.importJob.update({
        where: { id: importJobId },
        data: { status: "PROCESSING" },
      });

      let processed = 0;
      let success = 0;
      let failed = 0;
      const errors: any[] = [];
      const duplicates: any[] = [];

      try {
        const workbookReader = new (ExcelJS as any).stream.xlsx.WorkbookReader(
          filePath,
          {
            entries: "emit",
            sharedStrings: "cache",
            hyperlinks: "emit",
            worksheets: "emit",
          }
        );

        let headers: string[] | null = null;
        let buffer: ParsedRow[] = [];

        const flush = async () => {
          if (!buffer.length) return;

          const emails = Array.from(
            new Set(
              buffer
                .map((r) => r.email)
                .filter(Boolean)
                .map(String)
                .map((s) => s.toLowerCase())
            )
          );
          const handles = Array.from(
            new Set(
              buffer
                .map((r) => r.instagramHandle)
                .filter(Boolean)
                .map(String)
                .map((s) => s.toLowerCase())
            )
          );

          const existing = await prisma.influencer.findMany({
            where: {
              managerId,
              OR: [
                emails.length ? { email: { in: emails } } : undefined,
                handles.length
                  ? { instagramHandle: { in: handles } }
                  : undefined,
              ].filter(Boolean) as any[],
            },
            select: { id: true, email: true, instagramHandle: true },
          });

          const existingEmails = new Set(
            existing
              .map((e) => String(e.email || "").toLowerCase())
              .filter(Boolean)
          );
          const existingHandles = new Set(
            existing
              .map((e) => String(e.instagramHandle || "").toLowerCase())
              .filter(Boolean)
          );

          const toInsert = buffer.filter((r) => {
            const em = r.email ? String(r.email).toLowerCase() : null;
            const handle = r.instagramHandle
              ? String(r.instagramHandle).toLowerCase()
              : null;

            if (em && existingEmails.has(em)) {
              duplicates.push({ email: r.email, handle: r.instagramHandle });
              return false;
            }
            if (handle && existingHandles.has(handle)) {
              duplicates.push({ handle: r.instagramHandle, email: r.email });
              return false;
            }
            return true;
          });

          if (toInsert.length) {
            const mapped: Prisma.InfluencerCreateManyInput[] = toInsert.map(
              (r) => mappedToCreateMany(r, managerId)
            );

            try {
              const res = await prisma.influencer.createMany({
                data: mapped,
                skipDuplicates: true,
              });
              success +=
                res && (res as any).count ? (res as any).count : mapped.length;
            } catch (e: any) {
              for (const row of mapped) {
                try {
                  await prisma.influencer.create({ data: row as any });
                  success++;
                } catch (innerErr: any) {
                  failed++;
                  errors.push({
                    row: row.email || row.instagramHandle,
                    error: innerErr?.message ?? String(innerErr),
                  });
                }
              }
            }
          }

          buffer = [];
          await job.updateProgress({ processed, success, failed } as any);
          emit({
            processed,
            success,
            failed,
            duplicatesCount: duplicates.length,
          });
        };

        for await (const worksheet of workbookReader) {
          for await (const row of worksheet) {
            const values = (row.values || []) as any[];

            if (!headers) {
              headers = values
                .slice(1)
                .map((h: any) => (h ? String(h).trim().toLowerCase() : ""));
              continue;
            }

            processed++;

            const obj: any = {};
            headers.forEach((h, idx) => {
              obj[h] = values[idx + 1] ?? null;
            });

            const parsed = parseRowFromHeaders(headers, values);

            const rawEmailCell =
              obj["email"] ?? obj["e-mail"] ?? obj["e_mail"] ?? null;

            if (!parsed.notes && !parsed.email && looksLikeDM(rawEmailCell)) {
              parsed.notes = "Contact is through DM.";
            } else if (
              parsed.notes &&
              !parsed.email &&
              looksLikeDM(rawEmailCell)
            ) {
              const append = "Contact is through DM.";
              if (!parsed.notes.includes(append))
                parsed.notes = `${parsed.notes}\n${append}`;
            }

            if (!parsed.email && !parsed.instagramHandle) {
              failed++;
              errors.push({
                row: processed + 1,
                error: "Missing email and instagram handle",
              });
              if (processed % 200 === 0) {
                await job.updateProgress({ processed, success, failed } as any);
                emit({
                  processed,
                  success,
                  failed,
                  duplicatesCount: duplicates.length,
                });
              }
              continue;
            }

            buffer.push(parsed);

            if (buffer.length >= BATCH_SIZE) {
              await flush();
            }

            if (processed % 200 === 0) {
              await job.updateProgress({ processed, success, failed } as any);
              emit({
                processed,
                success,
                failed,
                duplicatesCount: duplicates.length,
              });
            }
          }

          break;
        }

        if (buffer.length) await flush();

        await prisma.importJob.update({
          where: { id: importJobId },
          data: {
            status: "COMPLETED",
            totalRows: processed,
            successCount: success,
            failedCount: failed,
            duplicates: duplicates.length ? (duplicates as any) : undefined,
            errors: errors.length ? (errors as any) : undefined,
          },
        });

        emit({
          done: true,
          processed,
          success,
          failed,
          duplicatesCount: duplicates.length,
        });

        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // ignore
        }

        return { processed, success, failed, duplicates, errors };
      } catch (err: any) {
        try {
          await prisma.importJob.update({
            where: { id: importJobId },
            data: {
              status: "FAILED",
              errors: [{ error: err?.message ?? String(err) }] as any,
            },
          });
        } catch (uErr) {
          console.error("Failed to update importJob status after error:", uErr);
        }

        emit({ error: err?.message ?? String(err), failed: true });

        try {
          fs.unlinkSync(filePath);
        } catch (e) {}

        throw err;
      }
    },
    {
      connection,
      concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 1),
    }
  );

  worker.on("failed", (job, err) => {
    console.error("[import.worker] job failed", job?.id, err);
  });

  worker.on("completed", (job) => {
    console.log("[import.worker] job completed", job?.id);
  });

  console.log("[import.worker] started");
  return worker;
};
