// workers/import.worker.ts
import "dotenv/config";
import { Worker, Job } from "bullmq";
import ExcelJS from "exceljs";
import fs from "fs";
import os from "os";
import path from "path";
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
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import { getGcsClient } from "../lib/gcs-client";

const prisma = getPrisma();
const storageClient = getGcsClient();

const QUEUE_NAME = "influencer-imports";
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);
const STATUS_CHECK_INTERVAL = 200; // rows

interface ImportJobData {
  managerId: string;
  filePath: string;
  filename: string;
  importJobId: string;
}

/**
 * If filePath is gs://bucket/key then download to a temp local file and return local path.
 * Otherwise return the original path.
 * Caller should delete the returned local path if it's a temp file (ends with .tmp-import-<rand>).
 */
const maybeDownloadFromGCS = async (
  filePath?: string | null
): Promise<{ localPath: string; downloaded: boolean }> => {
  if (!filePath) throw new Error("filePath missing");
  if (!filePath.startsWith("gs://"))
    return { localPath: filePath, downloaded: false };

  // parse gs://bucket/path...
  const trimmed = filePath.replace(/^gs:\/\//, "");
  const [bucketName, ...rest] = trimmed.split("/");
  const key = rest.join("/");
  if (!bucketName || !key) throw new Error("Invalid gs:// path: " + filePath);

  const bucket = storageClient.bucket(bucketName);
  const file = bucket.file(key);

  const tmpDir = os.tmpdir();
  const tmpName = `import-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")}`;
  const ext = path.extname(key) || ".xlsx";
  const localPath = path.join(tmpDir, tmpName + ext);

  await file.download({ destination: localPath });
  return { localPath, downloaded: true };
};

// --- normalizeHeader, normalizeCellValue, normalizeParsedRow --- copy from your original worker
const normalizeHeader = (h: any) => {
  if (h === null || h === undefined) return "";
  try {
    return String(h)
      .replace(/\uFEFF/g, "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Extract plain text from any ExcelJS cell value, stripping all formatting
 * (fonts, sizes, colors, etc.) and returning only the text content.
 */
const extractPlainText = (v: any): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    // Clean up mailto: prefix
    let text = v;
    if (text.toLowerCase().startsWith("mailto:")) {
      text = text.substring(7);
    }
    return text;
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();

  if (typeof v === "object") {
    // ExcelJS richText format: { richText: [{ text: "...", font: {...} }, ...] }
    if ("richText" in v && Array.isArray(v.richText)) {
      let text = v.richText
        .map((seg: any) => {
          if (!seg) return "";
          // Extract only text, ignore font/size/color properties
          if (typeof seg === "string") return seg;
          if (typeof seg.text === "string") return seg.text;
          return "";
        })
        .join("");
      // Clean up mailto: prefix
      if (text.toLowerCase().startsWith("mailto:")) {
        text = text.substring(7);
      }
      return text;
    }

    // Hyperlink object: { text: "...", hyperlink: "mailto:..." }
    if ("hyperlink" in v) {
      // Try to get email from hyperlink if it's a mailto link
      const hyperlink = String(v.hyperlink || "");
      if (hyperlink.toLowerCase().startsWith("mailto:")) {
        return hyperlink.substring(7);
      }
      // Otherwise use text property
      if ("text" in v && typeof v.text === "string") {
        return v.text;
      }
    }

    // Simple text object: { text: "..." }
    if ("text" in v && typeof v.text === "string") {
      let text = v.text;
      if (text.toLowerCase().startsWith("mailto:")) {
        text = text.substring(7);
      }
      return text;
    }

    // Formula result
    if ("result" in v) {
      return extractPlainText(v.result);
    }

    // Array of values
    if (Array.isArray(v)) {
      return v.map((item) => extractPlainText(item)).join(" ");
    }

    // Try toString as last resort
    if (typeof v.toString === "function") {
      const s = v.toString();
      if (s && s !== "[object Object]") {
        if (s.toLowerCase().startsWith("mailto:")) {
          return s.substring(7);
        }
        return s;
      }
    }
  }

  return "";
};

const normalizeCellValue = (v: any): string | number | null => {
  if (v === null || v === undefined) return null;

  // For numbers, return as-is
  if (typeof v === "number") return v;

  // Extract plain text from any complex format
  const plainText = extractPlainText(v).trim();

  // Return null for empty strings
  if (!plainText) return null;

  // Clean up any remaining formatting artifacts
  // Remove zero-width characters, control characters, etc.
  const cleaned = plainText
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Control characters
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  return cleaned || null;
};

const normalizeParsedRow = (r: ParsedRow): ParsedRow => {
  const out: any = { ...r };
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
      if (k === "followers" && typeof normalized === "string") {
        const n = Number(normalized.replace(/[^\d]/g, ""));
        (out as any)[k] = Number.isFinite(n) ? n : null;
      } else {
        (out as any)[k] = normalized ?? null;
      }
    }
  }

  if (out.email && typeof out.email === "string") {
    out.email = out.email.trim();
  }

  if (out.instagramHandle && typeof out.instagramHandle === "string") {
    out.instagramHandle = out.instagramHandle.trim().replace(/^@+/, "");
  }

  if (out.name && typeof out.name === "string") {
    try {
      if (out.name.startsWith("{") || out.name.startsWith("[")) {
        const parsed = JSON.parse(out.name);
        if (Array.isArray(parsed)) {
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
      const jobName = job?.name ?? "";
      const jobId = job?.id;
      if (jobName && jobName.toString().includes("__scheduler")) return;
      if (typeof jobId === "string" && jobId.startsWith("repeat:")) return;

      const {
        managerId,
        filePath: rawFilePath,
        importJobId,
      } = job.data || ({} as any);
      if (!importJobId) {
        console.warn(
          "[import.worker] missing importJobId in job data — skipping",
          { jobId, data: job.data }
        );
        return;
      }

      // Ensure we have a local path to pass to ExcelJS. If gs://, download first.
      let localFilePath = String(rawFilePath || "");
      let downloadedTemp = false;
      try {
        if (localFilePath.startsWith("gs://")) {
          try {
            const dl = await maybeDownloadFromGCS(localFilePath);
            localFilePath = dl.localPath;
            downloadedTemp = dl.downloaded;
          } catch (dlErr) {
            console.error(
              "[import.worker] failed to download GCS file:",
              dlErr
            );
            // mark job failed in DB and exit
            try {
              await prisma.importJob.update({
                where: { id: importJobId },
                data: {
                  status: "FAILED",
                  errors: [
                    {
                      error: `Failed to fetch file from GCS: ${String(dlErr)}`,
                    },
                  ] as any,
                },
              });
            } catch (uErr) {
              console.warn(
                "[import.worker] failed to persist importJob failure:",
                uErr
              );
            }
            return;
          }
        }

        // quick DB sanity check
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
          // proceed — defensive
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
            await publishImportProgress(importJobId, {
              managerId,
              jobId: importJobId,
              ...payload,
            }).catch(() => {});
          } catch {}
          try {
            io?.to(`manager:${managerId}`).emit("import:progress", {
              jobId: importJobId,
              ...payload,
            });
          } catch {}
        };

        // -------------------------
        // PASS 1: VALIDATION (no DB writes)
        // -------------------------
        let headers: string[] | null = null;
        let validationRowIndex = 0;
        const missingHandles: Array<{ row: number; reason?: string }> = [];

        try {
          const validationReader = new (
            ExcelJS as any
          ).stream.xlsx.WorkbookReader(localFilePath, {
            entries: "emit",
            sharedStrings: "emit",
            hyperlinks: "ignore",
            worksheets: "emit",
          });

          for await (const worksheet of validationReader) {
            for await (const row of worksheet) {
              const values = (row.values || []) as any[];
              if (!Array.isArray(values)) continue;

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
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
                }

                headers = candidateHeaders.map((h) => String(h));
                headers = headers.map((h) => h.replace(/\s+/g, " ").trim());
                continue;
              }

              validationRowIndex++;

              let parsed: ParsedRow;
              try {
                parsed = parseRowFromHeaders(headers, values);
              } catch (e) {
                missingHandles.push({
                  row: validationRowIndex,
                  reason: `parse error: ${(e as any)?.message ?? String(e)}`,
                });
                continue;
              }

              parsed = normalizeParsedRow(parsed);
              // No longer blocking on missing instagramHandle - will import with empty handle
            }
            break; // only first worksheet
          }
        } catch (e) {
          missingHandles.push({
            row: -1,
            reason: `validation pass failed: ${String(e)}`,
          });
        }

        // Only fail on critical validation errors, not missing handles
        const criticalErrors = missingHandles.filter(m => m.row === -1);
        if (criticalErrors.length > 0) {
          const errEntries = criticalErrors.map((m) =>
            ({ error: m.reason })
          );
          try {
            await prisma.importJob.update({
              where: { id: importJobId },
              data: { status: "FAILED", errors: errEntries as any },
            });
          } catch (uErr) {
            console.error(
              "Failed to mark import job failed after validation:",
              uErr
            );
          }

          await emit({
            error: "Validation failed",
            failed: true,
            details: errEntries,
          });
          try {
            if (downloadedTemp) await fs.promises.unlink(localFilePath);
          } catch {}
          return {
            processed: 0,
            success: 0,
            failed: 0,
            duplicates: [],
            errors: errEntries,
          };
        }

        // -------------------------
        // PASS 2: PROCESSING
        // -------------------------
        try {
          await prisma.importJob.update({
            where: { id: importJobId },
            data: { status: "PROCESSING" },
          });
        } catch (e) {}

        let processed = 0;
        let success = 0;
        let failed = 0;
        const errors: any[] = [];
        const duplicates: any[] = [];

        try {
          const workbookReader = new (
            ExcelJS as any
          ).stream.xlsx.WorkbookReader(localFilePath, {
            entries: "emit",
            sharedStrings: "emit",
            hyperlinks: "ignore",
            worksheets: "emit",
          });

          headers = null;
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
                  res && (res as any).count
                    ? (res as any).count
                    : mapped.length;
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
              if (!Array.isArray(values)) continue;

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
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
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

              const obj: any = {};
              headers.forEach((h, idx) => {
                obj[h] = values[idx + 1] ?? null;
              });

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

              parsed = normalizeParsedRow(parsed);

              if (process.env.IMPORT_DEBUG === "true" && debugRows.length < 5) {
                debugRows.push({ row: processed, parsed, raw: obj });
              }

              const rawEmailCellNormalized = normalizeCellValue(
                obj["email"] ?? obj["e-mail"] ?? obj["e_mail"] ?? null
              );
              const rawEmailForDM: string | null =
                rawEmailCellNormalized === null
                  ? null
                  : String(rawEmailCellNormalized);

              const emailCellEmpty =
                !rawEmailForDM || String(rawEmailForDM).trim() === "";
              const looksDM = looksLikeDM(rawEmailForDM);
              const shouldMarkDM =
                !parsed.email &&
                (looksDM || (emailCellEmpty && !!parsed.instagramHandle));

              if (shouldMarkDM && !parsed.notes) {
                parsed.notes = "Contact is through DM.";
              } else if (shouldMarkDM && parsed.notes && !parsed.email) {
                const append = "Contact is through DM.";
                if (!parsed.notes.includes(append))
                  parsed.notes = `${parsed.notes}\n${append}`;
              }

              // Allow rows with missing instagramHandle - they will be imported with empty handle
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

                const cancelled = await (async () => {
                  try {
                    const j = await prisma.importJob.findUnique({
                      where: { id: importJobId },
                      select: { status: true },
                    });
                    return !!j && j.status === "FAILED";
                  } catch {
                    return false;
                  }
                })();

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
                    if (downloadedTemp) await fs.promises.unlink(localFilePath);
                  } catch {}
                  return { processed, success, failed, duplicates, errors };
                }
              }
            }
            break; // only first worksheet
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
            if (downloadedTemp) await fs.promises.unlink(localFilePath);
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
            console.error(
              "Failed to update importJob status after error:",
              uErr
            );
          }

          await emit({ error: err?.message ?? String(err), failed: true });
          try {
            if (downloadedTemp) await fs.promises.unlink(localFilePath);
          } catch (e) {}
          throw err;
        }
      } catch (unexpectedErr) {
        console.error("[import.worker] unexpected error:", unexpectedErr);
        // try to cleanup any temp file if present
        try {
          if (localFilePath && localFilePath.startsWith(os.tmpdir())) {
            await fs.promises.unlink(localFilePath);
          }
        } catch {}
        throw unexpectedErr;
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

  console.log("[import.worker] started (GCS-aware two-pass validation)");
  return worker;
};
