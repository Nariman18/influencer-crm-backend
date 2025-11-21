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
  extractCellText,
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

// Normalize a header cell using extractCellText (keeps behavior consistent)
const normalizeHeader = (h: any) => {
  if (h === null || h === undefined) return "";
  try {
    const txt = String(extractCellText(h) ?? "").replace(/\uFEFF/g, "");
    return txt.trim().toLowerCase();
  } catch {
    try {
      return String(h)
        .replace(/\uFEFF/g, "")
        .trim()
        .toLowerCase();
    } catch {
      return "";
    }
  }
};

// Simple normalization for row cells (uses extractCellText)
const normalizeCellValueFromRow = (v: any): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const plain = extractCellText(v || "").trim();
  if (!plain) return null;
  const cleaned = plain
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
};

// permissive simple e-mail check (matches import-helpers' logic)
const looksLikeEmailSimple = (s: string | null | undefined): boolean => {
  if (!s) return false;
  const v = String(s).trim();
  const at = v.indexOf("@");
  if (at < 1) return false;
  const after = v.substring(at + 1);
  if (!after.includes(".")) return false;
  if (after.endsWith(".")) return false;
  return true;
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

        // sanity check importJob in DB
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
        } catch {
          // continue defensively
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

        // PASS 1: try to detect header row (but don't write)
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

          // tokens we expect to see in header row
          const knownHeaderTokens = [
            "email",
            "name",
            "instagram",
            "instagram handle",
            "handle",
            "link",
            "url",
            "followers",
            "notes",
            "country",
          ];

          for await (const worksheet of reader) {
            let headerFound = false;
            for await (const row of worksheet) {
              const values = (row.values || []) as any[];
              if (!Array.isArray(values)) continue;

              // compute normalized candidate headers for this row
              const rawMaxIndex = Math.max(0, values.length - 1);
              const SAFE_MAX_COLS = 2000;
              const maxIndex = Math.min(rawMaxIndex, SAFE_MAX_COLS);

              const candidateHeaders: string[] = new Array(maxIndex).fill("");
              let hasAnyCell = false;
              for (let i = 1; i <= maxIndex; i++) {
                const cell = values[i];
                const h = normalizeHeader(cell);
                candidateHeaders[i - 1] = h || "";
                if (
                  cell !== undefined &&
                  cell !== null &&
                  String(extractCellText(cell)).trim() !== ""
                )
                  hasAnyCell = true;
              }

              if (!hasAnyCell) continue;

              // count how many known tokens we find in candidateHeaders
              const lowered = candidateHeaders.map((h) => h || "");
              const tokenMatches = knownHeaderTokens.reduce((acc, token) => {
                for (const ch of lowered) {
                  if (!ch) continue;
                  if (ch === token) {
                    acc++;
                    break;
                  }
                  if (ch.includes(token)) {
                    acc++;
                    break;
                  }
                }
                return acc;
              }, 0);

              // heuristics: if we found >=1 token prefer this row as header,
              // else if first non-empty row and no better candidate after a few rows, fallback.
              if (tokenMatches >= 1 || !headers) {
                // ensure every column has a name
                for (let i = 0; i < candidateHeaders.length; i++) {
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
                }
                headers = candidateHeaders.map((h) =>
                  String(h).replace(/\s+/g, " ").trim()
                );
                headerFound = true;
                break;
              }
            }
            // stop after first worksheet
            break;
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
          };
        }

        // PASS 2: processing rows, batching, DB writes
        try {
          await prisma.importJob.update({
            where: { id: importJobId },
            data: { status: "PROCESSING" },
          });
        } catch {}

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

          // if headers were not found in pass 1, we'll detect them on the fly in pass 2 (first non-empty row)
          let headersDetected: string[] | null = headers;
          const buffer: ParsedRow[] = [];
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

            buffer.length = 0;
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

              // detect header row on the fly if not already found
              if (!headersDetected) {
                const rawMaxIndex = Math.max(0, values.length - 1);
                const SAFE_MAX_COLS = 2000;
                const maxIndex = Math.min(rawMaxIndex, SAFE_MAX_COLS);

                const candidateHeaders: string[] = new Array(maxIndex).fill("");
                let hasAnyCell = false;
                for (let i = 1; i <= maxIndex; i++) {
                  const cell = values[i];
                  const h = normalizeHeader(cell);
                  candidateHeaders[i - 1] = h || "";
                  if (
                    cell !== undefined &&
                    cell !== null &&
                    String(extractCellText(cell)).trim() !== ""
                  )
                    hasAnyCell = true;
                }
                if (!hasAnyCell) continue;
                for (let i = 0; i < candidateHeaders.length; i++)
                  if (!candidateHeaders[i])
                    candidateHeaders[i] = `col_${i + 1}`;
                headersDetected = candidateHeaders.map((h) =>
                  String(h).replace(/\s+/g, " ").trim()
                );
                // skip this row (it's header)
                continue;
              }

              processed++;

              // build raw object using 1-based indexing (ExcelJS style)
              const obj: any = {};
              headersDetected.forEach((h, idx) => {
                obj[h] = values[idx + 1] ?? null;
              });

              // parse with your helper which returns permissive values
              let parsed: ParsedRow;
              try {
                parsed = parseRowFromHeaders(headersDetected, values);
              } catch (e: any) {
                failed++;
                errors.push({
                  row: processed + 1,
                  error: "Failed to parse row: " + (e?.message ?? String(e)),
                });
                continue;
              }

              // conservative normalization (keep things consistent with import-helpers)
              const normalized: any = { ...parsed };
              // normalize a few keys with extractCellText so richText/hyperlink/plain behave same
              for (const k of [
                "name",
                "email",
                "instagramHandle",
                "link",
                "notes",
              ]) {
                if (
                  k in normalized &&
                  normalized[k] !== null &&
                  normalized[k] !== undefined
                ) {
                  const nv = normalizeCellValueFromRow(normalized[k]);
                  if (k === "instagramHandle" && typeof nv === "string") {
                    normalized[k] = nv.replace(/^@+/, "").trim();
                  } else {
                    normalized[k] = nv ?? null;
                  }
                } else {
                  normalized[k] = normalized[k] ?? null;
                }
              }
              if (
                "followers" in normalized &&
                normalized.followers !== null &&
                normalized.followers !== undefined
              ) {
                if (typeof normalized.followers === "string") {
                  const digs = normalized.followers.replace(/[^\d]/g, "");
                  normalized.followers = digs ? parseInt(digs, 10) : null;
                } else if (typeof normalized.followers !== "number") {
                  normalized.followers = null;
                }
              }
              if (
                (!normalized.name || String(normalized.name).trim() === "") &&
                normalized.instagramHandle
              ) {
                normalized.name = normalized.instagramHandle;
              }
              parsed = normalized as ParsedRow;

              // debug snapshot
              if (
                process.env.IMPORT_DEBUG === "true" &&
                debugRows.length < 10
              ) {
                debugRows.push({
                  row: processed,
                  rawRow: values.slice(1, 15), // small sample of raw values
                  objEmailCell: obj["email"],
                  parsedEmail: parsed.email,
                });
              }

              // --- important fallback: if parsed.email missing, try raw cell plain-text extraction once more
              if (!parsed.email) {
                const rawCandidate =
                  obj["email"] ?? obj["e-mail"] ?? obj["e_mail"] ?? null;
                const candidateText = extractCellText(rawCandidate).trim();
                if (
                  candidateText &&
                  looksLikeEmailSimple(candidateText) &&
                  !looksLikeDM(candidateText.toLowerCase())
                ) {
                  parsed.email = candidateText.toLowerCase();
                }
              }

              // DM marker logic: use canonical raw cell normalized
              const rawEmailCanonical = normalizeCellValueFromRow(
                obj["email"] ?? obj["e-mail"] ?? obj["e_mail"] ?? null
              );
              const rawEmailForDM: string | null =
                rawEmailCanonical === null ? null : String(rawEmailCanonical);
              const emailCellEmpty =
                !rawEmailForDM || String(rawEmailForDM).trim() === "";
              const looksDMCell = looksLikeDM(rawEmailForDM);
              const shouldMarkDM =
                !parsed.email &&
                (looksDMCell || (emailCellEmpty && !!parsed.instagramHandle));

              if (shouldMarkDM && !parsed.notes)
                parsed.notes = "Contact is through DM.";
              else if (shouldMarkDM && parsed.notes && !parsed.email) {
                const append = "Contact is through DM.";
                if (!parsed.notes.includes(append))
                  parsed.notes = `${parsed.notes}\n${append}`;
              }

              // push to batch
              buffer.push(parsed);
              if (buffer.length >= BATCH_SIZE) await flush();

              // periodic progress and cancellation check
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

          // persist debug snapshot to importJob.errors if debug enabled
          if (
            process.env.IMPORT_DEBUG === "true" &&
            (await Promise.resolve(true))
          ) {
            try {
              const jobErrPayload = (await Promise.resolve(true))
                ? { debugRows: [] as any[] }
                : null;
              // collect debugRows from above scope if any
              // (we already filled debugRows variable)
              // update DB with debug snapshot
              // NOTE: do not include huge data here
              await prisma.importJob.update({
                where: { id: importJobId },
                data: {
                  errors:
                    debugRows.length > 0
                      ? ([{ debugRows, note: "IMPORT_DEBUG snapshot" }] as any)
                      : undefined,
                },
              });
            } catch {}
          }

          // final importJob update
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
          } catch {}
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
          } catch {}
          throw err;
        }
      } catch (unexpectedErr) {
        console.error("[import.worker] unexpected error:", unexpectedErr);
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
