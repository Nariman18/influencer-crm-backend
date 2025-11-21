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
import { getPrisma } from "../config/prisma";
import { sendMailgunEmail } from "./mailgun-client";
import { checkForReplyAndHandle } from "./followup-service";
import { copyToGmailSent } from "./gmail-sent-copy";
import { EmailStatus, InfluencerStatus } from "@prisma/client";

const prisma = getPrisma();

export type EmailJobData = {
  userId: string;
  to: string;
  subject: string;
  body: string;
  influencerName: string;
  emailRecordId?: string;
  influencerId?: string;
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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
};

const prefix = process.env.BULLMQ_PREFIX || "influencer-crm";
const rawRedisUrl = process.env.REDIS_URL;
if (!rawRedisUrl) {
  throw new Error("Missing REDIS_URL in environment");
}

const shouldUseTls =
  rawRedisUrl.startsWith("rediss://") ||
  String(process.env.REDIS_TLS_FORCE || "").toLowerCase() === "true";

const tlsRejectUnauthorized =
  String(process.env.REDIS_TLS_REJECT_UNAUTHORIZED || "").toLowerCase() !==
  "false";

const connection = (() => {
  try {
    const opts: any = {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    };
    if (shouldUseTls) {
      opts.tls = {
        rejectUnauthorized: tlsRejectUnauthorized,
        servername: new URL(rawRedisUrl).hostname,
      } as any;
    }
    const c = new IORedis(rawRedisUrl, opts);

    // helpful connection diagnostics for debugging
    c.on("connect", () => {
      console.log(
        "[redis-queue] ioredis connecting to",
        rawRedisUrl,
        "prefix:",
        prefix
      );
    });
    c.on("ready", () => {
      console.log("[redis-queue] ioredis ready");
    });
    c.on("error", (err: any) => {
      console.error(
        "[redis-queue] ioredis error:",
        err && err.message ? err.message : err
      );
    });
    return c;
  } catch (err) {
    console.error("[redis-queue] Failed to create ioredis connection", err);
    throw err;
  }
})();

/* ---------- bullmq dynamic resolve ---------- */
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

const dynamicResolve = async () => {
  try {
    const mod: any = await import("bullmq");
    const resolved = (mod && (mod.default || mod)) as any;
    QueueClass = QueueClass || resolved?.Queue;
    WorkerClass = WorkerClass || resolved?.Worker;
    QueueSchedulerClass = QueueSchedulerClass || resolved?.QueueScheduler;
    console.log("[redis-queue] resolved bullmq via dynamic import");
  } catch (err) {
    console.warn("[redis-queue] dynamic import('bullmq') failed:", err);
  }
};

/* ---------- Build queues ---------- */
const queueOpts = { connection, prefix };

export const emailSendQueue = QueueClass
  ? new QueueClass("email-send-queue", queueOpts)
  : ({
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

/* ---------- Scheduler helpers ---------- */
const tryUpsertScheduler = async (queue: any, schedulerId: string) => {
  if (!queue) return false;
  const fn = (queue as any).upsertJobScheduler;
  if (typeof fn !== "function") return false;

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
    await fn.call(queue, objForm);
    console.log(
      `[redis-queue] upsertJobScheduler invoked (object form) for ${queue.name}`
    );
    return true;
  } catch (errObj) {
    try {
      await fn.call(queue, schedulerId, objForm.repeat, objForm.job);
      console.log(
        `[redis-queue] upsertJobScheduler invoked (args form) for ${queue.name}`
      );
      return true;
    } catch (errArgs) {
      try {
        await fn.call(queue, schedulerId, objForm.repeat);
        console.log(
          `[redis-queue] upsertJobScheduler invoked (id, repeat) for ${queue.name}`
        );
        return true;
      } catch (errFinal) {
        console.warn(
          `[redis-queue] upsertJobScheduler exists but invocation attempts failed for queue ${queue.name}`,
          { errObj, errArgs, errFinal }
        );
        return false;
      }
    }
  }
};

const ensureSchedulers = async () => {
  if (!QueueClass || !WorkerClass || !QueueSchedulerClass) {
    await dynamicResolve();
  }

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
    }
  } catch (e) {
    console.warn("[redis-queue] error trying upsertJobScheduler:", e);
  }

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
      "[redis-queue] QueueScheduler not found — delayed jobs/retries may not run. " +
        "Either update bullmq or run a scheduler process."
    );
  }
};

ensureSchedulers().catch((e) => {
  console.warn("[redis-queue] ensureSchedulers error:", e);
});

/* ---------- Workers ---------- */
let emailWorker: any = null;
let followUpWorker: any = null;

const startWorkers = async () => {
  try {
    if (!WorkerClass) {
      await dynamicResolve();
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

    // ---------- email worker ----------
    emailWorker = new WorkerClass(
      "email-send-queue",
      async (job: any) => {
        const jobName = job?.name ?? "";
        const jobId = job?.id ?? "";
        const rawData = job?.data;

        if (jobName && jobName.toString().includes("__scheduler")) {
          console.log("[emailWorker] skipping scheduler/noop job", {
            jobId,
            jobName,
          });
          return;
        }
        if (typeof jobId === "string" && jobId.startsWith("repeat:")) {
          console.log("[emailWorker] skipping repeat scheduler job", { jobId });
          return;
        }

        const data =
          rawData && typeof rawData === "object"
            ? (rawData as EmailJobData)
            : ({} as EmailJobData);

        // job preview for debugging (small)
        console.log("[emailWorker] job received preview", {
          jobId,
          jobName,
          to: data.to,
          emailRecordId: data.emailRecordId,
        });

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

        if (!isValidEmail(data.to)) {
          const errMsg = `Invalid recipient address: ${String(data.to)}`;
          console.warn("[emailWorker] aborting send - invalid 'to':", errMsg, {
            jobId,
            emailRecordId: data.emailRecordId,
            influencerId: data.influencerId,
          });

          if (data.emailRecordId) {
            try {
              await prisma.email.update({
                where: { id: data.emailRecordId },
                data: {
                  status: EmailStatus.FAILED,
                  attemptCount: { increment: 1 } as any,
                  errorMessage: { set: errMsg },
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
          throw new Error(errMsg);
        }

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

          console.log("[emailWorker] persisting email result to DB", {
            emailRecordId: data.emailRecordId,
            success: result.success,
            mailgunId: result.id,
            mailgunMessageId: result.messageId,
            errorMessagePreview: result.error
              ? normalizeError(result.error)
              : null,
          });

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
                  mailgunMessageIdNormalized:
                    (result as any).messageIdNormalized || undefined,
                  attemptCount: { increment: 1 } as any,
                  ...(result.success
                    ? {}
                    : { errorMessage: { set: normalizeError(result.error) } }),
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
            console.warn(
              "[emailWorker] send result received but no emailRecordId provided on job; skipping DB persist",
              { jobId: job?.id, result }
            );
          }

          // Copy sent email to Gmail Sent folder
          if (result.success && data.userId) {
            try {
              const gmailCopyResult = await copyToGmailSent({
                userId: data.userId,
                to: data.to,
                subject: data.subject,
                htmlBody: data.body,
                replyTo: data.replyTo,
              });
              if (gmailCopyResult.success) {
                console.log("[emailWorker] Email copied to Gmail Sent folder", {
                  to: data.to,
                  gmailMessageId: gmailCopyResult.messageId,
                });
              } else {
                console.warn("[emailWorker] Failed to copy email to Gmail Sent:", gmailCopyResult.error);
              }
            } catch (gmailErr) {
              console.warn("[emailWorker] Error copying to Gmail Sent (non-fatal):", gmailErr);
            }
          }

          // update influencer pipeline if necessary
          if (result.success && data.influencerId) {
            try {
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

              let newStatus: InfluencerStatus = InfluencerStatus.PING_1;
              if (templateName === TEMPLATE_24H)
                newStatus = InfluencerStatus.PING_2;
              else if (templateName === TEMPLATE_48H)
                newStatus = InfluencerStatus.PING_3;
              else newStatus = InfluencerStatus.PING_1;

              await prisma.influencer.update({
                where: { id: data.influencerId },
                data: { status: newStatus, lastContactDate: new Date() },
              });
            } catch (uErr) {
              console.warn(
                "[emailWorker] failed to update influencer pipeline:",
                data.influencerId,
                uErr
              );
            }
          }

          // schedule follow-ups when requested
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

          if (hasEmailId) {
            try {
              await prisma.email.update({
                where: { id: data.emailRecordId as string },
                data: {
                  status: EmailStatus.FAILED,
                  attemptCount: { increment: 1 } as any,
                  errorMessage: { set: normalizeError(err) },
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

          throw err;
        }
      },
      {
        connection,
        prefix,
        concurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY || 5),
      }
    );

    // active / error handlers for emailWorker
    emailWorker.on("active", (job: any) => {
      console.log("[redis-queue] email job active:", {
        id: job.id,
        name: job.name,
        to: job.data?.to,
        emailRecordId: job.data?.emailRecordId,
      });
    });
    emailWorker.on("completed", (job: any) =>
      console.log("[redis-queue] email job completed:", job.id)
    );
    emailWorker.on("failed", (job: any, err: any) =>
      console.error("[redis-queue] email job failed:", job?.id, err)
    );
    emailWorker.on("error", (err: any) =>
      console.error("[redis-queue] emailWorker error event:", err)
    );

    // ---------- follow-up worker ----------
    followUpWorker = new WorkerClass(
      "follow-up-queue",
      async (job: any) => {
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
        console.log("[followUpWorker] processing follow-up job preview", {
          jobId,
          dataPreview: job.data && {
            influencerId: job.data.influencerId,
            emailRecordId: job.data.emailRecordId,
            step: job.data.step,
          },
        });
        await checkForReplyAndHandle(job.data);
      },
      {
        connection,
        prefix,
        concurrency: Number(process.env.FOLLOWUP_WORKER_CONCURRENCY || 2),
      }
    );

    followUpWorker.on("active", (job: any) => {
      console.log("[redis-queue] follow-up job active:", {
        id: job.id,
        name: job.name,
      });
    });
    followUpWorker.on("completed", (job: any) =>
      console.log("[redis-queue] follow-up job completed:", job.id)
    );
    followUpWorker.on("failed", (job: any, err: any) =>
      console.error("[redis-queue] follow-up job failed:", job?.id, err)
    );
    followUpWorker.on("error", (err: any) =>
      console.error("[redis-queue] followUpWorker error event:", err)
    );

    console.log("[redis-queue] Workers created and listening");
  } catch (err) {
    console.error("[redis-queue] Failed to instantiate workers:", err);
  }
};

if (String(process.env.RUN_WORKER || "").toLowerCase() === "true") {
  startWorkers().catch((e) =>
    console.error("[redis-queue] startWorkers failed:", e)
  );
} else {
  console.log(
    "[redis-queue] RUN_WORKER != true, workers will NOT start in this process"
  );
}

/* ---------- Enqueue helpers ---------- */
export const addEmailJob = async (data: EmailJobData, delayMs?: number) => {
  const isProd = process.env.NODE_ENV === "production";
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

export const addBulkEmailJobs = async (
  jobsData: EmailJobData[],
  opts?: { intervalSec?: number; jitterMs?: number }
) => {
  const ids: string[] = [];
  if (!Array.isArray(jobsData) || jobsData.length === 0) return ids;

  const isProd = process.env.NODE_ENV === "production";
  const envInterval =
    Number(process.env.BULK_SEND_INTERVAL_SEC) ||
    (isProd ? 5 : Number(process.env.DEV_BULK_SEND_INTERVAL_SEC) || 2);
  const intervalSec =
    typeof opts?.intervalSec === "number" ? opts.intervalSec : envInterval;
  const jitterBoundMs =
    typeof opts?.jitterMs === "number" ? opts.jitterMs : isProd ? 2000 : 0;

  const domainIntervalMap: Record<string, number> = {
    "hotmail.com": 20,
    "outlook.com": 20,
    "yahoo.com": 20,
    "yahoo.gr": 20,
    "gmail.com": 5,
    "mail.ru": 5,
    "panikrecords.gr": 20,
  };

  const domainFor = (email: string) =>
    (email.split("@").pop() || "").toLowerCase();
  const domainCounters: Record<string, number> = {};

  for (let i = 0; i < jobsData.length; i++) {
    const job = jobsData[i];
    try {
      const domain = domainFor(job.to || "");
      const perDomainIntervalSec = domainIntervalMap[domain] ?? intervalSec;
      const count = domainCounters[domain] || 0;
      const baseDelayMs = Math.round(count * perDomainIntervalSec * 1000);
      const jitter = jitterBoundMs
        ? Math.floor(Math.random() * jitterBoundMs)
        : 0;
      const delayMs = Math.max(0, baseDelayMs + jitter);

      const qJob = await addEmailJob(job, delayMs);
      ids.push(String(qJob.id));
      console.log(
        `[addBulkEmailJobs] queued job ${String(
          qJob.id
        )} (delay=${delayMs}ms) for ${job.to}`
      );

      domainCounters[domain] = count + 1;
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

/**
 * Backwards-compatible named export so other modules can call setupEventListeners()
 * (keeps the same behavior as older code that attached listeners from server start).
 */
export const setupEventListeners = () => {
  // email worker listeners
  if (emailWorker) {
    try {
      emailWorker.on("completed", (job: any) =>
        console.log("[redis-queue] email job completed:", job.id)
      );
      emailWorker.on("failed", (job: any, err: any) =>
        console.error("[redis-queue] email job failed:", job?.id, err)
      );
      emailWorker.on("active", (job: any) =>
        console.log("[redis-queue] email job active:", {
          id: job.id,
          to: job.data?.to,
          emailRecordId: job.data?.emailRecordId,
        })
      );
    } catch (e) {
      console.warn("[redis-queue] failed to attach emailWorker listeners:", e);
    }
  } else {
    console.warn(
      "[redis-queue] setupEventListeners: emailWorker not ready yet"
    );
  }

  // follow-up worker listeners
  if (followUpWorker) {
    try {
      followUpWorker.on("completed", (job: any) =>
        console.log("[redis-queue] follow-up job completed:", job.id)
      );
      followUpWorker.on("failed", (job: any, err: any) =>
        console.error("[redis-queue] follow-up job failed:", job?.id, err)
      );
      followUpWorker.on("active", (job: any) =>
        console.log("[redis-queue] follow-up job active:", {
          id: job.id,
          name: job.name,
        })
      );
    } catch (e) {
      console.warn(
        "[redis-queue] failed to attach followUpWorker listeners:",
        e
      );
    }
  } else {
    console.warn(
      "[redis-queue] setupEventListeners: followUpWorker not ready yet"
    );
  }
};

const redisQueue = {
  addEmailJob,
  addBulkEmailJobs,
  setupEventListeners: () => {
    // no-op (listeners attached when workers created), maintained for backward compatibility
  },
  cleanup,
  emailSendQueue,
  followUpQueue,
};

export default redisQueue;
