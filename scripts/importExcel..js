const { PrismaClient, InfluencerStatus } = require("@prisma/client");
const XLSX = require("xlsx");
const path = require("path");

const prisma = new PrismaClient();

async function importExcelData() {
  try {
    const filePath = path.join(process.cwd(), "Melik.xlsx");
    console.log("Reading Excel file from:", filePath);

    const workbook = XLSX.readFile(filePath);
    const pingSheet = workbook.Sheets["Ping"];

    if (!pingSheet) {
      throw new Error("Ping sheet not found");
    }

    const jsonData = XLSX.utils.sheet_to_json(pingSheet, {
      header: ["A", "B", "C", "D"],
    });

    console.log(`Found ${jsonData.length} rows in Excel`);

    // Find manager by email or name
    const managerEmail = "melik@example.com"; // Change to actual manager email
    const manager = await prisma.user.findUnique({
      where: { email: managerEmail },
    });

    if (!manager) {
      throw new Error(`Manager with email ${managerEmail} not found`);
    }

    const dataRows = jsonData.slice(2);
    console.log(
      `Processing ${dataRows.length} data rows for manager: ${manager.name}`
    );

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

        const { email, notes } = processEmailAndNotes(rawEmail);
        const instagramHandle = extractInstagramHandle(link);

        const existingInfluencer = await prisma.influencer.findFirst({
          where: {
            OR: [{ instagramHandle }, { link }, { name: nickname }],
          },
        });

        if (existingInfluencer) {
          await prisma.influencer.update({
            where: { id: existingInfluencer.id },
            data: {
              name: nickname,
              link,
              email,
              instagramHandle,
              notes: combineNotes(existingInfluencer.notes, notes),
              managerId: manager.id, // Assign to manager
              updatedAt: new Date(),
            },
          });
          console.log(`✓ Updated for ${manager.name}: ${nickname}`);
        } else {
          await prisma.influencer.create({
            data: {
              name: nickname,
              email,
              instagramHandle,
              link,
              notes,
              status: InfluencerStatus.PING_1,
              managerId: manager.id, // Assign to manager
            },
          });
          console.log(`✓ Created for ${manager.name}: ${nickname}`);
        }

        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`✗ Error importing row ${i} (${row.A}):`, error);
      }
    }

    console.log("\n=== Import Summary ===");
    console.log(`Manager: ${manager.name}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total processed: ${dataRows.length}`);
  } catch (error) {
    console.error("Import failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Helper functions
function extractInstagramHandle(link) {
  try {
    const url = new URL(link);
    const pathParts = url.pathname
      .split("/")
      .filter((part) => part.trim() !== "");
    if (pathParts.length > 0) return pathParts[0];
    return link;
  } catch (error) {
    const match = link.match(/(?:instagram\.com\/|@)([a-zA-Z0-9._]+)/);
    return match && match[1] ? match[1] : link;
  }
}

function processEmailAndNotes(rawEmail) {
  const trimmedEmail = rawEmail.trim();
  if (!trimmedEmail || trimmedEmail.toLowerCase() === "dm") {
    return { email: null, notes: "Contact via Instagram DM" };
  }
  if (trimmedEmail.startsWith("=") || trimmedEmail.startsWith("+")) {
    const cleanPhone = trimmedEmail.replace(/^=+/, "").trim();
    return { email: null, notes: `Phone: ${cleanPhone}` };
  }
  if (isValidEmail(trimmedEmail)) {
    return { email: trimmedEmail, notes: null };
  }
  return { email: null, notes: `Contact info: ${trimmedEmail}` };
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function combineNotes(existingNotes, newNotes) {
  if (!newNotes) return existingNotes;
  if (!existingNotes) return newNotes;
  const existingLines = existingNotes.split("\n").map((line) => line.trim());
  const newLines = newNotes.split("\n").map((line) => line.trim());
  const combinedLines = [...existingLines];
  for (const line of newLines) {
    if (!combinedLines.includes(line)) combinedLines.push(line);
  }
  return combinedLines.join("\n");
}

importExcelData();
