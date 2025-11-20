// src/routes/import.routes.ts
import { Router } from "express";
import ImportController from "../controllers/import.controller";
import { authenticate } from "../middleware/auth";

const router = Router();

// Register route-level auth explicitly so we guarantee ordering:
// authenticate -> upload.single (multer) -> handler
router.post(
  "/influencers",
  authenticate,
  ...ImportController.importInfluencers
);

router.post(
  "/influencers/batch",
  authenticate,
  ...ImportController.importInfluencers
);

router.get("/:jobId/status", authenticate, ImportController.getImportStatus);
router.delete("/:jobId", authenticate, ImportController.cancelImportJob);

export default router;
