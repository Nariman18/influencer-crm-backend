"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/index.ts - UPDATED
const express_1 = require("express");
const auth_routes_1 = __importDefault(require("./auth.routes"));
const influencer_routes_1 = __importDefault(require("./influencer.routes"));
const contract_routes_1 = __importDefault(require("./contract.routes"));
const campaign_routes_1 = __importDefault(require("./campaign.routes"));
const emailTemplate_routes_1 = __importDefault(require("./emailTemplate.routes"));
const email_routes_1 = __importDefault(require("./email.routes"));
const dashboard_routes_1 = __importDefault(require("./dashboard.routes"));
const queue_routes_1 = __importDefault(require("./queue.routes"));
const debug_queue_1 = __importDefault(require("./debug-queue"));
const import_routes_1 = __importDefault(require("./import.routes"));
const export_routes_1 = __importDefault(require("./export.routes"));
const router = (0, express_1.Router)();
router.use("/auth", auth_routes_1.default);
router.use("/influencers", influencer_routes_1.default);
router.use("/contracts", contract_routes_1.default);
router.use("/campaigns", campaign_routes_1.default);
router.use("/email-templates", emailTemplate_routes_1.default);
router.use("/emails", email_routes_1.default);
router.use("/dashboard", dashboard_routes_1.default);
router.use("/queue", queue_routes_1.default);
router.use("/debug", debug_queue_1.default);
// Import routes
router.use("/import", import_routes_1.default);
router.use("/export", export_routes_1.default);
exports.default = router;
