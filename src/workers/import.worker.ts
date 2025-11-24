import "dotenv/config";
import { Worker, Job } from "bullmq";
import ExcelJS from "exceljs";
import fs from "fs";
import os from "os";
import path from "path";
import { getPrisma } from "../config/prisma";
import { getIO } from "../lib/socket";
import { connection, publishImportProgress } from "../lib/import-export-queue";
import {
  parseRowFromHeaders,
  mappedToCreateMany,
  ParsedRow,
  normalizeParsedRow,
  extractCellText,
  looksLikeDM,
  emailLooksValid,
  normalizeUnicodeEmail,
  extractCountryFromFirstRow,
} from "../lib/import-helpers";
import crypto from "crypto";
import { getGcsClient } from "../lib/gcs-client";

const prisma = getPrisma();
const storageClient = getGcsClient();

interface ImportJobData {
  managerId: string;
  filePath: string;
  filename: string;
  importJobId: string;
  isLargeFile?: boolean;
  estimatedRows?: number;
  __noop?: boolean;
  scheduler?: boolean;
  timestamp?: number;
}

async function downloadFromGCS(filePath: string) {
  if (!filePath) {
    throw new Error("File path is required");
  }

  const trimmed = filePath.replace(/^gs:\/\//, "");
  const [bucketName, ...rest] = trimmed.split("/");
  const key = rest.join("/");

  if (!bucketName || !key) {
    throw new Error("Invalid GCS path: " + filePath);
  }

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
}

async function isJobCancelled(importJobId: string): Promise<boolean> {
  if (!importJobId) return false;

  try {
    const job = await prisma.importJob.findUnique({
      where: { id: importJobId },
      select: { status: true },
    });
    return job?.status === "CANCELLED";
  } catch {
    return false;
  }
}

// ✅ IMPROVED: Better duplicate detection using name + Instagram handle
async function checkBatchDuplicates(
  rows: ParsedRow[],
  managerId: string
): Promise<Map<string, ParsedRow>> {
  const duplicateMap = new Map<string, ParsedRow>();

  // Collect unique identifiers (name + instagram handle)
  const identifiers = rows
    .filter((row) => row.name)
    .map((row) => ({
      name: row.name!.toLowerCase().trim(),
      handle: row.instagramHandle
        ? String(row.instagramHandle).toLowerCase().trim()
        : null,
    }));

  if (identifiers.length === 0) return duplicateMap;

  // ✅ Check using name AND Instagram handle for better uniqueness
  const existing = await prisma.influencer.findMany({
    where: {
      managerId,
      OR: identifiers.map((id) => ({
        AND: [
          { name: { equals: id.name, mode: "insensitive" } },
          id.handle
            ? { instagramHandle: { contains: id.handle, mode: "insensitive" } }
            : {},
        ],
      })),
    },
    select: {
      name: true,
      instagramHandle: true,
      email: true,
    },
  });

  // Create lookup set with name+handle combination
  const existingSet = new Set(
    existing.map((influencer) => {
      const name = influencer.name?.toLowerCase().trim() || "";
      const handle = influencer.instagramHandle?.toLowerCase().trim() || "";
      return `${name}|${handle}`;
    })
  );

  // Mark duplicates
  rows.forEach((row) => {
    if (row.name) {
      const name = row.name.toLowerCase().trim();
      const handle = row.instagramHandle
        ? String(row.instagramHandle).toLowerCase().trim()
        : "";
      const key = `${name}|${handle}`;

      if (existingSet.has(key)) {
        duplicateMap.set(key, row);
      }
    }
  });

  console.log(
    `🔍 Duplicate check: ${duplicateMap.size} duplicates found out of ${rows.length} rows`
  );
  return duplicateMap;
}

async function safeUpdateJobStatus(importJobId: string, data: any) {
  if (!importJobId) {
    console.error("Cannot update job: importJobId is undefined");
    return;
  }

  try {
    await prisma.importJob.update({
      where: { id: importJobId },
      data,
    });
  } catch (error) {
    console.error(`Failed to update job ${importJobId}:`, error);
  }
}

function extractInstagramUsername(link: string | null): string | null {
  if (!link) return null;

  try {
    const patterns = [
      /instagram\.com\/([A-Za-z0-9._]+)(?:\/|$)/i,
      /^@?([A-Za-z0-9._]{1,30})$/,
    ];

    for (const pattern of patterns) {
      const match = link.match(pattern);
      if (match && match[1]) {
        return match[1].replace(/^@/, "").trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function processDMNotes(parsedRow: ParsedRow, rawEmail: any): ParsedRow {
  const emailText = rawEmail ? extractCellText(rawEmail).trim() : null;

  const isDM =
    looksLikeDM(emailText) || (!parsedRow.email && parsedRow.instagramHandle);

  if (isDM) {
    const dmNote = "Contact is through DM.";

    if (!parsedRow.notes) {
      parsedRow.notes = dmNote;
    } else if (!parsedRow.notes.includes(dmNote)) {
      parsedRow.notes = `${parsedRow.notes}\n${dmNote}`;
    }
  }

  return parsedRow;
}

// ✅ RELAXED: More permissive empty row detection
function hasRowData(values: any[]): boolean {
  if (!Array.isArray(values)) return false;

  // Check columns 1, 2, 3 (A, B, C) for ANY meaningful data
  for (let i = 1; i <= 3; i++) {
    const value = values[i];

    if (value === null || value === undefined || value === "") {
      continue;
    }

    const text = extractCellText(value).trim();

    // Only skip truly empty values and obvious headers
    if (text === "") continue;
    if (text.toLowerCase() === "nickname") continue;
    if (text.toLowerCase() === "link") continue;
    if (text.toLowerCase() === "e-mail") continue;

    // If we have ANY other text, consider it valid data
    return true;
  }

  return false;
}

function debugRowData(rowNumber: number, values: any[]): void {
  console.log(`🔍 DEBUG Row ${rowNumber}:`, {
    colA: values[1] ? extractCellText(values[1]).trim() : "EMPTY",
    colB: values[2] ? extractCellText(values[2]).trim() : "EMPTY",
    colC: values[3] ? extractCellText(values[3]).trim() : "EMPTY",
    hasData: hasRowData(values),
  });
}

// ✅ OPTIMIZED: Process large files with better performance
async function processLargeImport(job: Job<ImportJobData>) {
  const BATCH_SIZE = 2000; // ✅ INCREASED from 1000
  const STATUS_INTERVAL = 2000; // ✅ INCREASED from 1000

  if (!job.data) {
    throw new Error("Job data is undefined");
  }

  const {
    managerId,
    filePath: rawFilePath,
    importJobId,
    estimatedRows,
  } = job.data;

  if (!importJobId) {
    throw new Error("importJobId is required");
  }

  if (!rawFilePath) {
    throw new Error("filePath is required");
  }

  let localFilePath = "";
  let downloadedTemp = false;

  try {
    if (typeof rawFilePath === "string" && rawFilePath.startsWith("gs://")) {
      const result = await downloadFromGCS(rawFilePath);
      localFilePath = result.localPath;
      downloadedTemp = result.downloaded;
    } else {
      localFilePath = rawFilePath;
    }

    await safeUpdateJobStatus(importJobId, { status: "PROCESSING" });

    let processed = 0;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];
    const duplicates: any[] = [];

    let batchCountry: string | null = null;

    const emitProgress = async () => {
      await publishImportProgress(importJobId, {
        managerId,
        jobId: importJobId,
        processed,
        success,
        failed,
        duplicatesCount: duplicates.length,
        estimatedTotal: estimatedRows,
      }).catch(() => {});
    };

    const workbookReader = new (ExcelJS as any).stream.xlsx.WorkbookReader(
      localFilePath,
      {
        entries: "emit",
        sharedStrings: "cache",
        hyperlinks: "ignore",
        styles: "ignore",
        worksheets: "emit",
      }
    );

    let buffer: ParsedRow[] = [];

    const flushBuffer = async () => {
      if (buffer.length === 0) return;

      try {
        const duplicateMap = await checkBatchDuplicates(buffer, managerId);
        const uniqueRows = buffer.filter((row) => {
          const name = row.name ? row.name.toLowerCase().trim() : "";
          const handle = row.instagramHandle
            ? String(row.instagramHandle).toLowerCase().trim()
            : "";
          const key = `${name}|${handle}`;
          return !duplicateMap.has(key);
        });

        buffer.forEach((row) => {
          const name = row.name ? row.name.toLowerCase().trim() : "";
          const handle = row.instagramHandle
            ? String(row.instagramHandle).toLowerCase().trim()
            : "";
          const key = `${name}|${handle}`;
          if (duplicateMap.has(key)) {
            duplicates.push({
              name: row.name,
              instagramHandle: row.instagramHandle,
              email: row.email,
              error: "Duplicate influencer",
            });
          }
        });

        if (uniqueRows.length > 0) {
          try {
            const result = await prisma.influencer.createMany({
              data: uniqueRows.map((row) => mappedToCreateMany(row, managerId)),
              skipDuplicates: true,
            });
            success += result.count;
            console.log(
              `✅ Batch inserted: ${result.count}/${uniqueRows.length} influencers`
            );
          } catch (error) {
            console.error("❌ Batch insert failed:", error);
            failed += uniqueRows.length;
            errors.push({
              batch: `rows_${processed - buffer.length + 1}_to_${processed}`,
              error:
                error instanceof Error
                  ? error.message
                  : "Batch processing failed",
            });
          }
        }

        failed += buffer.length - uniqueRows.length;
        buffer = [];
      } catch (error) {
        console.error("Batch processing failed:", error);
        failed += buffer.length;
        errors.push({
          batch: `rows_${processed - buffer.length + 1}_to_${processed}`,
          error:
            error instanceof Error ? error.message : "Batch processing failed",
        });
        buffer = [];
      }
    };

    for await (const worksheet of workbookReader) {
      let isFirstRow = true;

      for await (const row of worksheet) {
        const values = (row.values || []) as any[];
        if (!Array.isArray(values)) continue;

        if (isFirstRow) {
          isFirstRow = false;

          const detectedCountry = extractCountryFromFirstRow(values);
          if (detectedCountry) {
            batchCountry = detectedCountry;
            console.log(
              `🌍 Country detected for entire batch: "${batchCountry}"`
            );
          }

          continue;
        }

        if (!hasRowData(values)) {
          continue;
        }

        processed++;

        try {
          const rawNickname = values[1] ?? null;
          const rawLink = values[2] ?? null;
          const rawEmail = values[3] ?? null;

          const name = rawNickname ? extractCellText(rawNickname).trim() : null;
          const link = rawLink ? extractCellText(rawLink).trim() : null;
          const emailCandidate = rawEmail
            ? extractCellText(rawEmail).trim()
            : null;

          let email = null;
          if (emailCandidate && emailLooksValid(emailCandidate)) {
            email = normalizeUnicodeEmail(emailCandidate).toLowerCase();
          }

          const parsedRow: ParsedRow = {
            name,
            email,
            instagramHandle: link,
            link,
            followers: null,
            country: batchCountry,
            notes: null,
          };

          const rowWithDMNotes = processDMNotes(parsedRow, rawEmail);

          const normalized = normalizeParsedRow(rowWithDMNotes);

          if (!normalized.name || normalized.name.trim() === "") {
            failed++;
            errors.push({
              row: processed,
              error: "Missing name! Name is required",
              data: normalized,
            });
            continue;
          }

          buffer.push(normalized);

          if (buffer.length >= BATCH_SIZE) {
            await flushBuffer();
          }

          if (processed % STATUS_INTERVAL === 0) {
            await emitProgress();

            if (await isJobCancelled(importJobId)) {
              throw new Error("Import cancelled by user");
            }
          }
        } catch (error) {
          failed++;
          errors.push({
            row: processed,
            error:
              error instanceof Error ? error.message : "Row processing failed",
          });
        }
      }
      break;
    }

    if (buffer.length > 0) {
      await flushBuffer();
    }

    await emitProgress();

    const finalStatus =
      failed === 0 && duplicates.length === 0
        ? "COMPLETED"
        : "COMPLETED_WITH_ERRORS";

    await safeUpdateJobStatus(importJobId, {
      status: finalStatus,
      totalRows: processed,
      successCount: success,
      failedCount: failed + duplicates.length,
      duplicates: duplicates.length > 0 ? (duplicates as any) : undefined,
      errors: errors.length > 0 ? (errors as any) : undefined,
      completedAt: new Date(),
    });

    await publishImportProgress(importJobId, {
      managerId,
      jobId: importJobId,
      processed,
      success,
      failed: failed + duplicates.length,
      duplicatesCount: duplicates.length,
      done: true,
    });

    if (batchCountry) {
      console.log(`📊 Import completed with country: ${batchCountry}`);
    }

    console.log(
      `📊 Import completed: ${success} success, ${failed} failed, ${duplicates.length} duplicates`
    );

    return {
      processed,
      success,
      failed: failed + duplicates.length,
      duplicates,
      errors,
    };
  } catch (error) {
    console.error("Large import processing failed:", error);

    await safeUpdateJobStatus(importJobId, {
      status: "FAILED",
      errors: [
        { error: error instanceof Error ? error.message : "Processing failed" },
      ] as any,
      completedAt: new Date(),
    });

    throw error;
  } finally {
    if (downloadedTemp && localFilePath) {
      try {
        await fs.promises.unlink(localFilePath);
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp file:", cleanupError);
      }
    }
  }
}

// Standard import for smaller files
async function processStandardImport(job: Job<ImportJobData>) {
  const BATCH_SIZE = 1000;

  if (!job.data) {
    throw new Error("Job data is undefined");
  }

  const { managerId, filePath: rawFilePath, importJobId } = job.data;

  if (!importJobId) {
    throw new Error("importJobId is required");
  }

  if (!rawFilePath) {
    throw new Error("filePath is required");
  }

  let localFilePath = "";
  let downloadedTemp = false;

  try {
    if (typeof rawFilePath === "string" && rawFilePath.startsWith("gs://")) {
      const result = await downloadFromGCS(rawFilePath);
      localFilePath = result.localPath;
      downloadedTemp = result.downloaded;
    } else {
      localFilePath = rawFilePath;
    }

    await safeUpdateJobStatus(importJobId, { status: "PROCESSING" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localFilePath);

    const worksheet = workbook.worksheets[0];
    const rows: any[] = [];

    let batchCountry: string | null = null;

    console.log("🔍 DEBUG: Reading Excel file structure");
    console.log("Worksheet name:", worksheet.name);
    console.log("Total rows:", worksheet.rowCount);
    console.log("Total columns:", worksheet.columnCount);

    // Check Row 1 for country
    let firstRowValues: any[] | null = null;
    worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (!firstRowValues) firstRowValues = [];
      firstRowValues[colNumber] = cell.value;
    });

    if (firstRowValues) {
      const detectedCountry = extractCountryFromFirstRow(firstRowValues);
      if (detectedCountry) {
        batchCountry = detectedCountry;
        console.log(`🌍 Country detected for entire batch: "${batchCountry}"`);
      }
    }

    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      debugRowData(rowNumber, row.values as any[]);

      if (rowNumber > 1) {
        if (hasRowData(row.values as any[])) {
          rows.push(row.values);
          console.log(`✅ Including row ${rowNumber} in processing`);
        } else {
          console.log(`❌ Skipping empty row ${rowNumber}`);
        }
      } else {
        console.log(`📋 Skipping row 1 (header/country)`);
      }
    });

    console.log(`📊 Processing ${rows.length} data rows from Excel file`);
    if (batchCountry) {
      console.log(`🌍 Applying country "${batchCountry}" to all influencers`);
    }

    let processed = 0;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];
    const duplicates: any[] = [];

    const validRows: ParsedRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowValues = rows[i];

      console.log(`🔍 Processing row ${i} with values:`, rowValues);

      try {
        const rawNickname = rowValues[1] ?? null;
        const rawLink = rowValues[2] ?? null;
        const rawEmail = rowValues[3] ?? null;

        console.log(`🔍 Row ${i} raw values:`, {
          rawNickname,
          rawLink,
          rawEmail,
        });

        const name = rawNickname ? extractCellText(rawNickname).trim() : null;
        const link = rawLink ? extractCellText(rawLink).trim() : null;
        const emailCandidate = rawEmail
          ? extractCellText(rawEmail).trim()
          : null;

        let email = null;
        if (emailCandidate && emailLooksValid(emailCandidate)) {
          email = normalizeUnicodeEmail(emailCandidate).toLowerCase();
        }

        const parsedRow: ParsedRow = {
          name,
          email,
          instagramHandle: link,
          link,
          followers: null,
          country: batchCountry,
          notes: null,
        };

        const rowWithDMNotes = processDMNotes(parsedRow, rawEmail);

        console.log(`✅ Parsed row ${i}:`, rowWithDMNotes);

        const normalized = normalizeParsedRow(rowWithDMNotes);

        console.log(`✅ Normalized row ${i}:`, {
          finalName: normalized.name,
          finalEmail: normalized.email,
          finalHandle: normalized.instagramHandle,
          finalLink: normalized.link,
          finalCountry: normalized.country,
          finalNotes: normalized.notes,
        });

        if (!normalized.name || normalized.name.trim() === "") {
          console.log(`❌ Row ${i} failed: Missing name`);
          failed++;
          errors.push({
            row: i,
            error: "Missing name! Name is required",
            data: normalized,
          });
          continue;
        }

        validRows.push(normalized);
        processed++;
      } catch (error) {
        console.log(`❌ Row ${i} parsing error:`, error);
        failed++;
        errors.push({
          row: i,
          error: error instanceof Error ? error.message : "Row parsing failed",
        });
      }
    }

    if (validRows.length > 0) {
      const duplicateMap = await checkBatchDuplicates(validRows, managerId);
      const uniqueRows = validRows.filter((row) => {
        const name = row.name ? row.name.toLowerCase().trim() : "";
        const handle = row.instagramHandle
          ? String(row.instagramHandle).toLowerCase().trim()
          : "";
        const key = `${name}|${handle}`;
        return !duplicateMap.has(key);
      });

      validRows.forEach((row) => {
        const name = row.name ? row.name.toLowerCase().trim() : "";
        const handle = row.instagramHandle
          ? String(row.instagramHandle).toLowerCase().trim()
          : "";
        const key = `${name}|${handle}`;
        if (duplicateMap.has(key)) {
          duplicates.push({
            name: row.name,
            instagramHandle: row.instagramHandle,
            email: row.email,
            error: "Duplicate influencer",
          });
        }
      });

      if (uniqueRows.length > 0) {
        try {
          const result = await prisma.influencer.createMany({
            data: uniqueRows.map((row) => mappedToCreateMany(row, managerId)),
            skipDuplicates: true,
          });
          success += result.count;
          console.log(
            `✅ Batch insert successful: ${result.count} influencers created`
          );
        } catch (error) {
          console.error("❌ Batch insert failed:", error);
          failed += uniqueRows.length;
          errors.push({
            batch: "batch_insert",
            error:
              error instanceof Error
                ? error.message
                : "Batch processing failed",
          });
        }
      }

      failed += validRows.length - uniqueRows.length;
    }

    await publishImportProgress(importJobId, {
      managerId,
      jobId: importJobId,
      processed,
      success,
      failed,
      duplicatesCount: duplicates.length,
      estimatedTotal: rows.length,
    });

    if (await isJobCancelled(importJobId)) {
      throw new Error("Import cancelled by user");
    }

    const finalStatus =
      failed === 0 && duplicates.length === 0
        ? "COMPLETED"
        : "COMPLETED_WITH_ERRORS";

    await safeUpdateJobStatus(importJobId, {
      status: finalStatus,
      totalRows: processed,
      successCount: success,
      failedCount: failed + duplicates.length,
      duplicates: duplicates.length > 0 ? (duplicates as any) : undefined,
      errors: errors.length > 0 ? (errors as any) : undefined,
      completedAt: new Date(),
    });

    if (batchCountry) {
      console.log(`📊 Standard import completed with country: ${batchCountry}`);
    }

    console.log(
      `📊 Standard import completed: ${success} success, ${failed} failed, ${duplicates.length} duplicates`
    );

    return {
      processed,
      success,
      failed: failed + duplicates.length,
      duplicates,
      errors,
    };
  } catch (error) {
    console.error("Standard import processing failed:", error);

    await safeUpdateJobStatus(importJobId, {
      status: "FAILED",
      errors: [
        { error: error instanceof Error ? error.message : "Processing failed" },
      ] as any,
      completedAt: new Date(),
    });

    throw error;
  } finally {
    if (downloadedTemp && localFilePath) {
      try {
        await fs.promises.unlink(localFilePath);
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp file:", cleanupError);
      }
    }
  }
}

export const startOptimizedImportWorker = () => {
  const worker = new Worker(
    "influencer-imports",
    async (job: Job<ImportJobData>) => {
      console.log(`🚀 Processing import job: ${job.id}, name: ${job.name}`);

      const isSchedulerJob =
        job.name === "__scheduler-noop" ||
        job.data?.__noop === true ||
        job.name?.includes("scheduler") ||
        job.id?.includes("scheduler");

      if (isSchedulerJob) {
        console.log(`[optimized-import.worker] skipping scheduler job`, {
          jobId: job.id,
          jobName: job.name,
        });
        return { skipped: true, reason: "scheduler_job" };
      }

      if (!job.data || typeof job.data !== "object") {
        throw new Error("Invalid job data - cannot process import");
      }

      const { importJobId, managerId, filePath } = job.data;

      if (!importJobId || !managerId || !filePath) {
        console.warn(
          `[optimized-import.worker] missing required fields, skipping job`,
          {
            jobId: job.id,
            importJobId,
            managerId,
            filePath,
          }
        );
        return { skipped: true, reason: "missing_required_fields" };
      }

      console.log(
        `Starting import job: ${importJobId}, manager: ${managerId}, file: ${filePath}`
      );

      const { isLargeFile, estimatedRows } = job.data;

      if (isLargeFile || (estimatedRows && estimatedRows > 5000)) {
        return await processLargeImport(job);
      } else {
        return await processStandardImport(job);
      }
    },
    {
      connection,
      concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 2),
    }
  );

  worker.on("failed", (job, err) => {
    if (job?.name === "__scheduler-noop" || job?.data?.__noop === true) {
      console.log(
        `[optimized-import.worker] scheduler job failed (ignored)`,
        job?.id
      );
      return;
    }

    console.error("[optimized-import.worker] job failed", job?.id, err);

    if (job?.data?.importJobId) {
      safeUpdateJobStatus(job.data.importJobId, {
        status: "FAILED",
        errors: [
          { error: err.message, failedAt: new Date().toISOString() },
        ] as any,
        completedAt: new Date(),
      }).catch(console.error);
    } else {
      console.warn(
        "[optimized-import.worker] Cannot update job status: importJobId is undefined"
      );
    }
  });

  worker.on("completed", (job, result) => {
    if (job?.name === "__scheduler-noop" || job?.data?.__noop === true) {
      return;
    }

    console.log(`[optimized-import.worker] job ${job.id} completed:`, {
      processed: result.processed,
      success: result.success,
      failed: result.failed,
      duplicates: result.duplicates?.length || 0,
    });
  });

  worker.on("error", (err) => {
    console.error("[optimized-import.worker] worker error:", err);
  });

  console.log("[optimized-import.worker] started with optimized file support");
  return worker;
};
