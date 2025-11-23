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

import debugQueue from "./debug-queue";
import importRoutes from "./import.routes";
import exportRoutes from "./export.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/influencers", influencerRoutes);
router.use("/contracts", contractRoutes);
router.use("/campaigns", campaignRoutes);
router.use("/email-templates", emailTemplateRoutes);
router.use("/emails", emailRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/queue", queueRoutes);

router.use("/debug", debugQueue);

// Import routes
router.use("/import", importRoutes);
router.use("/export", exportRoutes);

export default router;
