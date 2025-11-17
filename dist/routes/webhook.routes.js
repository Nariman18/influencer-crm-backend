"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/webhook.routes.ts - Webhook routes (no authentication required)
const express_1 = require("express");
const mailgun_webhook_controller_1 = require("../controllers/mailgun-webhook.controller");
const router = (0, express_1.Router)();
/**
 * Mailgun webhook endpoint
 * This endpoint receives events from Mailgun (delivered, opened, replied, etc.)
 * No authentication required - uses webhook signature verification instead
 */
router.post("/mailgun", mailgun_webhook_controller_1.handleMailgunWebhook);
exports.default = router;
