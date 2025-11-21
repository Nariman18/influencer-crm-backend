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

const maybeDownloadFromGCS = async (
  filePath?: string | null
): Promise<{ localPath: string; downloaded: boolean }> => {
  if (!filePath) throw new Error("filePath missing");
  if (!filePath.startsWith("gs://"))
    return { localPath: filePath, downloaded: false };

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

// Small helper to normalize header values
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

// Simple plain-text extraction (keeps behavior consistent with import-helpers.extractCellText)
const extractPlainText = (v: any): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    let s = v.trim();
    if (s.toLowerCase().startsWith("mailto:")) s = s.substring(7).trim();
    return s;
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();

  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) {
      const t = v.richText
        .map((seg: any) => {
          if (!seg) return "";
          if (typeof seg === "string") return seg;
          if (typeof seg.text === "string") return seg.text;
          return "";
        })
        .join("")
        .trim();
      if (t.toLowerCase().startsWith("mailto:")) return t.substring(7).trim();
      return t;
    }

    if ("hyperlink" in v) {
      const hyperlink = String(v.hyperlink || "").trim();
      if (hyperlink.toLowerCase().startsWith("mailto:"))
        return hyperlink.substring(7).trim();
      if ("text" in v && typeof v.text === "string") return v.text.trim();
    }

    if ("text" in v && typeof v.text === "string") {
      const t = v.text.trim();
      if (t.toLowerCase().startsWith("mailto:")) return t.substring(7).trim();
      return t;
    }

    if ("result" in v) return extractPlainText(v.result);
    if (Array.isArray(v)) return v.map((it) => extractPlainText(it)).join(" ");

    if (typeof v.toString === "function") {
      const s = v.toString();
      if (s && s !== "[object Object]") {
        const t = s.trim();
        if (t.toLowerCase().startsWith("mailto:")) return t.substring(7).trim();
        return t;
      }
    }
  }

  return "";
};

const normalizeCellValue = (v: any): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const plain = extractPlainText(v).trim();
  if (!plain) return null;
  const cleaned = plain
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
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

  if (out.email && typeof out.email === "string")
    out.email = out.email.trim().toLowerCase();
  if (out.instagramHandle && typeof out.instagramHandle === "string")
    out.instagramHandle = out.instagramHandle.trim().replace(/^@+/, "");

  // normalize name if it's a JSON-ish string
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
      // ignore
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
          // proceed defensively
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

        // PASS 1: validation
        let headers: string[] | null = null;
        let validationRowIndex = 0;
        const validationErrors: Array<{ row: number; reason?: string }> = [];

        try {
          const reader = new (ExcelJS as any).stream.xlsx.WorkbookReader(
            localFilePath,
            {
              entries: "emit",
              sharedStrings: "emit",
              hyperlinks: "emit",
              worksheets: "emit",
            }
          );
          for await (const worksheet of reader) {
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
                    candidateHeaders[i - 1] = normalizeHeader(values[i]) || "";
                  } catch {
                    candidateHeaders[i - 1] = "";
                  }
                }
                const nonEmpty = candidateHeaders.some((h) => !!h);
                if (!nonEmpty) continue;
                for (let i = 0; i < candidateHeaders.length; i++)
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
                headers = candidateHeaders
                  .map((h) => String(h))
                  .map((h) => h.replace(/\s+/g, " ").trim());
                continue;
              }

              validationRowIndex++;
              let parsed: ParsedRow;
              try {
                parsed = parseRowFromHeaders(headers, values);
              } catch (e: any) {
                validationErrors.push({
                  row: validationRowIndex,
                  reason: `parse error: ${e?.message ?? String(e)}`,
                });
                continue;
              }

              // normalize for validation pass (won't write yet)
              parsed = normalizeParsedRow(parsed);
            }
            break; // only first worksheet
          }
        } catch (e: any) {
          validationErrors.push({
            row: -1,
            reason: `validation pass failed: ${String(e)}`,
          });
        }

        const critical = validationErrors.filter((m) => m.row === -1);
        if (critical.length > 0) {
          const errEntries = critical.map((m) => ({ error: m.reason }));
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
          } as any;
        }

        // PASS 2: processing
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
          const reader = new (ExcelJS as any).stream.xlsx.WorkbookReader(
            localFilePath,
            {
              entries: "emit",
              sharedStrings: "emit",
              hyperlinks: "emit",
              worksheets: "emit",
            }
          );
          headers = null;
          let buffer: ParsedRow[] = [];
          const debugRows: any[] = [];

          const flush = async () => {
            if (!buffer.length) return;

            const emails = Array.from(
              new Set(
                buffer
                  .map((r) => (r.email ? String(r.email).toLowerCase() : null))
                  .filter(Boolean)
              )
            );
            const handles = Array.from(
              new Set(
                buffer
                  .map((r) =>
                    r.instagramHandle
                      ? String(r.instagramHandle).toLowerCase()
                      : null
                  )
                  .filter(Boolean)
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

          for await (const worksheet of reader) {
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
                    candidateHeaders[i - 1] = normalizeHeader(values[i]) || "";
                  } catch {
                    candidateHeaders[i - 1] = "";
                  }
                }
                const nonEmpty = candidateHeaders.some((h) => !!h);
                if (!nonEmpty) continue;
                for (let i = 0; i < candidateHeaders.length; i++)
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
                headers = candidateHeaders
                  .map((h) => String(h))
                  .map((h) => h.replace(/\s+/g, " ").trim());
                if (process.env.IMPORT_DEBUG === "true")
                  try {
                    console.log(
                      `[import.worker] detected headers for ${
                        job.data.filename || jobId
                      }:`,
                      headers
                    );
                  } catch {}
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
              } catch (e: any) {
                failed++;
                errors.push({
                  row: processed + 1,
                  error: "Failed to parse row: " + (e as any)?.message,
                });
                continue;
              }

              parsed = normalizeParsedRow(parsed);

              if (
                process.env.IMPORT_DEBUG === "true" &&
                debugRows.length < 10
              ) {
                debugRows.push({
                  row: processed,
                  rawEmailCell: obj["email"],
                  parsedEmail: parsed.email,
                });
              }

              // raw email canonical check
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

              if (shouldMarkDM && !parsed.notes)
                parsed.notes = "Contact is through DM.";
              else if (shouldMarkDM && parsed.notes && !parsed.email) {
                const append = "Contact is through DM.";
                if (!parsed.notes.includes(append))
                  parsed.notes = `${parsed.notes}\n${append}`;
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
                  return {
                    processed,
                    success,
                    failed,
                    duplicates,
                    errors,
                  } as any;
                }
              }
            }
            break; // first worksheet only
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
          return { processed, success, failed, duplicates, errors } as any;
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
        try {
          if (localFilePath && localFilePath.startsWith(os.tmpdir()))
            await fs.promises.unlink(localFilePath);
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
