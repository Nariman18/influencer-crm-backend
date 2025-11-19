// src/lib/import-export-queue.ts
import IORedis from "ioredis";
import { Queue, JobsOptions } from "bullmq";
import path from "path";

/**
 * Defensive QueueScheduler resolution (same approach as redis-queue).
 */
function resolveQueueScheduler(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("bullmq");
    if (mod && typeof mod.QueueScheduler === "function")
      return mod.QueueScheduler;
    if (mod && mod.default && typeof mod.default.QueueScheduler === "function")
      return mod.default.QueueScheduler;
    return null;
  } catch (e) {
    console.warn(
      "[import-export-queue] failed to require bullmq QueueScheduler:",
      (e as any)?.message ?? e
    );
    return null;
  }
}

const QueueSchedulerCtor = resolveQueueScheduler();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
export const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// queue names
export const IMPORT_QUEUE = "influencer-imports";
export const EXPORT_QUEUE = "influencer-exports";

// create queues
export const importQueue = new Queue(IMPORT_QUEUE, { connection });
export const exportQueue = new Queue(EXPORT_QUEUE, { connection });

// create schedulers in this process if possible (worker process should do this ideally)
if (QueueSchedulerCtor) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (QueueSchedulerCtor as any)(IMPORT_QUEUE, { connection });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (QueueSchedulerCtor as any)(EXPORT_QUEUE, { connection });
    console.log("[import-export-queue] QueueSchedulers created");
  } catch (e) {
    console.warn(
      "[import-export-queue] Failed to create QueueScheduler:",
      (e as any)?.message ?? e
    );
  }
} else {
  console.warn(
    "[import-export-queue] QueueScheduler constructor not found. If you run workers separately, create schedulers in the worker process."
  );
}

// sensible default job options (override per job when needed)
const defaultJobOpts: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 10000,
  removeOnFail: 10000,
};

export interface EnqueueImportPayload {
  managerId: string;
  filePath: string;
  filename: string;
  importJobId: string;
}

export interface EnqueueExportPayload {
  managerId: string;
  exportJobId: string;
  filters?: any;
}

export const enqueueImport = async (payload: EnqueueImportPayload) => {
  const opts: any = {
    ...defaultJobOpts,
    timeout: Number(process.env.IMPORT_JOB_TIMEOUT_MS || 1000 * 60 * 60),
  };
  return importQueue.add(`import-${payload.importJobId}`, payload, opts);
};

export const enqueueExport = async (payload: EnqueueExportPayload) => {
  const opts: any = {
    ...defaultJobOpts,
    timeout: Number(process.env.EXPORT_JOB_TIMEOUT_MS || 1000 * 60 * 60),
  };
  return exportQueue.add(`export-${payload.exportJobId}`, payload, opts);
};

/**
 * Publish progress messages to Redis pub/sub so server can forward them
 * to socket.io clients. Channel shape:
 *  - import:progress:<jobId>
 *  - export:progress:<jobId>
 *
 * Payload is JSON-stringified object.
 */
export const publishImportProgress = async (jobId: string, payload: any) => {
  try {
    const channel = `import:progress:${jobId}`;
    await connection.publish(channel, JSON.stringify(payload));
  } catch (e) {
    console.warn("[import-export-queue] publishImportProgress failed:", e);
  }
};

export const publishExportProgress = async (jobId: string, payload: any) => {
  try {
    const channel = `export:progress:${jobId}`;
    await connection.publish(channel, JSON.stringify(payload));
  } catch (e) {
    console.warn("[import-export-queue] publishExportProgress failed:", e);
  }
};

async function tryUpsertScheduler(queue: any, schedulerId: string) {
  if (!queue || typeof queue.upsertJobScheduler !== "function") return false;
  const objForm = {
    id: schedulerId,
    repeat: { every: 60_000 },
    job: {
      name: "__scheduler-noop",
      data: { __noop: true },
      opts: { removeOnComplete: true, removeOnFail: true },
    },
  };
  try {
    await (queue as any).upsertJobScheduler(objForm);
    console.log(
      `[import-export-queue] upsertJobScheduler invoked (object form) for ${queue.name}`
    );
    return true;
  } catch (errObj) {
    try {
      await (queue as any).upsertJobScheduler(
        schedulerId,
        objForm.repeat,
        objForm.job
      );
      console.log(
        `[import-export-queue] upsertJobScheduler invoked (args form) for ${queue.name}`
      );
      return true;
    } catch {
      try {
        await (queue as any).upsertJobScheduler(schedulerId, objForm.repeat);
        console.log(
          `[import-export-queue] upsertJobScheduler invoked (id, repeat) for ${queue.name}`
        );
        return true;
      } catch (finalErr) {
        console.warn(
          `[import-export-queue] upsert attempts failed for ${queue.name}`,
          finalErr
        );
        return false;
      }
    }
  }
}

// call it (worker process will run this)
(async () => {
  try {
    const ok1 = await tryUpsertScheduler(importQueue, "import-scheduler");
    const ok2 = await tryUpsertScheduler(exportQueue, "export-scheduler");
    if (ok1 || ok2)
      console.log(
        "[import-export-queue] Job scheduler(s) registered via queue.upsertJobScheduler"
      );
  } catch (e) {
    console.warn("[import-export-queue] scheduler upsert failed:", e);
  }
})();

export const cleanOldJobs = async () => {
  try {
    await importQueue.clean(
      1000 * 60 * 60 * 24,
      1000 * 60 * 60 * 24,
      "completed"
    );
  } catch (e) {
    // ignore
  }
};

export default {
  importQueue,
  exportQueue,
  enqueueImport,
  enqueueExport,
  connection,
  publishImportProgress,
  publishExportProgress,
};
