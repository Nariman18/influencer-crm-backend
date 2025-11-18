// src/routes/index.ts - UPDATED
import { Router } from "express";
import authRoutes from "./auth.routes";
import influencerRoutes from "./influencer.routes";
import contractRoutes from "./contract.routes";
import campaignRoutes from "./campaign.routes";
import emailTemplateRoutes from "./emailTemplate.routes";
import emailRoutes from "./email.routes";
import dashboardRoutes from "./dashboard.routes";
import queueRoutes from "./queue.routes";
import { ImportController } from "../controllers/import.controller";
import debugQueue from "./debug-queue";

const router = Router();

router.use("/auth", authRoutes);
router.use("/influencers", influencerRoutes);
router.use("/contracts", contractRoutes);
router.use("/campaigns", campaignRoutes);
router.use("/email-templates", emailTemplateRoutes);
router.use("/emails", emailRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/queue", queueRoutes);

// Import routes
router.post("/import/influencers", ImportController.importInfluencers);
router.post("/import/influencers/batch", ImportController.importMultipleFiles);
router.use("/debug", debugQueue);

export default router;
