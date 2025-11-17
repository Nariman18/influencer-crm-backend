"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetInfluencerStatus = exports.getAutomationConfig = exports.triggerAutomationCheck = exports.toggleInfluencerAutomation = exports.getPendingFollowUps = exports.getAutomationStatus = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
const emailScheduler_1 = require("../jobs/emailScheduler");
const emailAutomation_service_1 = require("../services/emailAutomation.service");
/**
 * Get automation status and configuration
 */
const getAutomationStatus = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const schedulerStatus = emailScheduler_1.EmailScheduler.getStatus();
        // Get statistics
        const stats = await prisma_1.default.influencer.groupBy({
            by: ["status"],
            where: {
                managerId: req.user.id,
            },
            _count: true,
        });
        const pendingFollowUps = await prisma_1.default.influencer.count({
            where: {
                managerId: req.user.id,
                autoFollowUpEnabled: true,
                nextFollowUpDate: {
                    not: null,
                },
            },
        });
        res.json({
            scheduler: schedulerStatus,
            statistics: {
                byStatus: stats,
                pendingFollowUps,
            },
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to get automation status", 500);
    }
};
exports.getAutomationStatus = getAutomationStatus;
/**
 * Get influencers with pending follow-ups
 */
const getPendingFollowUps = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const influencers = await prisma_1.default.influencer.findMany({
            where: {
                managerId: req.user.id,
                autoFollowUpEnabled: true,
                nextFollowUpDate: {
                    not: null,
                },
            },
            select: {
                id: true,
                name: true,
                email: true,
                instagramHandle: true,
                status: true,
                nextFollowUpDate: true,
                followUpCount: true,
                lastContactDate: true,
            },
            orderBy: {
                nextFollowUpDate: "asc",
            },
        });
        res.json({
            count: influencers.length,
            influencers,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to get pending follow-ups", 500);
    }
};
exports.getPendingFollowUps = getPendingFollowUps;
/**
 * Enable/disable automation for an influencer
 */
const toggleInfluencerAutomation = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const { influencerId } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== "boolean") {
            throw new errorHandler_1.AppError("Enabled must be a boolean", 400);
        }
        const influencer = await prisma_1.default.influencer.findUnique({
            where: { id: influencerId },
        });
        if (!influencer) {
            throw new errorHandler_1.AppError("Influencer not found", 404);
        }
        if (influencer.managerId !== req.user.id) {
            throw new errorHandler_1.AppError("Not authorized", 403);
        }
        const updated = await prisma_1.default.influencer.update({
            where: { id: influencerId },
            data: {
                autoFollowUpEnabled: enabled,
                ...(enabled === false && { nextFollowUpDate: null }),
            },
        });
        res.json({
            message: `Automation ${enabled ? "enabled" : "disabled"} for ${influencer.name}`,
            influencer: updated,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to toggle automation", 500);
    }
};
exports.toggleInfluencerAutomation = toggleInfluencerAutomation;
/**
 * Manually trigger automation check (for testing)
 */
const triggerAutomationCheck = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        console.log(`🔧 Manual automation check triggered by user ${req.user.id}`);
        // Trigger the automation service
        await emailAutomation_service_1.EmailAutomationService.processAutomatedFollowUps();
        res.json({
            message: "Automation check triggered successfully",
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to trigger automation check", 500);
    }
};
exports.triggerAutomationCheck = triggerAutomationCheck;
/**
 * Get automation configuration
 */
const getAutomationConfig = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        res.json({
            config: emailAutomation_service_1.AUTOMATION_CONFIG,
            environment: process.env.NODE_ENV || "development",
            timings: {
                pollingInterval: `${emailAutomation_service_1.AUTOMATION_CONFIG.POLLING_INTERVAL / 1000}s`,
                ping1ToPing2: `${emailAutomation_service_1.AUTOMATION_CONFIG.PING_1_TO_PING_2_DELAY / 1000 / 60} minutes`,
                ping2ToPing3: `${emailAutomation_service_1.AUTOMATION_CONFIG.PING_2_TO_PING_3_DELAY / 1000 / 60} minutes`,
                ping3ToRejected: `${emailAutomation_service_1.AUTOMATION_CONFIG.PING_3_TO_REJECTED_DELAY / 1000 / 60} minutes`,
            },
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to get automation config", 500);
    }
};
exports.getAutomationConfig = getAutomationConfig;
/**
 * Reset influencer status (for testing)
 */
const resetInfluencerStatus = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const { influencerId } = req.params;
        const influencer = await prisma_1.default.influencer.findUnique({
            where: { id: influencerId },
        });
        if (!influencer) {
            throw new errorHandler_1.AppError("Influencer not found", 404);
        }
        if (influencer.managerId !== req.user.id) {
            throw new errorHandler_1.AppError("Not authorized", 403);
        }
        const updated = await prisma_1.default.influencer.update({
            where: { id: influencerId },
            data: {
                status: "NOT_SENT",
                autoFollowUpEnabled: true,
                nextFollowUpDate: null,
                followUpCount: 0,
                lastEmailThreadId: null,
            },
        });
        res.json({
            message: `Reset status for ${influencer.name}`,
            influencer: updated,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to reset influencer status", 500);
    }
};
exports.resetInfluencerStatus = resetInfluencerStatus;
