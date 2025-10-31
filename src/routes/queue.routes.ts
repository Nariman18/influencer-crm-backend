// routes/queue.routes.ts - NEW FILE
import { Router } from "express";
import { redisQueue } from "../lib/redis-queue";
import { authenticate } from "../middleware/auth";

const router = Router();

router.use(authenticate);

// Get queue statistics
router.get("/stats", async (req, res) => {
  try {
    const stats = await redisQueue.getQueueStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to get queue stats" });
  }
});

// Get queue health
router.get("/health", async (req, res) => {
  try {
    const stats = await redisQueue.getQueueStats();
    const isHealthy = stats.waiting + stats.active < 1000; // Arbitrary health check

    res.json({
      healthy: isHealthy,
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      healthy: false,
      error: "Queue health check failed",
    });
  }
});

export default router;
