// worker.ts
import dotenv from "dotenv";
dotenv.config({ path: ".env.worker" });
import redisQueue, { setupEventListeners } from "./lib/redis-queue";

(async () => {
  try {
    console.log("[worker] starting worker process...");
    setupEventListeners();

    // --- start optimized import/export workers here ---
    try {
      const { startOptimizedImportWorker } = await import(
        "./workers/import.worker"
      );
      const { startExportWorker } = await import("./workers/export.worker");
      const importWorker = startOptimizedImportWorker(); // Use optimized worker
      const exportWorker = startExportWorker();
      console.log("[worker] optimized import/export workers started");
    } catch (e) {
      console.warn("[worker] failed to start import/export workers:", e);
    }

    console.log("[worker] workers & schedulers initialized");
    console.log("[worker] listening for jobs on:");
    console.log("   -", redisQueue.emailSendQueue.name);
    console.log("   -", redisQueue.followUpQueue.name);
    console.log("   - influencer-imports");
    console.log("   - influencer-exports");

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
