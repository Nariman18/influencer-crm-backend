// src/workers/import.worker.ts
import "dotenv/config";
import { Worker, Job } from "bullmq";
import ExcelJS from "exceljs";
import fs from "fs";
import { getPrisma } from "../config/prisma";
import { getIO } from "../lib/socket";
import { Prisma } from "@prisma/client";
import { connection, publishImportProgress } from "../lib/import-export-queue";
import {
  parseRowFromHeaders,
  mappedToCreateMany,
  ParsedRow,
  looksLikeDM,
} from "../lib/import-helpers";

const prisma = getPrisma();
const QUEUE_NAME = "influencer-imports";
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);
const STATUS_CHECK_INTERVAL = 200; // rows

interface ImportJobData {
  managerId: string;
  filePath: string;
  filename: string;
  importJobId: string;
}

// Helper: normalize header text into a comparable key
const normalizeHeader = (h: any) => {
  if (h === null || h === undefined) return "";
  try {
    return String(h)
      .replace(/\uFEFF/g, "")
      .trim()
      .toLowerCase(); // strip BOM
  } catch {
    return "";
  }
};

/**
 * Turn ExcelJS cell values (which may be objects, arrays, formula objects, richText)
 * into a safe primitive (string / number / null). This prevents storing objects
 * directly in the database and causing "[object Object]" in the UI.
 *
 * Notes:
 * - Booleans are coerced to strings ("true" / "false") so the return type stays string|number|null
 * - Arrays of primitives or small objects are joined intelligently (handles {text} or richText segments)
 */
const normalizeCellValue = (v: any): string | number | null => {
  if (v === null || v === undefined) return null;

  // Primitive handling
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "true" : "false";

  try {
    // ExcelJS cell-like object with .text (simple case)
    if (v && typeof v === "object") {
      if ("text" in v && typeof v.text === "string") {
        return v.text.trim();
      }

      // ExcelJS richText segments: { richText: [{ text: '...' }, ...] }
      if ("richText" in v && Array.isArray(v.richText)) {
        return (
          v.richText
            .map((seg: any) =>
              seg && typeof seg.text === "string" ? seg.text : String(seg || "")
            )
            .join("")
            .trim() || null
        );
      }

      // If object has .result (formula object), normalize result
      if ("result" in v) {
        return normalizeCellValue(v.result);
      }

      // Date -> ISO
      if (v instanceof Date) return v.toISOString();

      // Arrays: try to join intelligently.
      if (Array.isArray(v)) {
        const mapped = v
          .map((x) => {
            if (x === null || x === undefined) return "";
            // if segment-like object
            if (typeof x === "object") {
              if ("text" in x && typeof x.text === "string") return x.text;
              if ("richText" in x && Array.isArray(x.richText)) {
                return x.richText
                  .map((s: any) => (s?.text ? String(s.text) : ""))
                  .join("");
              }
              // fallback to JSON for small objects
              try {
                const s = JSON.stringify(x);
                return s && s.length < 500 ? s : "";
              } catch {
                return "";
              }
            }
            return String(x);
          })
          .join(" ")
          .trim();
        return mapped || null;
      }

      // If object has a useful toString, use it (but avoid "[object Object]")
      if (typeof v.toString === "function") {
        const s = v.toString();
        if (s && s !== "[object Object]") return s.trim();
      }

      // Last resort: JSON stringify small objects
      try {
        const small = JSON.stringify(v);
        if (small && small.length < 500) return small;
      } catch {
        // noop
      }
    }
  } catch {
    // swallow
  }

  return null;
};

const normalizeParsedRow = (r: ParsedRow): ParsedRow => {
  // Create a shallow copy and normalize fields we care about
  const out: any = { ...r };

  // fields we commonly use - coerce them
  const keysToNormalize = [
    "name",
    "email",
    "instagramHandle",
    "followers",
    "notes",
    "link",
    "nickname",
    "contactMethod",
  ];

  for (const k of keysToNormalize) {
    if (k in out) {
      const raw = (out as any)[k];
      const normalized = normalizeCellValue(raw);
      // For numeric followers, keep a number if possible
      if (k === "followers" && typeof normalized === "string") {
        const n = Number(normalized.replace(/[^\d]/g, ""));
        (out as any)[k] = Number.isFinite(n) ? n : null;
      } else {
        (out as any)[k] = normalized ?? null;
      }
    }
  }

  // ensure email is lowercased string (if present)
  if (out.email && typeof out.email === "string") {
    out.email = out.email.trim();
  }

  // ensure instagramHandle is trimmed (strip leading @)
  if (out.instagramHandle && typeof out.instagramHandle === "string") {
    out.instagramHandle = out.instagramHandle.trim().replace(/^@+/, "");
  }

  // If name is an array-like or JSON blob, try to extract a human name string
  if (out.name && typeof out.name === "string") {
    // In case a JSON string was stored, attempt to parse simple structures
    try {
      if (out.name.startsWith("{") || out.name.startsWith("[")) {
        const parsed = JSON.parse(out.name);
        if (Array.isArray(parsed)) {
          // try to extract text properties
          const joined = parsed
            .map((p: any) => {
              if (!p) return "";
              if (typeof p === "string") return p;
              if (typeof p === "object") {
                if (typeof p.text === "string") return p.text;
                if (p.richText && Array.isArray(p.richText))
                  return p.richText.map((s: any) => s?.text || "").join("");
              }
              return "";
            })
            .join(" ")
            .trim();
          if (joined) out.name = joined;
        } else if (typeof parsed === "object" && parsed !== null) {
          // try common keys
          const maybe = parsed.text || parsed.name || parsed.value || null;
          if (typeof maybe === "string" && maybe.trim())
            out.name = maybe.trim();
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return out as ParsedRow;
};

export const startImportWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job<ImportJobData>) => {
      // SKIP scheduler / noop / repeat jobs that don't contain user payload.
      const jobName = job?.name ?? "";
      const jobId = job?.id;
      if (jobName && jobName.toString().includes("__scheduler")) {
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

      // If DB record doesn't exist or isn't PENDING, abort early (supports cancel flow)
      try {
        const jobRecord = await prisma.importJob.findUnique({
          where: { id: importJobId },
        });
        if (!jobRecord) {
          console.warn(
            "[import.worker] importJob record not found — aborting",
            importJobId
          );
          return;
        }
        if (jobRecord.status !== "PENDING") {
          console.log(
            "[import.worker] job not PENDING (cancelled/processed) — aborting",
            importJobId,
            jobRecord.status
          );
          return;
        }
      } catch (e) {
        // proceed — we don't want to block processing due to a transient DB read error,
        // but we already attempted to be defensive.
      }

      // socket IO (optional — if not initialized will be null)
      const io = (() => {
        try {
          return getIO();
        } catch {
          return null;
        }
      })();

      // Emit helper — publish to Redis pubsub (for cross-process forwarding)
      // and also emit directly to local socket.io if available.
      const emit = async (payload: any) => {
        try {
          // include managerId and jobId in published payload so socket subscriber can target room
          await publishImportProgress(importJobId, {
            managerId,
            jobId: importJobId,
            ...payload,
          }).catch(() => {});
        } catch (e) {
          // swallow publish errors
        }

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

      // helper: check DB record to see if job was cancelled (status === "FAILED")
      const checkForCancellation = async (): Promise<boolean> => {
        try {
          const j = await prisma.importJob.findUnique({
            where: { id: importJobId },
            select: { status: true },
          });
          if (!j) return false;
          if (j.status === "FAILED") {
            // job was cancelled by user (controller sets status to FAILED)
            return true;
          }
        } catch (e) {
          // ignore transient errors, do not fail worker because of status check
        }
        return false;
      };

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

        // We'll track headers as an array where index === column index (0-based)
        // but ExcelJS row.values is 1-based, so we use idx+1 when reading values.
        let headers: string[] | null = null;
        let buffer: ParsedRow[] = [];
        const debugRows: any[] = [];

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
          await emit({
            processed,
            success,
            failed,
            duplicatesCount: duplicates.length,
          });
        };

        for await (const worksheet of workbookReader) {
          for await (const row of worksheet) {
            const values = (row.values || []) as any[];

            // Defensive: ensure values is an array (ExcelJS sometimes gives sparse objects)
            if (!Array.isArray(values)) continue;

            // HEADER DETECTION
            if (!headers) {
              const rawMaxIndex = Math.max(0, values.length - 1);
              const SAFE_MAX_COLS = 2000;
              const maxIndex = Math.min(rawMaxIndex, SAFE_MAX_COLS);

              const hasAnyCell = (() => {
                for (let i = 1; i <= maxIndex; i++) {
                  if (
                    values[i] !== undefined &&
                    values[i] !== null &&
                    String(values[i]).trim() !== ""
                  )
                    return true;
                }
                return false;
              })();

              if (!hasAnyCell) continue;

              const candidateHeaders: string[] = new Array(maxIndex).fill("");
              for (let i = 1; i <= maxIndex; i++) {
                try {
                  const raw = values[i];
                  candidateHeaders[i - 1] = normalizeHeader(raw) || "";
                } catch {
                  candidateHeaders[i - 1] = "";
                }
              }

              const nonEmpty = candidateHeaders.some((h) => !!h);
              if (!nonEmpty) continue;

              for (let i = 0; i < candidateHeaders.length; i++) {
                if (!candidateHeaders[i]) candidateHeaders[i] = `col_${i + 1}`;
              }

              headers = candidateHeaders.map((h) => String(h));
              headers = headers.map((h) => h.replace(/\s+/g, " ").trim());

              if (process.env.IMPORT_DEBUG === "true") {
                try {
                  console.log(
                    `[import.worker] detected headers for ${
                      job.data.filename || jobId
                    }:`,
                    headers
                  );
                } catch {}
              }

              continue;
            }

            processed++;

            // Build obj mapping header->value for DM heuristics and debug
            const obj: any = {};
            headers.forEach((h, idx) => {
              obj[h] = values[idx + 1] ?? null;
            });

            // Parse row
            let parsed: ParsedRow;
            try {
              parsed = parseRowFromHeaders(headers, values);
            } catch (e) {
              failed++;
              errors.push({
                row: processed + 1,
                error: "Failed to parse row: " + (e as any)?.message,
              });
              continue;
            }

            // Normalize parsed fields to primitives
            parsed = normalizeParsedRow(parsed);

            if (process.env.IMPORT_DEBUG === "true" && debugRows.length < 5) {
              debugRows.push({ row: processed, parsed, raw: obj });
            }

            // For DM detection, normalize the raw email cell value and coerce to string|null
            const rawEmailCellNormalized = normalizeCellValue(
              obj["email"] ?? obj["e-mail"] ?? obj["e_mail"] ?? null
            );
            const rawEmailForDM: string | null =
              rawEmailCellNormalized === null
                ? null
                : String(rawEmailCellNormalized);

            if (!parsed.notes && !parsed.email && looksLikeDM(rawEmailForDM)) {
              parsed.notes = "Contact is through DM.";
            } else if (
              parsed.notes &&
              !parsed.email &&
              looksLikeDM(rawEmailForDM)
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
              if (processed % STATUS_CHECK_INTERVAL === 0) {
                await job.updateProgress({ processed, success, failed } as any);
                await emit({
                  processed,
                  success,
                  failed,
                  duplicatesCount: duplicates.length,
                });

                const cancelled = await checkForCancellation();
                if (cancelled) {
                  try {
                    await prisma.importJob.update({
                      where: { id: importJobId },
                      data: {
                        status: "FAILED",
                        errors: [{ error: "Cancelled by user" }] as any,
                      },
                    });
                  } catch {}
                  await emit({ error: "Cancelled by user", failed: true });
                  try {
                    await fs.promises.unlink(filePath);
                  } catch {}
                  return { processed, success, failed, duplicates, errors };
                }
              }
              continue;
            }

            buffer.push(parsed);

            if (buffer.length >= BATCH_SIZE) await flush();

            if (processed % STATUS_CHECK_INTERVAL === 0) {
              await job.updateProgress({ processed, success, failed } as any);
              await emit({
                processed,
                success,
                failed,
                duplicatesCount: duplicates.length,
              });

              const cancelled = await checkForCancellation();
              if (cancelled) {
                try {
                  await prisma.importJob.update({
                    where: { id: importJobId },
                    data: {
                      status: "FAILED",
                      errors: [{ error: "Cancelled by user" }] as any,
                    },
                  });
                } catch {}
                await emit({ error: "Cancelled by user", failed: true });
                try {
                  await fs.promises.unlink(filePath);
                } catch {}
                return { processed, success, failed, duplicates, errors };
              }
            }
          }

          // only process the first worksheet
          break;
        }

        if (buffer.length) await flush();

        if (process.env.IMPORT_DEBUG === "true" && debugRows.length) {
          try {
            await prisma.importJob.update({
              where: { id: importJobId },
              data: {
                errors: [{ debugRows, note: "IMPORT_DEBUG snapshot" }] as any,
              },
            });
          } catch {}
        }

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

        await emit({
          done: true,
          processed,
          success,
          failed,
          duplicatesCount: duplicates.length,
        });

        try {
          await fs.promises.unlink(filePath);
        } catch (e) {}

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

        await emit({ error: err?.message ?? String(err), failed: true });

        try {
          await fs.promises.unlink(filePath);
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
