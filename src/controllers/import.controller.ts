import { Request, Response } from "express";
import { ExcelImportService } from "../services/excelImport.service";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Extend Express Request to include user
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export class ImportController {
  static async importInfluencers(req: AuthenticatedRequest, res: Response) {
    try {
      // Get manager ID from authenticated user
      const managerId = req.user?.id;

      if (!managerId) {
        return res.status(401).json({
          error: "Authentication required",
        });
      }

      const { filename = "Melik.xlsx", sheetName = "Ping" } = req.body;

      const filePath = path.join(process.cwd(), filename);

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath,
        managerId, // Pass manager ID
        sheetName
      );

      res.json({
        message: "Import completed",
        file: filename,
        sheet: sheetName,
        imported: result.success,
        errors: result.errors,
        totalProcessed: result.success + result.errors.length,
        managerId: managerId,
      });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({
        error: "Import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  static async importMultipleFiles(req: AuthenticatedRequest, res: Response) {
    try {
      const managerId = req.user?.id;

      if (!managerId) {
        return res.status(401).json({
          error: "Authentication required",
        });
      }

      const { files } = req.body;

      if (!files || !Array.isArray(files)) {
        return res.status(400).json({
          error: "Files array is required",
        });
      }

      const results = [];

      for (const fileConfig of files) {
        const { filename, sheetName = "Ping" } = fileConfig;

        if (!filename) {
          results.push({
            file: filename,
            error: "Filename is required",
          });
          continue;
        }

        try {
          const filePath = path.join(process.cwd(), filename);
          const result = await ExcelImportService.importInfluencersFromExcel(
            filePath,
            managerId, // Pass manager ID
            sheetName
          );

          results.push({
            file: filename,
            sheet: sheetName,
            success: result.success,
            errors: result.errors,
            totalProcessed: result.success + result.errors.length,
            managerId: managerId,
          });
        } catch (error) {
          results.push({
            file: filename,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      res.json({
        message: "Batch import completed",
        managerId: managerId,
        results,
      });
    } catch (error) {
      console.error("Batch import error:", error);
      res.status(500).json({
        error: "Batch import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // New endpoint for manager to import their specific file
  static async importManagerFile(req: AuthenticatedRequest, res: Response) {
    try {
      const managerId = req.user?.id;

      if (!managerId) {
        return res.status(401).json({
          error: "Authentication required",
        });
      }

      const { filename, sheetName = "Ping" } = req.body;

      if (!filename) {
        return res.status(400).json({
          error: "Filename is required",
        });
      }

      // Validate that filename matches manager's pattern
      const manager = await prisma.user.findUnique({
        where: { id: managerId },
        select: { name: true, email: true },
      });

      if (!manager) {
        return res.status(404).json({
          error: "Manager not found",
        });
      }

      const filePath = path.join(process.cwd(), filename);

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath,
        managerId,
        sheetName
      );

      res.json({
        message: "Manager import completed",
        manager: {
          id: managerId,
          name: manager.name,
          email: manager.email,
        },
        file: filename,
        imported: result.success,
        errors: result.errors,
      });
    } catch (error) {
      console.error("Manager import error:", error);
      res.status(500).json({
        error: "Import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
