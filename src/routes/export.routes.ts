// src/routes/export.routes.ts
import { Router } from "express";
import ExportController from "../controllers/export.controller";
const router = Router();
router.post("/", ExportController.createExport);
router.get("/:jobId/status", ExportController.getExportStatus);
router.get("/:jobId/download", ExportController.downloadExport);
export default router;
