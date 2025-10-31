import { Request, Response } from "express";
import { ExcelImportService } from "../services/excelImport.service";
import path from "path";

export class ImportController {
  static async importInfluencers(req: Request, res: Response) {
    try {
      // Option 1: Use fixed file path (place your Excel in backend root)
      const filePath = path.join(process.cwd(), "Melik.xlsx");

      // Option 2: If you want file upload functionality
      // const file = req.file;
      // if (!file) {
      //   return res.status(400).json({ error: 'No file uploaded' });
      // }
      // const filePath = file.path;

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath
      );

      res.json({
        message: "Import completed",
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
}
