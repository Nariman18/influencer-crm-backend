"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/queue.routes.ts
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const redis_queue_1 = __importDefault(require("../lib/redis-queue")); // default export with emailSendQueue, followUpQueue, etc.
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
/**
 * Helper: get per-queue job counts safely
 */
async function safeGetCounts(queue) {
    try {
        // BullMQ's Queue.getJobCounts returns an object with keys like waiting, active, completed...
        const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
        return {
            ok: true,
            counts,
        };
    }
    catch (err) {
        console.warn("[queue.routes] getJobCounts failed for queue:", queue?.name, err);
        return {
            ok: false,
            error: err,
            counts: {
                waiting: 0,
                active: 0,
                completed: 0,
                failed: 0,
                delayed: 0,
            },
        };
    }
}
/**
 * Helper: check connection by attempting to fetch counts from both queues.
 * If either returns ok=true we treat connection as healthy.
 */
async function getQueueStats() {
    const emailQ = redis_queue_1.default.emailSendQueue;
    const automationQ = redis_queue_1.default.followUpQueue;
    const [emailRes, automationRes] = await Promise.all([
        safeGetCounts(emailQ),
        safeGetCounts(automationQ),
    ]);
    return {
        connection: emailRes.ok || automationRes.ok,
        email: emailRes.counts,
        automation: automationRes.counts,
        // minor metadata
        meta: {
            emailName: (emailQ && emailQ.name) || "email-send-queue",
            automationName: (automationQ && automationQ.name) || "follow-up-queue",
            prefix: (emailQ && emailQ.opts?.prefix) || undefined,
        },
    };
}
/**
 * GET /api/queue/stats
 * Comprehensive queue stats summary
 */
router.get("/stats", async (_req, res) => {
    try {
        const stats = await getQueueStats();
        res.json({
            success: true,
            data: stats,
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("[queue.routes] /stats error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to get queue statistics",
        });
    }
});
/**
 * GET /api/queue/health
 * Lightweight health check with simple thresholds
 */
router.get("/health", async (_req, res) => {
    try {
        const stats = await getQueueStats();
        const connectionStatus = stats.connection;
        // totals
        const emailTotal = (stats.email.waiting || 0) +
            (stats.email.active || 0) +
            (stats.email.completed || 0) +
            (stats.email.failed || 0) +
            (stats.email.delayed || 0);
        const automationTotal = (stats.automation.waiting || 0) +
            (stats.automation.active || 0) +
            (stats.automation.completed || 0) +
            (stats.automation.failed || 0) +
            (stats.automation.delayed || 0);
        const pendingEmail = (stats.email.waiting || 0) + (stats.email.active || 0);
        const pendingAutomation = (stats.automation.waiting || 0) + (stats.automation.active || 0);
        // thresholds (tune as needed)
        const isHealthy = connectionStatus && pendingEmail < 1000 && pendingAutomation < 500;
        const healthStatus = {
            healthy: Boolean(isHealthy),
            connection: connectionStatus ? "connected" : "disconnected",
            timestamp: new Date().toISOString(),
            queues: {
                email: {
                    status: pendingEmail < 500 ? "healthy" : "busy",
                    totalJobs: emailTotal,
                    pending: pendingEmail,
                    breakdown: stats.email,
                },
                automation: {
                    status: pendingAutomation < 100 ? "healthy" : "busy",
                    totalJobs: automationTotal,
                    pending: pendingAutomation,
                    breakdown: stats.automation,
                },
            },
        };
        res.json(healthStatus);
    }
    catch (error) {
        console.error("[queue.routes] /health error:", error);
        res.status(500).json({
            healthy: false,
            connection: "error",
            error: "Queue health check failed",
            timestamp: new Date().toISOString(),
        });
    }
});
/**
 * GET /api/queue/usage
 * Daily usage summary & simple recommendations
 */
router.get("/usage", async (_req, res) => {
    try {
        const stats = await getQueueStats();
        const usageStats = {
            connection: stats.connection ? "connected" : "disconnected",
            dailyLimit: process.env.NODE_ENV === "development" ? 1000 : 2000,
            queues: {
                email: stats.email,
                automation: stats.automation,
            },
            recommendations: {
                email: (stats.email.waiting || 0) > 100
                    ? "Consider increasing worker concurrency or throttling producer"
                    : "Normal load",
                automation: (stats.automation.waiting || 0) > 50
                    ? "Automation queue is busy"
                    : "Normal load",
            },
            timestamp: new Date().toISOString(),
        };
        res.json({
            success: true,
            data: usageStats,
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("[queue.routes] /usage error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to get queue usage statistics",
        });
    }
});
/**
 * GET /api/queue/config
 * Return basic queue config and provider checks
 */
router.get("/config", async (_req, res) => {
    try {
        // derive a few config flags
        const config = {
            environment: process.env.NODE_ENV || "development",
            redis: {
                urlConfigured: !!process.env.REDIS_URL,
            },
            limits: {
                dailyEmails: process.env.NODE_ENV === "development" ? 1000 : 2000,
                emailConcurrency: process.env.NODE_ENV === "development" ? 2 : 4,
                automationConcurrency: 2,
                emailsPerMinute: 10,
            },
            delays: {
                betweenEmails: process.env.NODE_ENV === "development"
                    ? "jittered (2s)"
                    : "jittered (10s)",
                automation: process.env.NODE_ENV === "development"
                    ? "2 minutes (dev)"
                    : "24 hours (prod)",
            },
            providers: {
                mailgun: {
                    configured: Boolean(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN),
                    domain: process.env.MAILGUN_DOMAIN || null,
                },
                gmail: {
                    note: "Per-user configuration stored in DB (users connect their Gmail accounts)",
                },
            },
        };
        res.json({
            success: true,
            data: config,
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("[queue.routes] /config error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to get queue configuration",
        });
    }
});
/**
 * POST /api/queue/cleanup
 * Admin-only cleanup placeholder — safe default: does not delete anything.
 * If you want to enable destructive cleanup, implement RBAC + confirmations.
 */
router.post("/cleanup", async (_req, res) => {
    try {
        // Do not perform any destructive action by default.
        // Return suggested capabilities for admin UI.
        res.json({
            success: true,
            message: "Queue cleanup endpoint (safe mode). No action performed.",
            capabilities: [
                "Remove stalled jobs (admin only)",
                "Clean completed jobs older than X days",
                "Clean failed jobs older than X days",
            ],
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("[queue.routes] /cleanup error:", error);
        res.status(500).json({
            success: false,
            error: "Queue cleanup failed",
        });
    }
});
/**
 * GET /api/queue/metrics
 * Derived metrics (failure rates, efficiency)
 */
router.get("/metrics", async (_req, res) => {
    try {
        const stats = await getQueueStats();
        const emailProcessed = (stats.email.completed || 0) + (stats.email.failed || 0);
        const automationProcessed = (stats.automation.completed || 0) + (stats.automation.failed || 0);
        const emailFailureRate = emailProcessed > 0
            ? ((stats.email.failed || 0) / emailProcessed) * 100
            : 0;
        const automationFailureRate = automationProcessed > 0
            ? ((stats.automation.failed || 0) / automationProcessed) * 100
            : 0;
        const emailEfficiency = emailProcessed > 0
            ? ((stats.email.completed || 0) / emailProcessed) * 100
            : 100;
        const automationEfficiency = automationProcessed > 0
            ? ((stats.automation.completed || 0) / automationProcessed) * 100
            : 100;
        const metrics = {
            performance: {
                emailQueue: {
                    throughput: `${stats.email.completed || 0} completed`,
                    failureRate: `${emailFailureRate.toFixed(2)}%`,
                    backlog: (stats.email.waiting || 0) + (stats.email.delayed || 0),
                    efficiency: `${emailEfficiency.toFixed(2)}%`,
                    activeWorkers: stats.email.active || 0,
                },
                automationQueue: {
                    throughput: `${stats.automation.completed || 0} completed`,
                    failureRate: `${automationFailureRate.toFixed(2)}%`,
                    backlog: (stats.automation.waiting || 0) + (stats.automation.delayed || 0),
                    efficiency: `${automationEfficiency.toFixed(2)}%`,
                    activeWorkers: stats.automation.active || 0,
                },
            },
            recommendations: {
                email: (stats.email.waiting || 0) > 50
                    ? "Consider scaling email workers"
                    : "Optimal",
                automation: (stats.automation.waiting || 0) > 20
                    ? "Optimize automation logic"
                    : "Optimal",
            },
            timestamp: new Date().toISOString(),
        };
        res.json({
            success: true,
            data: metrics,
        });
    }
    catch (error) {
        console.error("[queue.routes] /metrics error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to get queue performance metrics",
        });
    }
});
/**
 * GET /api/queue/detailed
 * Detailed, verbose diagnostics for admin UIs
 */
router.get("/detailed", async (_req, res) => {
    try {
        const stats = await getQueueStats();
        const connectionStatus = stats.connection;
        const emailTotalJobs = (stats.email.waiting || 0) +
            (stats.email.active || 0) +
            (stats.email.completed || 0) +
            (stats.email.failed || 0) +
            (stats.email.delayed || 0);
        const automationTotalJobs = (stats.automation.waiting || 0) +
            (stats.automation.active || 0) +
            (stats.automation.completed || 0) +
            (stats.automation.failed || 0) +
            (stats.automation.delayed || 0);
        const emailProcessed = (stats.email.completed || 0) + (stats.email.failed || 0);
        const automationProcessed = (stats.automation.completed || 0) + (stats.automation.failed || 0);
        const detailedStats = {
            connection: {
                status: connectionStatus ? "connected" : "disconnected",
                redis: process.env.REDIS_URL ? "configured" : "not configured",
            },
            emailQueue: {
                summary: {
                    total: emailTotalJobs,
                    processed: emailProcessed,
                    pending: (stats.email.waiting || 0) +
                        (stats.email.active || 0) +
                        (stats.email.delayed || 0),
                    successRate: emailProcessed > 0
                        ? `${(((stats.email.completed || 0) / emailProcessed) *
                            100).toFixed(2)}%`
                        : "N/A",
                },
                breakdown: stats.email,
                health: (stats.email.waiting || 0) > 100
                    ? "high_load"
                    : (stats.email.waiting || 0) > 20
                        ? "moderate_load"
                        : "healthy",
            },
            automationQueue: {
                summary: {
                    total: automationTotalJobs,
                    processed: automationProcessed,
                    pending: (stats.automation.waiting || 0) +
                        (stats.automation.active || 0) +
                        (stats.automation.delayed || 0),
                    successRate: automationProcessed > 0
                        ? `${(((stats.automation.completed || 0) / automationProcessed) *
                            100).toFixed(2)}%`
                        : "N/A",
                },
                breakdown: stats.automation,
                health: (stats.automation.waiting || 0) > 50
                    ? "high_load"
                    : (stats.automation.waiting || 0) > 10
                        ? "moderate_load"
                        : "healthy",
            },
            system: {
                environment: process.env.NODE_ENV || "development",
                dailyEmailLimit: process.env.NODE_ENV === "development" ? 1000 : 2000,
                concurrency: {
                    email: process.env.NODE_ENV === "development" ? 2 : 4,
                    automation: 2,
                },
            },
            timestamp: new Date().toISOString(),
        };
        res.json({
            success: true,
            data: detailedStats,
        });
    }
    catch (error) {
        console.error("[queue.routes] /detailed error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to get detailed queue statistics",
        });
    }
});
exports.default = router;
