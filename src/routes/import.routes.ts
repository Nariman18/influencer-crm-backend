import { Router } from "express";
import ImportController from "../controllers/import.controller";
const router = Router();
router.post("/influencers", ImportController.importInfluencers);
router.post("/influencers/batch", ImportController.importMultipleFiles);
router.get("/:jobId/status", ImportController.getImportStatus);
router.delete("/:jobId", ImportController.cancelImportJob);
export default router;
