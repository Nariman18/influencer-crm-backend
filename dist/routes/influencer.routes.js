"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/influencer.routes.ts
const express_1 = require("express");
const influencerController = __importStar(require("../controllers/influencer.controller"));
const auth_1 = require("../middleware/auth");
const auditLog_1 = require("../middleware/auditLog");
const influencer_controller_1 = require("../controllers/influencer.controller");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get("/", influencerController.getInfluencers);
router.get("/:id", influencerController.getInfluencer);
router.post("/", (0, auditLog_1.auditLog)("CREATE", "INFLUENCER"), influencerController.createInfluencer);
router.put("/:id", (0, auditLog_1.auditLog)("UPDATE", "INFLUENCER"), influencerController.updateInfluencer);
router.delete("/:id", (0, auditLog_1.auditLog)("DELETE", "INFLUENCER"), influencerController.deleteInfluencer);
router.post("/bulk-delete", (0, auditLog_1.auditLog)("BULK_DELETE", "INFLUENCER"), influencerController.bulkDeleteInfluencers);
router.post("/bulk/update-status", (0, auditLog_1.auditLog)("BULK_UPDATE", "INFLUENCER"), influencerController.bulkUpdateStatus);
router.post("/import", (0, auditLog_1.auditLog)("IMPORT", "INFLUENCER"), influencerController.importInfluencers);
router.post("/check-duplicates", influencerController.checkDuplicates);
router.post("/:id/automation/cancel", influencer_controller_1.stopAutomation);
exports.default = router;
