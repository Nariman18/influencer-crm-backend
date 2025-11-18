// src/routes/debug-queue.ts
import express from "express";
import { emailSendQueue, followUpQueue } from "../lib/redis-queue";
const router = express.Router();

router.get("/queues", async (_req, res) => {
  try {
    const emailCounts = await (emailSendQueue.getJobCounts?.() as any).catch(
      () => null
    );
    const followCounts = await (followUpQueue.getJobCounts?.() as any).catch(
      () => null
    );
    const delayedEmail = await (emailSendQueue.getJobs?.("delayed", 0, 9) ||
      Promise.resolve([]));
    const failedEmail = await (emailSendQueue.getJobs?.("failed", 0, 9) ||
      Promise.resolve([]));
    const delayedFollow = await (followUpQueue.getJobs?.("delayed", 0, 9) ||
      Promise.resolve([]));

    res.json({
      timestamp: new Date().toISOString(),
      emailSendQueue: {
        counts: emailCounts || "getJobCounts not available",
        delayedPreview: (delayedEmail || []).map((j: any) => ({
          id: j.id,
          name: j.name,
          timestamp: j.timestamp,
        })),
        failedPreview: (failedEmail || []).map((j: any) => ({
          id: j.id,
          name: j.name,
          failedReason: j.failedReason,
        })),
      },
      followUpQueue: {
        counts: followCounts || "getJobCounts not available",
        delayedPreview: (delayedFollow || []).map((j: any) => ({
          id: j.id,
          name: j.name,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
