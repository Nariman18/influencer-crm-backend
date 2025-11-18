"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/debug-queue.ts
const express_1 = __importDefault(require("express"));
const redis_queue_1 = require("../lib/redis-queue");
const router = express_1.default.Router();
router.get("/queues", async (_req, res) => {
    try {
        const emailCounts = await (redis_queue_1.emailSendQueue.getJobCounts?.()).catch(() => null);
        const followCounts = await (redis_queue_1.followUpQueue.getJobCounts?.()).catch(() => null);
        const delayedEmail = await (redis_queue_1.emailSendQueue.getJobs?.("delayed", 0, 9) ||
            Promise.resolve([]));
        const failedEmail = await (redis_queue_1.emailSendQueue.getJobs?.("failed", 0, 9) ||
            Promise.resolve([]));
        const delayedFollow = await (redis_queue_1.followUpQueue.getJobs?.("delayed", 0, 9) ||
            Promise.resolve([]));
        res.json({
            timestamp: new Date().toISOString(),
            emailSendQueue: {
                counts: emailCounts || "getJobCounts not available",
                delayedPreview: (delayedEmail || []).map((j) => ({
                    id: j.id,
                    name: j.name,
                    timestamp: j.timestamp,
                })),
                failedPreview: (failedEmail || []).map((j) => ({
                    id: j.id,
                    name: j.name,
                    failedReason: j.failedReason,
                })),
            },
            followUpQueue: {
                counts: followCounts || "getJobCounts not available",
                delayedPreview: (delayedFollow || []).map((j) => ({
                    id: j.id,
                    name: j.name,
                })),
            },
        });
    }
    catch (err) {
        res.status(500).json({ error: String(err) });
    }
});
exports.default = router;
