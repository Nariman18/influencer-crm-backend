"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const automation_controller_1 = require("../controllers/automation.controller");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Get automation status and stats
router.get("/status", automation_controller_1.getAutomationStatus);
// Get configuration
router.get("/config", automation_controller_1.getAutomationConfig);
// Get pending follow-ups
router.get("/pending", automation_controller_1.getPendingFollowUps);
// Toggle automation for specific influencer
router.patch("/influencer/:influencerId/toggle", automation_controller_1.toggleInfluencerAutomation);
// Reset influencer status (for testing)
router.post("/influencer/:influencerId/reset", automation_controller_1.resetInfluencerStatus);
// Manually trigger automation check (for testing)
router.post("/trigger", automation_controller_1.triggerAutomationCheck);
exports.default = router;
