// src/routes/export.routes.ts
import { Router } from "express";
import ExportController from "../controllers/export.controller";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/", authenticate, ExportController.createExport);
router.get("/:jobId/status", authenticate, ExportController.getExportStatus);
router.get("/:jobId/download", authenticate, ExportController.downloadExport);

export default router;
