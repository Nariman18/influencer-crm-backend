const { PrismaClient, InfluencerStatus } = require("@prisma/client");
const XLSX = require("xlsx");
const path = require("path");

const prisma = new PrismaClient();

class ExcelImportService {
  static async importInfluencersFromExcel(
    filePath,
    managerId,
    sheetName = "Ping"
  ) {
    try {
      console.log(`📖 Reading Excel file: ${filePath}`);
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[sheetName];

      if (!sheet) {
        throw new Error(`${sheetName} sheet not found in Excel file`);
      }

      const jsonData = XLSX.utils.sheet_to_json(sheet, {
        header: ["A", "B", "C", "D"],
      });

      console.log(`📊 Found ${jsonData.length} rows in Excel`);

      const influencers = [];
      const errors = [];

      // Skip header rows (first 2 rows)
      for (let i = 2; i < jsonData.length; i++) {
        const row = jsonData[i];
        try {
          if (!row.A || !row.B) continue;

          const influencer = this.processRow(row, managerId);
          if (influencer) {
            influencers.push(influencer);
          }
        } catch (error) {
          errors.push(`Row ${i}: ${error.message}`);
        }
      }

      console.log(`🔄 Processing ${influencers.length} influencers...`);

      let successCount = 0;
      for (const influencer of influencers) {
        try {
          await this.upsertInfluencer(influencer);
          successCount++;
        } catch (error) {
          errors.push(`Failed to import ${influencer.name}: ${error.message}`);
        }
      }

      return { success: successCount, errors };
    } catch (error) {
      throw new Error(`Excel import failed: ${error.message}`);
    }
  }

  static async upsertInfluencer(influencer) {
    const existingInfluencer = await prisma.influencer.findFirst({
      where: {
        OR: [
          { instagramHandle: influencer.instagramHandle },
          { name: influencer.name },
          { link: influencer.link },
        ],
      },
    });

    if (existingInfluencer) {
      const updateData = {
        name: influencer.name,
        link: influencer.link || null,
        instagramHandle: influencer.instagramHandle || null,
        notes: this.combineNotes(
          existingInfluencer.notes,
          influencer.notes || null
        ),
        updatedAt: new Date(),
        status: influencer.status,
      };

      if (influencer.email !== undefined) updateData.email = influencer.email;
      if (influencer.managerId !== undefined)
        updateData.managerId = influencer.managerId;

      return await prisma.influencer.update({
        where: { id: existingInfluencer.id },
        data: updateData,
      });
    } else {
      const createData = {
        name: influencer.name,
        link: influencer.link || null,
        instagramHandle: influencer.instagramHandle || null,
        status: influencer.status,
      };

      if (influencer.email !== undefined) createData.email = influencer.email;
      if (influencer.notes !== undefined) createData.notes = influencer.notes;
      if (influencer.managerId !== undefined)
        createData.managerId = influencer.managerId;

      return await prisma.influencer.create({
        data: createData,
      });
    }
  }

  static processRow(row, managerId) {
    const name = String(row.A || "").trim();
    const link = String(row.B || "").trim();
    const rawEmail = String(row.C || "").trim();

    if (!name || !link) {
      return null;
    }

    const { email, notes } = this.processEmailAndNotes(rawEmail);
    const instagramHandle = this.extractInstagramHandle(link);

    return {
      name,
      email: email || null,
      instagramHandle,
      link,
      notes: notes || null,
      managerId: managerId || null,
      status: InfluencerStatus.NOT_SENT,
    };
  }

  static extractInstagramHandle(link) {
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

  static processEmailAndNotes(rawEmail) {
    const trimmedEmail = rawEmail.trim();

    if (!trimmedEmail) {
      return { email: undefined, notes: undefined };
    }

    if (!trimmedEmail || trimmedEmail.toLowerCase() === "dm") {
      return { email: undefined, notes: "Contact via Instagram DM" };
    }

    if (trimmedEmail.startsWith("=") || trimmedEmail.startsWith("+")) {
      const cleanPhone = trimmedEmail.replace(/^=+/, "").trim();
      return { email: undefined, notes: `Phone: ${cleanPhone}` };
    }

    if (this.isValidEmail(trimmedEmail)) {
      return { email: trimmedEmail, notes: undefined };
    }

    return { email: undefined, notes: `Contact info: ${trimmedEmail}` };
  }

  static isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static combineNotes(existingNotes, newNotes) {
    if (!newNotes) return existingNotes;
    if (!existingNotes) return newNotes;

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
}

async function importMultipleFiles() {
  const managerFiles = [
    // {
    //   filename: "Melik.xlsx",
    //   sheetName: "Ping",
    //   managerEmail: "melik@gmail.com",
    // },
    // {
    //   filename: "Cavidan.xlsx",
    //   sheetName: "Ping",
    //   managerEmail: "cavidan1999@gmail.com",
    // },
    // {
    //   filename: "Alik.xlsx",
    //   sheetName: "Ping",
    //   managerEmail: "alik@gmail.com",
    // },
    // {
    //   filename: "Nariman.xlsx",
    //   sheetName: "Ping",
    //   managerEmail: "nariman18@gmail.com",
    // },
    {
      filename: "Rostyslav.xlsx",
      sheetName: "Ping",
      managerEmail: "sofiaaatig@gmail.com",
    },
  ];

  console.log("Starting batch import with manager assignment...\n");

  for (const fileConfig of managerFiles) {
    try {
      const filePath = path.join(process.cwd(), fileConfig.filename);

      console.log(`Looking for file: ${fileConfig.filename}`);

      // Check if file exists
      const fs = require("fs");
      if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${fileConfig.filename}`);
        console.log(
          `   Please make sure the file exists in the backend root folder`
        );
        continue;
      }

      console.log(`Finding manager: ${fileConfig.managerEmail}`);
      const manager = await prisma.user.findUnique({
        where: { email: fileConfig.managerEmail },
      });

      if (!manager) {
        console.log(`Manager not found: ${fileConfig.managerEmail}`);
        console.log(
          `   Please create a manager account with email: ${fileConfig.managerEmail}`
        );
        continue;
      }

      console.log(
        `📁 Importing from: ${fileConfig.filename} for manager: ${manager.name}`
      );

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath,
        manager.id,
        fileConfig.sheetName
      );

      console.log(
        `Success: ${result.success}, Errors: ${result.errors.length}`
      );

      if (result.errors.length > 0) {
        console.log("First few errors:", result.errors.slice(0, 3));
        if (result.errors.length > 3) {
          console.log(`... and ${result.errors.length - 3} more errors`);
        }
      }
      console.log("---");
    } catch (error) {
      console.error(`Failed to import ${fileConfig.filename}:`, error);
    }
  }

  console.log("🎉 Batch import completed!");
  await prisma.$disconnect();
}

// Run the batch import
importMultipleFiles().catch(console.error);
