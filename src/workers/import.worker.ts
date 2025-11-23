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
  extractCountryFromFirstRow, // ✅ NEW IMPORT
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

// Improved helper functions with better error handling
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

// Enhanced duplicate checking for batch processing - NAME BASED ONLY
async function checkBatchDuplicates(
  rows: ParsedRow[],
  managerId: string
): Promise<Map<string, ParsedRow>> {
  const duplicateMap = new Map<string, ParsedRow>();

  // Collect all names to check for duplicates
  const names = rows
    .map((row) => row.name)
    .filter(Boolean)
    .map((name) => name!.toLowerCase().trim());

  if (names.length === 0) return duplicateMap;

  // Check for existing influencers with same names (case-insensitive)
  const existing = await prisma.influencer.findMany({
    where: {
      managerId,
      name: {
        in: names,
        mode: "insensitive",
      },
    },
    select: {
      name: true,
      instagramHandle: true,
      email: true,
    },
  });

  // Create set for quick lookup
  const existingNames = new Set(
    existing
      .map((influencer) => influencer.name?.toLowerCase().trim())
      .filter(Boolean)
  );

  // Mark duplicates in the current batch
  rows.forEach((row) => {
    if (row.name && existingNames.has(row.name.toLowerCase().trim())) {
      const key = row.name.toLowerCase().trim();
      duplicateMap.set(key, row);
    }
  });

  return duplicateMap;
}

// Safe job update function
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

/**
 * Extract Instagram username from URL for display
 */
function extractInstagramUsername(link: string | null): string | null {
  if (!link) return null;

  try {
    // Match Instagram URL patterns
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

/**
 * Process DM markers and add notes
 */
function processDMNotes(parsedRow: ParsedRow, rawEmail: any): ParsedRow {
  const emailText = rawEmail ? extractCellText(rawEmail).trim() : null;

  // Check if this is a DM contact
  const isDM =
    looksLikeDM(emailText) || (!parsedRow.email && parsedRow.instagramHandle);

  if (isDM) {
    const dmNote = "Contact is through DM.";

    // Add DM note to notes field
    if (!parsedRow.notes) {
      parsedRow.notes = dmNote;
    } else if (!parsedRow.notes.includes(dmNote)) {
      parsedRow.notes = `${parsedRow.notes}\n${dmNote}`;
    }
  }

  return parsedRow;
}

/**
 * Check if a row has any data (not empty)
 */
function hasRowData(values: any[]): boolean {
  if (!Array.isArray(values)) return false;

  // Check columns 1, 2, 3 (A, B, C) for meaningful data
  for (let i = 1; i <= 3; i++) {
    const value = values[i];

    // Skip if null, undefined, or empty string
    if (value === null || value === undefined || value === "") {
      continue;
    }

    // Extract and clean text
    const text = extractCellText(value).trim();

    // Skip common placeholder/empty patterns (INCLUDING HEADER VALUES)
    if (
      text === "" ||
      text === "Nickname" ||
      text === "Link" ||
      text === "E-mail" ||
      text === "No Email" ||
      text.toLowerCase() === "e-mail" ||
      text.toLowerCase().includes("placeholder") ||
      text === "-" ||
      text === "—" ||
      text === "n/a" ||
      text === "N/A"
    ) {
      continue;
    }

    // If we found any meaningful text, return true
    if (text !== "") {
      console.log(`🔍 Found meaningful data in column ${i}: "${text}"`);
      return true;
    }
  }

  console.log(`🔍 No meaningful data found in row`);
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

// Process large files with optimized settings
async function processLargeImport(job: Job<ImportJobData>) {
  const BATCH_SIZE = 1000;
  const STATUS_INTERVAL = 1000;

  // Validate job data
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
    // Download from GCS if needed
    if (typeof rawFilePath === "string" && rawFilePath.startsWith("gs://")) {
      const result = await downloadFromGCS(rawFilePath);
      localFilePath = result.localPath;
      downloadedTemp = result.downloaded;
    } else {
      localFilePath = rawFilePath;
    }

    // Update job status
    await safeUpdateJobStatus(importJobId, { status: "PROCESSING" });

    let processed = 0;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];
    const duplicates: any[] = [];

    // ✅ NEW: Variable to store country from Row 1
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

    // Use streaming reader for memory efficiency
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
        // Check for duplicates in current batch (NAME BASED ONLY)
        const duplicateMap = await checkBatchDuplicates(buffer, managerId);
        const uniqueRows = buffer.filter((row) => {
          const key = row.name ? row.name.toLowerCase().trim() : "unknown";
          return !duplicateMap.has(key);
        });

        // Add duplicates to tracking
        buffer.forEach((row) => {
          const key = row.name ? row.name.toLowerCase().trim() : "unknown";
          if (duplicateMap.has(key)) {
            duplicates.push({
              name: row.name,
              instagramHandle: row.instagramHandle,
              email: row.email,
              error: "Duplicate influencer (same name)",
            });
          }
        });

        if (uniqueRows.length > 0) {
          try {
            const result = await prisma.influencer.createMany({
              data: uniqueRows.map((row) => mappedToCreateMany(row, managerId)),
              skipDuplicates: false, // We already did duplicate checking
            });
            success += result.count;
            console.log(
              `✅ Batch insert successful: ${result.count} influencers created`
            );
          } catch (error) {
            console.error("❌ Batch insert failed:", error);
            // If batch insert fails, try individual inserts
            for (const row of uniqueRows) {
              try {
                await prisma.influencer.create({
                  data: mappedToCreateMany(row, managerId),
                });
                success++;
              } catch (individualError) {
                failed++;
                errors.push({
                  row: `individual_${processed}`,
                  error:
                    individualError instanceof Error
                      ? individualError.message
                      : "Individual insert failed",
                  data: row,
                });
              }
            }
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

        // ✅ NEW: Check first row for country
        if (isFirstRow) {
          isFirstRow = false;

          // Try to extract country from Row 1, Column A
          const detectedCountry = extractCountryFromFirstRow(values);
          if (detectedCountry) {
            batchCountry = detectedCountry;
            console.log(
              `🌍 Country detected for entire batch: "${batchCountry}"`
            );
          }

          continue; // Skip row 1 (either header or country)
        }

        // Skip empty rows
        if (!hasRowData(values)) {
          continue;
        }

        processed++;

        try {
          // DIRECT MANUAL MAPPING for large files
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

          const instagramUsername = link
            ? extractInstagramUsername(link)
            : null;

          const parsedRow: ParsedRow = {
            name,
            email,
            instagramHandle: link,
            link,
            followers: null,
            country: batchCountry, // ✅ NEW: Apply country from Row 1
            notes: null,
          };

          // Process DM markers and add notes
          const rowWithDMNotes = processDMNotes(parsedRow, rawEmail);

          const normalized = normalizeParsedRow(rowWithDMNotes);

          console.log(`✅ Processed row ${processed}:`, {
            name: normalized.name,
            email: normalized.email,
            instagramHandle: normalized.instagramHandle,
            instagramUsername,
            country: normalized.country, // ✅ NEW: Log country
            notes: normalized.notes,
          });

          // VALIDATION: Only require name
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

          // Flush when batch size reached
          if (buffer.length >= BATCH_SIZE) {
            await flushBuffer();
          }

          // Emit progress periodically
          if (processed % STATUS_INTERVAL === 0) {
            await emitProgress();

            // Check for cancellation
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
      break; // Only process first worksheet
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      await flushBuffer();
    }

    // Final progress update
    await emitProgress();

    // Update job completion
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

    // Final completion emit
    await publishImportProgress(importJobId, {
      managerId,
      jobId: importJobId,
      processed,
      success,
      failed: failed + duplicates.length,
      duplicatesCount: duplicates.length,
      done: true,
    });

    // ✅ NEW: Log country summary
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

    // Update job as failed
    await safeUpdateJobStatus(importJobId, {
      status: "FAILED",
      errors: [
        { error: error instanceof Error ? error.message : "Processing failed" },
      ] as any,
      completedAt: new Date(),
    });

    throw error;
  } finally {
    // Cleanup temporary file
    if (downloadedTemp && localFilePath) {
      try {
        await fs.promises.unlink(localFilePath);
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp file:", cleanupError);
      }
    }
  }
}

// Standard import process for smaller files - DIRECT MANUAL MAPPING
async function processStandardImport(job: Job<ImportJobData>) {
  // Use smaller batch size for standard imports
  const BATCH_SIZE = 100;

  // Validate job data
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
    // Download from GCS if needed
    if (typeof rawFilePath === "string" && rawFilePath.startsWith("gs://")) {
      const result = await downloadFromGCS(rawFilePath);
      localFilePath = result.localPath;
      downloadedTemp = result.downloaded;
    } else {
      localFilePath = rawFilePath;
    }

    // Update job status
    await safeUpdateJobStatus(importJobId, { status: "PROCESSING" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(localFilePath);

    const worksheet = workbook.worksheets[0];
    const rows: any[] = [];

    // ✅ NEW: Variable to store country from Row 1
    let batchCountry: string | null = null;

    console.log("🔍 DEBUG: Reading Excel file structure");
    console.log("Worksheet name:", worksheet.name);
    console.log("Total rows:", worksheet.rowCount);
    console.log("Total columns:", worksheet.columnCount);

    // ✅ NEW: Check Row 1 for country BEFORE processing data rows
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

    // Get rows excluding empty ones and header
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      debugRowData(rowNumber, row.values as any[]);

      if (rowNumber > 1) {
        // Skip row 1 (header or country)
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

    // Process each row with DIRECT MANUAL MAPPING
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

        const instagramUsername = link ? extractInstagramUsername(link) : null;

        const parsedRow: ParsedRow = {
          name,
          email,
          instagramHandle: link,
          link,
          followers: null,
          country: batchCountry, // ✅ NEW: Apply country from Row 1
          notes: null,
        };

        // Process DM markers and add notes
        const rowWithDMNotes = processDMNotes(parsedRow, rawEmail);

        console.log(`✅ Parsed row ${i}:`, rowWithDMNotes);
        console.log(`📱 Extracted Instagram username:`, instagramUsername);

        const normalized = normalizeParsedRow(rowWithDMNotes);

        console.log(`✅ Normalized row ${i}:`, {
          finalName: normalized.name,
          finalEmail: normalized.email,
          finalHandle: normalized.instagramHandle,
          finalLink: normalized.link,
          finalCountry: normalized.country, // ✅ NEW: Log country
          finalNotes: normalized.notes,
          instagramUsername,
        });

        // VALIDATION: Only require name
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

    // Check for duplicates (NAME BASED ONLY)
    if (validRows.length > 0) {
      const duplicateMap = await checkBatchDuplicates(validRows, managerId);
      const uniqueRows = validRows.filter((row) => {
        const key = row.name ? row.name.toLowerCase().trim() : "unknown";
        return !duplicateMap.has(key);
      });

      // Add duplicates to tracking
      validRows.forEach((row) => {
        const key = row.name ? row.name.toLowerCase().trim() : "unknown";
        if (duplicateMap.has(key)) {
          duplicates.push({
            name: row.name,
            instagramHandle: row.instagramHandle,
            email: row.email,
            error: "Duplicate influencer (same name)",
          });
        }
      });

      // Insert unique rows
      if (uniqueRows.length > 0) {
        try {
          const result = await prisma.influencer.createMany({
            data: uniqueRows.map((row) => mappedToCreateMany(row, managerId)),
            skipDuplicates: false,
          });
          success += result.count;
          console.log(
            `✅ Batch insert successful: ${result.count} influencers created`
          );
        } catch (error) {
          console.error("❌ Batch insert failed:", error);
          // If batch insert fails, try individual inserts
          for (const row of uniqueRows) {
            try {
              await prisma.influencer.create({
                data: mappedToCreateMany(row, managerId),
              });
              success++;
            } catch (individualError) {
              failed++;
              errors.push({
                row: "individual_insert",
                error:
                  individualError instanceof Error
                    ? individualError.message
                    : "Individual insert failed",
                data: row,
              });
            }
          }
        }
      }

      failed += validRows.length - uniqueRows.length;
    }

    // Emit progress
    await publishImportProgress(importJobId, {
      managerId,
      jobId: importJobId,
      processed,
      success,
      failed,
      duplicatesCount: duplicates.length,
      estimatedTotal: rows.length,
    });

    // Check for cancellation
    if (await isJobCancelled(importJobId)) {
      throw new Error("Import cancelled by user");
    }

    // Update job completion
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

    // ✅ NEW: Log country summary
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
    // Cleanup temporary file
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

      // Enhanced job filtering
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

      // Validate this is a real import job
      if (!job.data || typeof job.data !== "object") {
        throw new Error("Invalid job data - cannot process import");
      }

      const { importJobId, managerId, filePath } = job.data;

      // Check for required fields for real import jobs
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
      concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 1),
    }
  );

  worker.on("failed", (job, err) => {
    // ⚠️ CRITICAL FIX: Skip scheduler jobs in error handling too
    if (job?.name === "__scheduler-noop" || job?.data?.__noop === true) {
      console.log(
        `[optimized-import.worker] scheduler job failed (ignored)`,
        job?.id
      );
      return;
    }

    console.error("[optimized-import.worker] job failed", job?.id, err);

    // Only update if we have a valid importJobId
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
    // ⚠️ CRITICAL FIX: Skip scheduler jobs in completion handling
    if (job?.name === "__scheduler-noop" || job?.data?.__noop === true) {
      return;
    }

    console.log(`[optimized-import.worker] job ${job.id} completed:`, {
      processed: result.processed,
      success: result.success,
      failed: result.failed,
      duplicates: result.duplicates.length,
    });
  });

  worker.on("error", (err) => {
    console.error("[optimized-import.worker] worker error:", err);
  });

  console.log("[optimized-import.worker] started with optimized file support");
  return worker;
};
