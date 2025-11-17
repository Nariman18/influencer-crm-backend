// src/worker.ts
import "dotenv/config";

// Importing this file instantiates queues, workers & schedulers
import redisQueue, { setupEventListeners } from "./lib/redis-queue";

(async () => {
  try {
    console.log("[worker] starting worker process...");

    // optional: attach event listeners for logs/monitoring
    setupEventListeners();

    console.log("[worker] workers & schedulers initialized");
    console.log("[worker] listening for jobs on:");
    console.log("   -", redisQueue.emailSendQueue.name);
    console.log("   -", redisQueue.followUpQueue.name);

    // Keep process alive – Workers do this by default, so nothing else required.
    process.on("SIGINT", () => {
      console.log("[worker] SIGINT received, shutting down...");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("[worker] SIGTERM received, shutting down...");
      process.exit(0);
    });
  } catch (err) {
    console.error("[worker] failed to start:", err);
    process.exit(1);
  }
})();
