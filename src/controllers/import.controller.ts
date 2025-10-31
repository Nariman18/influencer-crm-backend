import { Request, Response } from "express";
import { ExcelImportService } from "../services/excelImport.service";
import path from "path";

export class ImportController {
  static async importInfluencers(req: Request, res: Response) {
    try {
      const { filename = "Melik.xlsx", sheetName = "Ping" } = req.body;

      // Use fixed file path (place your Excel files in backend root)
      const filePath = path.join(process.cwd(), filename);

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath,
        sheetName
      );

      res.json({
        message: "Import completed",
        file: filename,
        sheet: sheetName,
        imported: result.success,
        errors: result.errors,
        totalProcessed: result.success + result.errors.length,
      });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({
        error: "Import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  static async importMultipleFiles(req: Request, res: Response) {
    try {
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
            sheetName
          );

          results.push({
            file: filename,
            sheet: sheetName,
            success: result.success,
            errors: result.errors,
            totalProcessed: result.success + result.errors.length,
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
}
