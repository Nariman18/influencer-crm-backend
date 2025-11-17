"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExcelImportService = void 0;
const XLSX = __importStar(require("xlsx"));
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class ExcelImportService {
    static async importInfluencersFromExcel(filePath, managerId, sheetName = "Ping") {
        try {
            const workbook = XLSX.readFile(filePath);
            const sheet = workbook.Sheets[sheetName];
            if (!sheet) {
                throw new Error(`${sheetName} sheet not found in Excel file`);
            }
            const jsonData = XLSX.utils.sheet_to_json(sheet, {
                header: ["A", "B", "C", "D"],
            });
            const influencers = [];
            const errors = [];
            for (let i = 2; i < jsonData.length; i++) {
                const row = jsonData[i];
                try {
                    if (!row.A || !row.B)
                        continue;
                    const influencer = this.processRow(row, managerId);
                    if (influencer) {
                        influencers.push(influencer);
                    }
                }
                catch (error) {
                    errors.push(`Row ${i}: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }
            let successCount = 0;
            for (const influencer of influencers) {
                try {
                    await this.upsertInfluencer(influencer);
                    successCount++;
                }
                catch (error) {
                    errors.push(`Failed to import ${influencer.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }
            return { success: successCount, errors };
        }
        catch (error) {
            throw new Error(`Excel import failed: ${error instanceof Error ? error.message : "Unknown error"}`);
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
        const cleanData = {
            name: influencer.name,
            status: influencer.status,
            email: influencer.email ?? null,
            instagramHandle: influencer.instagramHandle ?? null,
            link: influencer.link ?? null,
            notes: this.combineNotes(existingInfluencer?.notes || null, influencer.notes ?? null),
            managerId: influencer.managerId ?? null,
            updatedAt: new Date(),
        };
        if (existingInfluencer) {
            return await prisma.influencer.update({
                where: { id: existingInfluencer.id },
                data: cleanData,
            });
        }
        else {
            return await prisma.influencer.create({
                data: cleanData,
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
            email: email ?? null,
            instagramHandle,
            link,
            notes: notes ?? null,
            managerId: managerId ?? null,
            // Imported from Excel should default to NOT_SENT; manual sends will set PING_1
            status: client_1.InfluencerStatus.NOT_SENT,
        };
    }
    static extractInstagramHandle(link) {
        try {
            const url = new URL(link);
            const pathParts = url.pathname
                .split("/")
                .filter((part) => part.trim() !== "");
            if (pathParts.length > 0) {
                return pathParts[0];
            }
            return link;
        }
        catch (error) {
            const match = link.match(/(?:instagram\.com\/|@)([a-zA-Z0-9._]+)/);
            if (match && match[1]) {
                return match[1];
            }
            return link;
        }
    }
    static processEmailAndNotes(rawEmail) {
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
    static isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    static combineNotes(existingNotes, newNotes) {
        if (!newNotes)
            return existingNotes;
        if (!existingNotes)
            return newNotes;
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
exports.ExcelImportService = ExcelImportService;
