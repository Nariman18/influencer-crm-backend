import { PrismaClient, InfluencerStatus } from "@prisma/client";
import * as XLSX from "xlsx";
import { join } from "path";
import { cwd } from "process";

const prisma = new PrismaClient();

interface ExcelRow {
  A: string; // nickname
  B: string; // link
  C: string; // email
  D: string; // Melik (ignored)
}

async function importExcelData() {
  try {
    const filePath = join(cwd(), "Melik.xlsx");
    console.log("Reading Excel file from:", filePath);

    const workbook = XLSX.readFile(filePath);
    const pingSheet = workbook.Sheets["Ping"];

    if (!pingSheet) {
      throw new Error("Ping sheet not found");
    }

    // Convert to JSON with proper typing
    const jsonData: ExcelRow[] = XLSX.utils.sheet_to_json(pingSheet, {
      header: ["A", "B", "C", "D"],
    });

    console.log(`Found ${jsonData.length} rows in Excel`);

    // Skip header rows (first 2 rows)
    const dataRows = jsonData.slice(2);
    console.log(`Processing ${dataRows.length} data rows`);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      try {
        if (!row.A || !row.B) {
          console.log(`Skipping row ${i} - missing nickname or link`);
          continue;
        }

        const nickname = String(row.A).trim();
        const link = String(row.B).trim();
        const rawEmail = String(row.C || "").trim();

        // Process email and notes
        const { email, notes } = processEmailAndNotes(rawEmail);

        // Check if influencer exists first
        const existingInfluencer = await prisma.influencer.findFirst({
          where: {
            OR: [{ instagramHandle: link }, { nickname }, { link }],
          },
        });

        if (existingInfluencer) {
          // Update existing influencer
          await prisma.influencer.update({
            where: { id: existingInfluencer.id },
            data: {
              name: nickname, // Use nickname as Name
              nickname,
              link,
              email, // Only valid emails (or null)
              instagramHandle: link, // Use the FULL Instagram URL here
              notes: combineNotes(existingInfluencer.notes, notes), // DM, phones, etc.
              updatedAt: new Date(),
            },
          });
          console.log(
            `✓ Updated: ${nickname} | Email: ${email || "No email"} | Notes: ${
              notes || "No notes"
            }`
          );
        } else {
          // Create new influencer
          await prisma.influencer.create({
            data: {
              name: nickname, // Use nickname as Name
              nickname,
              email, // Only valid emails (or null)
              instagramHandle: link, // Use the FULL Instagram URL here
              link,
              notes, // DM, phones, other contact info
              status: InfluencerStatus.PING_1,
            },
          });
          console.log(
            `✓ Created: ${nickname} | Email: ${email || "No email"} | Notes: ${
              notes || "No notes"
            }`
          );
        }

        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`✗ Error importing row ${i} (${row.A}):`, error);
      }
    }

    console.log("\n=== Import Summary ===");
    console.log(`Successful: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total processed: ${dataRows.length}`);
  } catch (error) {
    console.error("Import failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

function processEmailAndNotes(rawEmail: string): {
  email: string | null;
  notes: string | null;
} {
  const trimmedEmail = rawEmail.trim();

  // If empty or DM, put in notes
  if (!trimmedEmail || trimmedEmail.toLowerCase() === "dm") {
    return {
      email: null,
      notes: "Contact via Instagram DM",
    };
  }

  // If it's a phone number (starts with = or +), add to notes
  if (trimmedEmail.startsWith("=") || trimmedEmail.startsWith("+")) {
    const cleanPhone = trimmedEmail.replace(/^=+/, "").trim();
    return {
      email: null,
      notes: `Phone: ${cleanPhone}`,
    };
  }

  // If it looks like a valid email, use it as email
  if (isValidEmail(trimmedEmail)) {
    return {
      email: trimmedEmail,
      notes: null,
    };
  }

  // For any other case that's not a valid email, put in notes
  return {
    email: null,
    notes: `Contact info: ${trimmedEmail}`,
  };
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function combineNotes(
  existingNotes: string | null,
  newNotes: string | null
): string | null {
  if (!newNotes) return existingNotes;
  if (!existingNotes) return newNotes;

  // Combine notes, avoiding duplicates
  const existingLines = existingNotes.split("\n").map((line) => line.trim());
  const newLines = newNotes.split("\n").map((line) => line.trim());

  const combinedLines = [...existingLines];
  for (const line of newLines) {
    if (!combinedLines.includes(line)) {
      combinedLines.push(line);
    }
  }

  return combinedLines.join("\n");
}

// Run the import
importExcelData();
