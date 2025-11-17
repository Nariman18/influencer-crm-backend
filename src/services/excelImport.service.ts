import * as XLSX from "xlsx";
import { PrismaClient, InfluencerStatus } from "@prisma/client";

const prisma = new PrismaClient();

interface ProcessedInfluencer {
  name: string;
  email?: string | null;
  instagramHandle?: string | null;
  link?: string | null;
  notes?: string | null;
  status: InfluencerStatus;
  managerId?: string | null;
}

interface ImportResult {
  success: number;
  errors: string[];
}

export class ExcelImportService {
  static async importInfluencersFromExcel(
    filePath: string,
    managerId?: string,
    sheetName: string = "Ping"
  ): Promise<ImportResult> {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[sheetName];

      if (!sheet) {
        throw new Error(`${sheetName} sheet not found in Excel file`);
      }

      const jsonData: any[] = XLSX.utils.sheet_to_json(sheet, {
        header: ["A", "B", "C", "D"],
      });

      const influencers: ProcessedInfluencer[] = [];
      const errors: string[] = [];

      for (let i = 2; i < jsonData.length; i++) {
        const row = jsonData[i];
        try {
          if (!row.A || !row.B) continue;

          const influencer = this.processRow(row, managerId);
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
    const existingInfluencer = await prisma.influencer.findFirst({
      where: {
        OR: [
          { instagramHandle: influencer.instagramHandle },
          { name: influencer.name },
          { link: influencer.link },
        ],
      },
    });

    const cleanData = {
      name: influencer.name,
      status: influencer.status,
      email: influencer.email ?? null,
      instagramHandle: influencer.instagramHandle ?? null,
      link: influencer.link ?? null,
      notes: this.combineNotes(
        existingInfluencer?.notes || null,
        influencer.notes ?? null
      ),
      managerId: influencer.managerId ?? null,
      updatedAt: new Date(),
    };

    if (existingInfluencer) {
      return await prisma.influencer.update({
        where: { id: existingInfluencer.id },
        data: cleanData,
      });
    } else {
      return await prisma.influencer.create({
        data: cleanData,
      });
    }
  }

  private static processRow(
    row: any,
    managerId?: string
  ): ProcessedInfluencer | null {
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
      email: email ?? null,
      instagramHandle,
      link,
      notes: notes ?? null,
      managerId: managerId ?? null,
      // Imported from Excel should default to NOT_SENT; manual sends will set PING_1
      status: InfluencerStatus.NOT_SENT,
    };
  }

  private static extractInstagramHandle(link: string): string {
    try {
      const url = new URL(link);
      const pathParts = url.pathname
        .split("/")
        .filter((part) => part.trim() !== "");

      if (pathParts.length > 0) {
        return pathParts[0];
      }
      return link;
    } catch (error) {
      const match = link.match(/(?:instagram\.com\/|@)([a-zA-Z0-9._]+)/);
      if (match && match[1]) {
        return match[1];
      }
      return link;
    }
  }

  private static processEmailAndNotes(rawEmail: string): {
    email: string | null;
    notes: string | null;
  } {
    const trimmedEmail = rawEmail.trim();

    if (!trimmedEmail || trimmedEmail.toLowerCase() === "dm") {
      return {
        email: null,
        notes: "Contact via Instagram DM",
      };
    }

    if (trimmedEmail.startsWith("=") || trimmedEmail.startsWith("+")) {
      const cleanPhone = trimmedEmail.replace(/^=+/, "").trim();
      return {
        email: null,
        notes: `Phone: ${cleanPhone}`,
      };
    }

    if (this.isValidEmail(trimmedEmail)) {
      return {
        email: trimmedEmail,
        notes: null,
      };
    }

    return {
      email: null,
      notes: `Contact info: ${trimmedEmail}`,
    };
  }

  private static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private static combineNotes(
    existingNotes: string | null,
    newNotes: string | null
  ): string | null {
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
