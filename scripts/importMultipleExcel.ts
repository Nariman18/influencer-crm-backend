import { ExcelImportService } from "../src/services/excelImport.service";
import { join } from "path";
import { cwd } from "process";

async function importMultipleFiles() {
  const files = [
    { filename: "Melik.xlsx", sheetName: "Ping" },
    { filename: "Cavidan.xlsx", sheetName: "Ping" },
    { filename: "Alik.xlsx", sheetName: "Ping" },
    { filename: "Nariman.xlsx", sheetName: "Ping" },
  ];

  console.log("Starting batch import...\n");

  for (const fileConfig of files) {
    try {
      const filePath = join(cwd(), fileConfig.filename);
      console.log(
        `📁 Importing from: ${fileConfig.filename} (Sheet: ${fileConfig.sheetName})`
      );

      const result = await ExcelImportService.importInfluencersFromExcel(
        filePath,
        fileConfig.sheetName
      );

      console.log(
        `✅ Success: ${result.success}, Errors: ${result.errors.length}`
      );

      if (result.errors.length > 0) {
        console.log("Errors:", result.errors);
      }
      console.log("---");
    } catch (error) {
      console.error(`❌ Failed to import ${fileConfig.filename}:`, error);
    }
  }

  console.log("🎉 Batch import completed!");
}

// Run the batch import
importMultipleFiles();
