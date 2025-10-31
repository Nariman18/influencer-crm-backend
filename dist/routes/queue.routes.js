"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/queue.routes.ts - NEW FILE
const express_1 = require("express");
const redis_queue_1 = require("../lib/redis-queue");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// Get queue statistics
router.get("/stats", async (req, res) => {
    try {
        const stats = await redis_queue_1.redisQueue.getQueueStats();
        res.json(stats);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to get queue stats" });
    }
});
// Get queue health
router.get("/health", async (req, res) => {
    try {
        const stats = await redis_queue_1.redisQueue.getQueueStats();
        const isHealthy = stats.waiting + stats.active < 1000; // Arbitrary health check
        res.json({
            healthy: isHealthy,
            ...stats,
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        res.status(500).json({
            healthy: false,
            error: "Queue health check failed",
        });
    }
});
exports.default = router;
