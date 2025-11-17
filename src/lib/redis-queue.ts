// src/lib/redis-queue.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Robust bullmq + ioredis bootstrap using the newer Job Scheduler API.
 * - Tries to call queue.upsertJobScheduler(...) (preferred)
 * - Falls back to new QueueScheduler(...) if present
 * - Creates Queue + Worker instances robustly for CJS / ESM / ts-node
 *
 * NOTE: you must run at least one process that imports this file (server or worker)
 * so a scheduler entry is registered in Redis (delayed jobs & retries require a scheduler).
 */

import IORedis from "ioredis";
import prisma from "../config/prisma";
import { sendMailgunEmail } from "./mailgun-client";
import { checkForReplyAndHandle } from "./followup-service";
import { EmailStatus, InfluencerStatus } from "@prisma/client";

export type EmailJobData = {
  userId: string;
  to: string;
  subject: string;
  body: string;
  influencerName: string;
  emailRecordId?: string; // optional because we may harden against missing id
  influencerId?: string; // optional for safety
  replyTo?: string;
  automation?: { start?: boolean; templates?: string[] };
};

const normalizeError = (x: any): string => {
  try {
    if (!x) return "Unknown error";
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.message;
    if (x?.response?.data) {
      if (typeof x.response.data === "string") return x.response.data;
      try {
        return JSON.stringify(x.response.data);
      } catch {
        return String(x.response.data);
      }
    }
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  } catch {
    return "Unknown error";
  }
};

const isValidEmail = (s: any): s is string => {
  if (!s || typeof s !== "string") return false;
  // very small conservative check
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
};

const prefix = process.env.BULLMQ_PREFIX || "influencer-crm";
const rawRedisUrl = process.env.REDIS_URL;
if (!rawRedisUrl) {
  throw new Error("Missing REDIS_URL in environment");
}

const shouldUseTls =
  rawRedisUrl.startsWith("rediss://") ||
  String(process.env.REDIS_TLS_FORCE).toLowerCase() === "true";

const tlsRejectUnauthorized =
  String(process.env.REDIS_TLS_REJECT_UNAUTHORIZED).toLowerCase() !== "false";

const connection = (() => {
  try {
    if (shouldUseTls) {
      return new IORedis(rawRedisUrl, {
        tls: {
          rejectUnauthorized: tlsRejectUnauthorized,
          servername: new URL(rawRedisUrl).hostname,
        } as any,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
    } else {
      return new IORedis(rawRedisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
    }
  } catch (err) {
    console.error("[redis-queue] Failed to create ioredis connection", err);
    throw err;
  }
})();

/**
 * Robustly resolve Queue / Worker classes from bullmq
 * Prefer synchronous require() (most environments); then dynamic import fallback.
 */
let QueueClass: any = null;
let WorkerClass: any = null;
let QueueSchedulerClass: any = null;

const tryRequire = (p: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p);
  } catch {
    return null;
  }
};

(() => {
  // attempt root require('bullmq')
  try {
    const bull = tryRequire("bullmq");
    if (bull) {
      const resolved = (bull && (bull.default || bull)) as any;
      QueueClass = QueueClass || resolved?.Queue;
      WorkerClass = WorkerClass || resolved?.Worker;
      QueueSchedulerClass = QueueSchedulerClass || resolved?.QueueScheduler;
      console.log("[redis-queue] resolved bullmq via require('bullmq')");
    }
  } catch (err) {
    // swallow
  }
})();

// We'll try dynamic import later if anything missing.
const dynamicResolve = async () => {
  try {
    const mod: any = await import("bullmq");
    const resolved = (mod && (mod.default || mod)) as any;
    QueueClass = QueueClass || resolved?.Queue;
    WorkerClass = WorkerClass || resolved?.Worker;
    QueueSchedulerClass = QueueSchedulerClass || resolved?.QueueScheduler;
    console.log("[redis-queue] resolved bullmq via dynamic import");
  } catch (err) {
    // ignore, we'll log later if scheduler not available
    console.warn("[redis-queue] dynamic import('bullmq') failed:", err);
  }
};

/* ---------- Create Queues (sync-safe) ---------- */
const queueOpts = { connection, prefix };

export const emailSendQueue = QueueClass
  ? new QueueClass("email-send-queue", queueOpts)
  : // lightweight fallback queue shape so code that uses `.add` still works without throwing
    ({
      name: "email-send-queue",
      add: async () => ({}),
      remove: async () => {},
    } as any);

export const followUpQueue = QueueClass
  ? new QueueClass("follow-up-queue", queueOpts)
  : ({
      name: "follow-up-queue",
      add: async () => ({}),
      remove: async () => {},
    } as any);

/* ---------- Job Schedulers ---------- */
const tryUpsertScheduler = async (queue: any, schedulerId: string) => {
  if (!queue) return false;
  const fn = (queue as any).upsertJobScheduler;
  if (typeof fn !== "function") return false;

  // We'll attempt the object form first which many 5.x variants expose.
  const objForm = {
    id: schedulerId,
    // a tiny safe repeating/placeholder config so scheduler registers
    repeat: {
      // harmless no-op; can tune or remove repeat if undesired
      every: 60_000,
    },
    job: {
      name: "__scheduler-noop",
      data: { __noop: true },
      opts: { removeOnComplete: true, removeOnFail: true },
    },
  };

  try {
    // prefer the object form which matches: queue.upsertJobScheduler({ id, repeat, job })
    await fn.call(queue, objForm);
    console.log(
      `[redis-queue] upsertJobScheduler invoked (object form) for ${queue.name}`
    );
    return true;
  } catch (errObj) {
    // try the alternate function form: (id, repeat, job)
    try {
      await fn.call(queue, schedulerId, objForm.repeat, objForm.job);
      console.log(
        `[redis-queue] upsertJobScheduler invoked (args form) for ${queue.name}`
      );
      return true;
    } catch (errArgs) {
      // final attempt: (id, repeat) — some builds accept this minimal shape
      try {
        await fn.call(queue, schedulerId, objForm.repeat);
        console.log(
          `[redis-queue] upsertJobScheduler invoked (id, repeat) for ${queue.name}`
        );
        return true;
      } catch (errFinal) {
        console.warn(
          `[redis-queue] upsertJobScheduler exists but all invocation attempts failed for queue ${queue.name}`,
          { errObj, errArgs, errFinal }
        );
        return false;
      }
    }
  }
};

/**
 * Final scheduler setup:
 *  - Try queue.upsertJobScheduler(...) (preferred).
 *  - If not available, try to instantiate old QueueScheduler class (best-effort).
 *  - If neither works, log a warning: delayed jobs/retries may not run.
 */
const ensureSchedulers = async () => {
  // resolve bullmq libs if any missing
  if (!QueueClass || !WorkerClass || !QueueSchedulerClass) {
    await dynamicResolve();
  }

  // 1) preferred: use Queue.upsertJobScheduler if present
  let anyUpserted = false;
  try {
    anyUpserted =
      (await tryUpsertScheduler(emailSendQueue, "email-send-scheduler")) ||
      anyUpserted;
    anyUpserted =
      (await tryUpsertScheduler(followUpQueue, "follow-up-scheduler")) ||
      anyUpserted;
    if (anyUpserted) {
      console.log(
        "[redis-queue] Job scheduler(s) registered via queue.upsertJobScheduler"
      );
      // still try to create QueueScheduler class below in case older APIs need it — non-fatal
    }
  } catch (e) {
    // Non-fatal
    console.warn("[redis-queue] error trying upsertJobScheduler:", e);
  }

  // 2) fallback: QueueScheduler class if available
  if (!anyUpserted && QueueSchedulerClass) {
    try {
      new QueueSchedulerClass("email-send-queue", { connection, prefix });
      new QueueSchedulerClass("follow-up-queue", { connection, prefix });
      console.log(
        "[redis-queue] QueueScheduler created (fallback instantiation)."
      );
      anyUpserted = true;
    } catch (err) {
      console.warn("[redis-queue] QueueScheduler instantiation failed:", err);
    }
  }

  if (!anyUpserted) {
    console.warn(
      "[redis-queue] QueueScheduler not found after attempts — delayed jobs/retries may not run. " +
        "Either update bullmq to a version with upsertJobScheduler or run a separate scheduler process."
    );
  }
};

// Kick off scheduler registration (best-effort, non-blocking)
ensureSchedulers().catch((e) => {
  console.warn("[redis-queue] ensureSchedulers error:", e);
});

/* ---------- Workers (create once Worker class resolved) ---------- */
let emailWorker: any = null;
let followUpWorker: any = null;

const startWorkers = async () => {
  try {
    if (!WorkerClass) {
      await dynamicResolve();
      // if still missing, try import directly
      if (!WorkerClass) {
        const mod: any = await import("bullmq");
        const resolved = (mod && (mod.default || mod)) as any;
        WorkerClass = resolved?.Worker;
      }
    }

    if (!WorkerClass) {
      console.error(
        "[redis-queue] Worker class not available — workers will not start."
      );
      return;
    }

    // instantiate email worker
    emailWorker = new WorkerClass(
      "email-send-queue",
      async (job: any) => {
        // --- NEW GUARDS: ignore scheduler / noop jobs and non-email payloads ---
        // Scheduler jobs created via upsertJobScheduler commonly have names like "__scheduler-noop"
        // and/or IDs like "repeat:email-send-scheduler:...". Skip those early.
        const jobName = job?.name ?? "";
        const jobId = job?.id ?? "";
        const rawData = job?.data;

        if (jobName && jobName.toString().includes("__scheduler")) {
          // intentionally ignore scheduler's noop job
          console.log("[emailWorker] skipping scheduler/noop job", {
            jobId,
            jobName,
          });
          return;
        }

        // some scheduler variants produce repeat job ids that start with "repeat:"
        if (typeof jobId === "string" && jobId.startsWith("repeat:")) {
          console.log("[emailWorker] skipping repeat scheduler job", { jobId });
          return;
        }

        // ensure we have an object payload; if not, just skip with a log
        const data =
          rawData && typeof rawData === "object"
            ? (rawData as EmailJobData)
            : ({} as EmailJobData);

        // If this truly isn't an email-send job, log and ignore (don't throw)
        // This prevents scheduler/no-op jobs from causing DB updates or exceptions.
        const looksLikeEmailJob = !!(
          data &&
          (data.to || data.subject || data.body || data.emailRecordId)
        );
        if (!looksLikeEmailJob) {
          console.log("[emailWorker] skipping non-email job payload", {
            jobId,
            jobName,
            dataPreview: Object.keys(data || {}),
          });
          return;
        }
        // --------------------------------------------------------------------

        // Defensive: validate 'to' address
        if (!isValidEmail(data.to)) {
          const errMsg = `Invalid recipient address: ${String(data.to)}`;
          console.warn("[emailWorker] aborting send - invalid 'to':", errMsg, {
            jobId: job?.id,
            emailRecordId: data.emailRecordId,
            influencerId: data.influencerId,
          });

          // If we have a DB record id we should persist the failure
          if (data.emailRecordId) {
            try {
              await prisma.email.update({
                where: { id: data.emailRecordId },
                data: {
                  status: EmailStatus.FAILED,
                  attemptCount: { increment: 1 } as any,
                  errorMessage: errMsg,
                },
              });
            } catch (uErr: any) {
              if (uErr?.code === "P2025") {
                console.warn(
                  "[emailWorker] email record not found when persisting invalid 'to' failure:",
                  data.emailRecordId
                );
              } else {
                console.error(
                  "[emailWorker] failed to persist invalid 'to' failure:",
                  uErr
                );
              }
            }
          }

          // fail the job here so it shows up in worker failures (and retries behave normally)
          throw new Error(errMsg);
        }

        // Defensive: ensure emailRecordId exists if you need DB updates later
        const hasEmailId = !!data.emailRecordId;

        try {
          const result = await sendMailgunEmail({
            to: data.to,
            subject: data.subject,
            html: data.body,
            replyTo: data.replyTo || process.env.MAILGUN_FROM_EMAIL!,
            headers: {
              "X-CRM-EMAIL-ID": data.emailRecordId ?? "",
              "X-CRM-INFLUENCER-ID": data.influencerId ?? "",
            },
          });

          // Persist send result only if we have an email record id
          if (hasEmailId) {
            try {
              await prisma.email.update({
                where: { id: data.emailRecordId as string },
                data: {
                  status: result.success
                    ? EmailStatus.SENT
                    : EmailStatus.FAILED,
                  sentAt: result.success ? new Date() : undefined,
                  mailgunId: result.id || undefined,
                  mailgunMessageId: result.messageId || undefined,
                  attemptCount: { increment: 1 } as any,
                  ...(result.success
                    ? {}
                    : { errorMessage: normalizeError(result.error) }),
                },
              });
            } catch (uErr: any) {
              if (uErr?.code === "P2025") {
                console.warn(
                  "[emailWorker] email record not found when updating send result:",
                  data.emailRecordId
                );
              } else {
                console.error(
                  "[emailWorker] failed to persist send result:",
                  uErr
                );
              }
            }
          } else {
            // no email record — log the send outcome for debugging
            console.warn(
              "[emailWorker] send result received but no emailRecordId provided on job; skipping DB persist",
              { jobId: job?.id, result }
            );
          }

          // ====== TEMPLATE-AWARE INFLUENCER PIPELINE UPDATE (extra safety net) ======
          if (result.success && data.influencerId) {
            try {
              // Attempt to read email record to discover template name (if available)
              let emailRec: any = null;
              if (hasEmailId) {
                try {
                  emailRec = await prisma.email.findUnique({
                    where: { id: data.emailRecordId as string },
                    include: { template: true },
                  });
                } catch (fetchErr) {
                  console.warn(
                    "[emailWorker] could not fetch email record to derive template:",
                    fetchErr
                  );
                }
              }

              const templateName = emailRec?.template?.name || null;

              const TEMPLATE_24H =
                process.env.FOLLOWUP_TEMPLATE_24H || "24-Hour Reminder";
              const TEMPLATE_48H =
                process.env.FOLLOWUP_TEMPLATE_48H || "48-Hour Reminder";

              // <-- explicit typing here prevents literal narrowing issues -->
              let newStatus: InfluencerStatus = InfluencerStatus.PING_1;
              if (templateName === TEMPLATE_24H) {
                newStatus = InfluencerStatus.PING_2;
              } else if (templateName === TEMPLATE_48H) {
                newStatus = InfluencerStatus.PING_3;
              } else {
                newStatus = InfluencerStatus.PING_1;
              }

              await prisma.influencer.update({
                where: { id: data.influencerId },
                data: {
                  status: newStatus,
                  lastContactDate: new Date(),
                },
              });
            } catch (uErr) {
              console.warn(
                "[emailWorker] failed to update influencer pipeline:",
                data.influencerId,
                uErr
              );
            }
          }

          // Only schedule follow-ups when the job payload explicitly starts automation
          const shouldScheduleAutomation =
            result.success && !!(data.automation && data.automation.start);

          if (shouldScheduleAutomation && hasEmailId && data.influencerId) {
            const delay =
              process.env.NODE_ENV === "production"
                ? Number(process.env.PROD_FOLLOWUP_DELAY_MS)
                : Number(process.env.DEV_FOLLOWUP_DELAY_MS);

            try {
              const followUpJob = await followUpQueue.add(
                "follow-up-check",
                {
                  influencerId: data.influencerId,
                  emailRecordId: data.emailRecordId,
                  step: 1,
                  userId: data.userId,
                },
                {
                  delay,
                  attempts: 3,
                  backoff: { type: "exponential", delay: 10000 },
                }
              );

              // Persist scheduled job id
              try {
                await prisma.email.update({
                  where: { id: data.emailRecordId as string },
                  data: { scheduledJobId: String(followUpJob.id) },
                });
              } catch (uErr: any) {
                if (uErr?.code === "P2025") {
                  console.warn(
                    "[emailWorker] email record not found when saving scheduledJobId:",
                    data.emailRecordId
                  );
                } else {
                  console.error(
                    "[emailWorker] failed to persist scheduledJobId:",
                    uErr
                  );
                }
              }
            } catch (e) {
              console.warn(
                "[emailWorker] failed to schedule follow-up job:",
                e
              );
            }
          } else if (shouldScheduleAutomation && !hasEmailId) {
            console.warn(
              "[emailWorker] automation requested but emailRecordId missing; cannot schedule follow-ups",
              { jobId: job?.id, emailRecordId: data.emailRecordId }
            );
          }
        } catch (err) {
          console.error(
            "[emailWorker] error sending email:",
            normalizeError(err),
            {
              jobId: job?.id,
              emailRecordId: data.emailRecordId,
              to: data.to,
              influencerId: data.influencerId,
            }
          );

          // Persist failure to DB only if we have a record id
          if (hasEmailId) {
            try {
              await prisma.email.update({
                where: { id: data.emailRecordId as string },
                data: {
                  status: EmailStatus.FAILED,
                  attemptCount: { increment: 1 } as any,
                  errorMessage: normalizeError(err),
                },
              });
            } catch (uErr: any) {
              if (uErr?.code === "P2025") {
                console.warn(
                  "[emailWorker] email record not found when persisting failure:",
                  data.emailRecordId
                );
              } else {
                console.error("[emailWorker] failed to persist failure:", uErr);
              }
            }
          } else {
            console.warn(
              "[emailWorker] could not persist failure because emailRecordId is missing on job",
              { jobId: job?.id }
            );
          }

          // Re-throw so BullMQ marks job as failed (and retries may run)
          throw err;
        }
      },
      {
        connection,
        prefix,
        concurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY || 5),
      }
    );

    // instantiate follow-up worker (guard against scheduler/noop jobs there too)
    followUpWorker = new WorkerClass(
      "follow-up-queue",
      async (job: any) => {
        // skip scheduler/noop jobs similarly
        const jobName = job?.name ?? "";
        const jobId = job?.id ?? "";
        if (jobName && jobName.toString().includes("__scheduler")) {
          console.log("[followUpWorker] skipping scheduler/noop job", {
            jobId,
            jobName,
          });
          return;
        }
        if (typeof jobId === "string" && jobId.startsWith("repeat:")) {
          console.log("[followUpWorker] skipping repeat scheduler job", {
            jobId,
          });
          return;
        }

        // proceed with normal follow-up handling
        await checkForReplyAndHandle(job.data);
      },
      {
        connection,
        prefix,
        concurrency: Number(process.env.FOLLOWUP_WORKER_CONCURRENCY || 2),
      }
    );

    console.log("[redis-queue] Workers created and listening");
  } catch (err) {
    console.error("[redis-queue] Failed to instantiate workers:", err);
  }
};

// Start workers background (non-blocking)
startWorkers().catch((e) =>
  console.error("[redis-queue] startWorkers failed:", e)
);

/* ---------- Observability / helpers ---------- */
export const setupEventListeners = () => {
  if (emailWorker) {
    emailWorker.on("completed", (job: any) =>
      console.log("[redis-queue] email job completed:", job.id)
    );
    emailWorker.on("failed", (job: any, err: any) =>
      console.error("[redis-queue] email job failed:", job?.id, err)
    );
  } else {
    console.warn(
      "[redis-queue] setupEventListeners: emailWorker not ready yet"
    );
  }

  if (followUpWorker) {
    followUpWorker.on("completed", (job: any) =>
      console.log("[redis-queue] follow-up job completed:", job.id)
    );
    followUpWorker.on("failed", (job: any, err: any) =>
      console.error("[redis-queue] follow-up job failed:", job?.id, err)
    );
  } else {
    console.warn(
      "[redis-queue] setupEventListeners: followUpWorker not ready yet"
    );
  }
};

/* ---------- Enqueue helpers ---------- */
export const addEmailJob = async (data: EmailJobData, delayMs?: number) => {
  const isProd = process.env.NODE_ENV === "production";

  // fallback jitter when caller didn't request a specific delay
  const defaultJitter = isProd ? Math.floor(Math.random() * 30_000) : 0;
  const delay =
    typeof delayMs === "number"
      ? Math.max(0, Math.floor(delayMs))
      : defaultJitter;

  return await emailSendQueue.add("send-email", data, {
    delay,
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: true,
    removeOnFail: false,
  } as any);
};

/**
 * Add a batch of email jobs while spacing them by `intervalSec` seconds.
 *
 * IntervalSec: seconds between individual sends
 * JitterMs: optional per-job jitter to randomize exact timings.
 *
 * Returns array of job ids created.
 */
export const addBulkEmailJobs = async (
  jobsData: EmailJobData[],
  opts?: { intervalSec?: number; jitterMs?: number }
) => {
  const ids: string[] = [];
  if (!Array.isArray(jobsData) || jobsData.length === 0) return ids;

  const isProd = process.env.NODE_ENV === "production";

  // sensible defaults (you can override via env or opt param)
  const envInterval =
    Number(process.env.BULK_SEND_INTERVAL_SEC) ||
    (isProd ? 5 : Number(process.env.DEV_BULK_SEND_INTERVAL_SEC) || 2);

  const intervalSec =
    typeof opts?.intervalSec === "number" ? opts.intervalSec : envInterval;
  const jitterBoundMs =
    typeof opts?.jitterMs === "number" ? opts.jitterMs : isProd ? 2000 : 0;

  const total = jobsData.length;

  for (let i = 0; i < total; i++) {
    const job = jobsData[i];

    // Linear Spacing. job 0 => 0s, job 1 => intervalSec, job 2 => 2*intervalSec ...
    const baseDelayMs = Math.round(i * intervalSec * 1000);

    // adding slight jitter to avoid exact pattern
    const jitter = jitterBoundMs
      ? Math.floor(Math.random() * jitterBoundMs)
      : 0;

    const delayMs = Math.max(0, baseDelayMs + jitter);

    try {
      const qJob = await addEmailJob(job, delayMs);
      ids.push(String(qJob.id));
      console.log(
        `[addBulkEmailJobs] queued job ${String(
          qJob.id
        )} (delay=${delayMs}ms) for ${job.to}`
      );
    } catch (err) {
      console.error("[addBulkEmailJobs] failed to queue job:", err, {
        index: i,
        to: job.to,
      });
    }
  }

  return ids;
};

/* ---------- Cleanup ---------- */
export const cleanup = async () => {
  try {
    if (emailWorker) await emailWorker.close();
    if (followUpWorker) await followUpWorker.close();
    await emailSendQueue.close();
    await followUpQueue.close();
    await connection.quit();
  } catch (err) {
    console.warn("[redis-queue] cleanup error:", err);
  }
};

const redisQueue = {
  addEmailJob,
  addBulkEmailJobs,
  setupEventListeners,
  cleanup,
  emailSendQueue,
  followUpQueue,
};

export default redisQueue;
