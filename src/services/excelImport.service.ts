import * as XLSX from "xlsx";
import { PrismaClient, InfluencerStatus } from "@prisma/client";
import { join } from "path";
import { cwd } from "process";

const prisma = new PrismaClient();

interface ProcessedInfluencer {
  name: string; // Nickname from Excel
  nickname?: string; // Original nickname from Excel
  email?: string; // Only valid email addresses
  instagramHandle?: string; // FULL Instagram URL
  link?: string; // Full Instagram URL
  notes?: string; // DM info, phone numbers, other contact info
  status: InfluencerStatus;
}

export class ExcelImportService {
  static async importInfluencersFromExcel(
    filePath: string,
    sheetName: string = "Ping"
  ): Promise<{ success: number; errors: string[] }> {
    try {
      // Read Excel file
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[sheetName];

      if (!sheet) {
        throw new Error(`${sheetName} sheet not found in Excel file`);
      }

      // Convert sheet to JSON
      const jsonData: any[] = XLSX.utils.sheet_to_json(sheet, {
        header: ["A", "B", "C", "D"],
      });

      // Process data - skip header rows
      const influencers: ProcessedInfluencer[] = [];
      const errors: string[] = [];

      for (let i = 2; i < jsonData.length; i++) {
        const row = jsonData[i];
        try {
          if (!row.A || !row.B) continue; // Skip rows without nickname or link

          const influencer = this.processRow(row);
          if (influencer) {
            influencers.push(influencer);
          }
        } catch (error) {
          errors.push(
            `Row ${i}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Import to database
      let successCount = 0;
      for (const influencer of influencers) {
        try {
          await this.upsertInfluencer(influencer);
          successCount++;
        } catch (error) {
          errors.push(
            `Failed to import ${influencer.name}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      return { success: successCount, errors };
    } catch (error) {
      throw new Error(
        `Excel import failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private static async upsertInfluencer(influencer: ProcessedInfluencer) {
    // Find existing influencer
    const existingInfluencer = await prisma.influencer.findFirst({
      where: {
        OR: [
          { instagramHandle: influencer.instagramHandle },
          { nickname: influencer.nickname },
          { link: influencer.link },
        ],
      },
    });

    if (existingInfluencer) {
      // Update existing influencer
      return await prisma.influencer.update({
        where: { id: existingInfluencer.id },
        data: {
          ...influencer,
          notes: this.combineNotes(existingInfluencer.notes, influencer.notes),
          updatedAt: new Date(),
        },
      });
    } else {
      // Create new influencer
      return await prisma.influencer.create({
        data: influencer,
      });
    }
  }

  private static processRow(row: any): ProcessedInfluencer | null {
    const nickname = String(row.A || "").trim();
    const link = String(row.B || "").trim();
    const rawEmail = String(row.C || "").trim();

    if (!nickname || !link) {
      return null;
    }

    // Process email and notes - this will separate emails vs other contact info
    const { email, notes } = this.processEmailAndNotes(rawEmail);

    return {
      name: nickname, // Use Excel nickname as the main Name field
      nickname, // Keep original nickname
      email, // Only valid email addresses (or undefined)
      instagramHandle: link, // Use the FULL Instagram URL here
      link, // Also keep the full URL in link field
      notes, // DM info, phone numbers, other contact info
      status: InfluencerStatus.PING_1,
    };
  }

  private static processEmailAndNotes(rawEmail: string): {
    email: string | undefined;
    notes: string | undefined;
  } {
    const trimmedEmail = rawEmail.trim();

    // If empty or DM, put in notes
    if (!trimmedEmail || trimmedEmail.toLowerCase() === "dm") {
      return {
        email: undefined,
        notes: "Contact via Instagram DM",
      };
    }

    // If it's a phone number (starts with = or +), add to notes
    if (trimmedEmail.startsWith("=") || trimmedEmail.startsWith("+")) {
      const cleanPhone = trimmedEmail.replace(/^=+/, "").trim();
      return {
        email: undefined,
        notes: `Phone: ${cleanPhone}`,
      };
    }

    // If it looks like a valid email, use it as email
    if (this.isValidEmail(trimmedEmail)) {
      return {
        email: trimmedEmail,
        notes: undefined,
      };
    }

    // For any other case that's not a valid email, put in notes
    return {
      email: undefined,
      notes: `Contact info: ${trimmedEmail}`,
    };
  }

  private static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private static combineNotes(
    existingNotes: string | null,
    newNotes: string | undefined
  ): string | undefined {
    if (!newNotes) return existingNotes || undefined;
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
