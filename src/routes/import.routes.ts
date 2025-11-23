// src/routes/import.routes.ts
import { Router } from "express";
import { OptimizedImportController } from "../controllers/import.controller";
import { authenticate } from "../middleware/auth";

const router = Router();

// Register route-level auth explicitly so we guarantee ordering:
// authenticate -> upload.single (multer) -> handler
router.post(
  "/influencers",
  authenticate,
  OptimizedImportController.importInfluencers
);
router.get(
  "/:jobId/status",
  authenticate,
  OptimizedImportController.getImportStatus
);
router.delete(
  "/:jobId",
  authenticate,
  OptimizedImportController.cancelImportJob
);

export default router;
