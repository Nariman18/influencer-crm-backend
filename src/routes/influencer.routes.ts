import { Router } from "express";
import * as influencerController from "../controllers/influencer.controller";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";

const router = Router();

router.use(authenticate);

router.get("/", influencerController.getInfluencers);
router.get("/:id", influencerController.getInfluencer);
router.post(
  "/",
  auditLog("CREATE", "INFLUENCER"),
  influencerController.createInfluencer
);
router.put(
  "/:id",
  auditLog("UPDATE", "INFLUENCER"),
  influencerController.updateInfluencer
);
router.delete(
  "/:id",
  auditLog("DELETE", "INFLUENCER"),
  influencerController.deleteInfluencer
);
router.post(
  "/bulk-delete",
  auditLog("BULK_DELETE", "INFLUENCER"),
  influencerController.bulkDeleteInfluencers
);
router.post(
  "/bulk/update-status",
  auditLog("BULK_UPDATE", "INFLUENCER"),
  influencerController.bulkUpdateStatus
);
router.post(
  "/import",
  auditLog("IMPORT", "INFLUENCER"),
  influencerController.importInfluencers
);
router.post("/check-duplicates", influencerController.checkDuplicates);

export default router;
