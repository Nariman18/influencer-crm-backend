// lib/redis-queue.ts
import { Queue, Worker, Job } from "bullmq";
import IORedis, { RedisOptions } from "ioredis";
import { EmailService } from "../controllers/email.controller";
import prisma from "../config/prisma";
import { EmailStatus, InfluencerStatus } from "@prisma/client";

export interface EmailJobData {
  userId: string;
  to: string;
  subject: string;
  body: string;
  influencerName: string;
  emailRecordId: string;
  influencerId: string;
}

class RedisQueueService {
  private connection: IORedis | null = null;
  public emailQueue: Queue<EmailJobData> | null = null;
  private worker: Worker<EmailJobData> | null = null;
  private isConnected: boolean = false;

  constructor() {
    this.initializeRedis();
  }

  private async initializeRedis() {
    try {
      const redisUrl = process.env.REDIS_URL;

      if (!redisUrl) {
        console.error("❌ REDIS_URL is not defined in environment variables");
        this.initializeFallback();
        return;
      }

      // Mask password for logging
      const maskedUrl = redisUrl.replace(/:([^:]+)@/, ":****@");
      console.log(`🔗 Attempting to connect to Redis: ${maskedUrl}`);

      const isRedisCloud =
        redisUrl.includes("redislabs.com") ||
        redisUrl.includes("redis-cloud.com") ||
        redisUrl.includes("redns.redis-cloud.com");

      // Try different connection strategies
      await this.tryRedisConnection(redisUrl, isRedisCloud);
    } catch (error) {
      console.error("❌ Failed to initialize Redis queue:", error);
      this.initializeFallback();
    }
  }

  private async tryRedisConnection(redisUrl: string, isRedisCloud: boolean) {
    console.log("🔄 Trying simple Redis connection...");

    try {
      // Use optimized Redis options for Redis Cloud
      const connection = new IORedis(redisUrl, {
        // BullMQ REQUIRES this to be null
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
        // Increase timeouts for Redis Cloud
        connectTimeout: 30000, // 30 seconds
        commandTimeout: 20000, // 20 seconds

        // Keep alive
        keepAlive: 30000,
      });

      // Test with ping
      const result = await connection.ping();
      console.log("✅ Redis ping response:", result);

      this.connection = connection;
      this.isConnected = true;
      console.log("✅ Redis connected successfully");

      this.setupConnectionEvents();
      this.initializeQueueAndWorker();
      return;
    } catch (error: any) {
      console.log("❌ Simple connection failed:", error.message);
      throw error;
    }
  }

  private getRedisOptions(
    useTLS: boolean,
    isRedisCloud: boolean
  ): RedisOptions {
    const baseOptions: RedisOptions = {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 3000,
    };

    if (useTLS && isRedisCloud) {
      return {
        ...baseOptions,
        tls: {
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined, // Skip hostname verification
        },
      };
    } else {
      return {
        ...baseOptions,
        tls: undefined,
      };
    }
  }

  private setupConnectionEvents() {
    if (!this.connection) return;

    this.connection.on("error", (error) => {
      console.error("❌ Redis connection error:", error.message);
      this.isConnected = false;
    });

    this.connection.on("close", () => {
      console.log("🔌 Redis connection closed");
      this.isConnected = false;
    });

    this.connection.on("end", () => {
      console.log("🔌 Redis connection ended");
      this.isConnected = false;
    });
  }

  private initializeQueueAndWorker() {
    if (!this.connection) {
      this.initializeFallback();
      return;
    }

    try {
      this.emailQueue = new Queue("email", {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 500,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
        },
      });

      this.worker = this.setupWorker();
      this.setupEventListeners();

      console.log("✅ Redis queue and worker initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize queue and worker:", error);
      this.initializeFallback();
    }
  }

  private initializeFallback() {
    console.warn("🔄 Initializing Redis queue in FALLBACK MODE...");
    console.warn("📧 All emails will be sent directly (no queueing)");

    this.isConnected = false;
    this.connection = null;
    this.emailQueue = null;
    this.worker = null;
  }

  private setupWorker(): Worker<EmailJobData> {
    if (!this.connection) {
      throw new Error("No Redis connection available for worker");
    }

    const worker = new Worker<EmailJobData>(
      "email",
      async (job: Job<EmailJobData>) => {
        const {
          userId,
          to,
          subject,
          body,
          influencerName,
          emailRecordId,
          influencerId,
        } = job.data;

        console.log(`📧 Processing email job ${job.id} to ${to}`);

        try {
          // Update email status to PROCESSING
          await prisma.email.update({
            where: { id: emailRecordId },
            data: { status: EmailStatus.PROCESSING },
          });

          // Send the email using your existing EmailService
          const result = await EmailService.sendEmail(
            userId,
            to,
            subject,
            body,
            influencerName
          );

          // Update email record with success
          await prisma.email.update({
            where: { id: emailRecordId },
            data: {
              status: EmailStatus.SENT,
              sentAt: result.sentAt,
            },
          });

          // Update influencer status
          await this.updateInfluencerStatus(influencerId);

          console.log(`✅ Completed email job ${job.id}`);
          return { success: true, messageId: result.messageId };
        } catch (error) {
          console.error(`❌ Failed email job ${job.id}:`, error);

          await prisma.email.update({
            where: { id: emailRecordId },
            data: {
              status: EmailStatus.FAILED,
              errorMessage:
                error instanceof Error ? error.message : "Unknown error",
            },
          });

          throw error;
        }
      },
      {
        connection: this.connection!,
        concurrency: 3,
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    return worker;
  }

  private async updateInfluencerStatus(influencerId: string) {
    try {
      const influencer = await prisma.influencer.findUnique({
        where: { id: influencerId },
      });

      if (!influencer) return;

      let newStatus = influencer.status;

      switch (influencer.status) {
        case InfluencerStatus.PING_1:
          newStatus = InfluencerStatus.PING_2;
          break;
        case InfluencerStatus.PING_2:
          newStatus = InfluencerStatus.PING_3;
          break;
      }

      await prisma.influencer.update({
        where: { id: influencerId },
        data: {
          lastContactDate: new Date(),
          status: newStatus,
        },
      });
    } catch (error) {
      console.error("Failed to update influencer status:", error);
    }
  }

  async addEmailJob(
    jobData: EmailJobData,
    delayMs: number = 0
  ): Promise<string> {
    if (!this.isConnected || !this.emailQueue) {
      console.warn("⚠️ Redis not connected, falling back to direct email send");
      return this.fallbackToDirectSend(jobData);
    }

    try {
      const job = await this.emailQueue.add("send-email", jobData, {
        delay: delayMs,
      });

      await prisma.email.update({
        where: { id: jobData.emailRecordId },
        data: { status: EmailStatus.QUEUED },
      });

      console.log(`📨 Email job queued: ${job.id} for ${jobData.to}`);
      return job.id!;
    } catch (error) {
      console.error(
        "❌ Failed to queue email, falling back to direct send:",
        error
      );
      return this.fallbackToDirectSend(jobData);
    }
  }

  private async fallbackToDirectSend(jobData: EmailJobData): Promise<string> {
    console.log("🔄 Falling back to direct email send");

    try {
      const result = await EmailService.sendEmail(
        jobData.userId,
        jobData.to,
        jobData.subject,
        jobData.body,
        jobData.influencerName
      );

      await prisma.email.update({
        where: { id: jobData.emailRecordId },
        data: {
          status: EmailStatus.SENT,
          sentAt: result.sentAt,
        },
      });

      await this.updateInfluencerStatus(jobData.influencerId);

      console.log("✅ Email sent directly (fallback)");
      return `direct-${Date.now()}`;
    } catch (error) {
      console.error("❌ Direct email send failed:", error);

      await prisma.email.update({
        where: { id: jobData.emailRecordId },
        data: {
          status: EmailStatus.FAILED,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
      });

      throw error;
    }
  }

  async getQueueStats() {
    if (!this.isConnected) {
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        total: 0,
        status: "disconnected",
      };
    }

    try {
      if (!this.emailQueue) {
        throw new Error("Email queue not initialized");
      }

      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.emailQueue.getWaiting(),
        this.emailQueue.getActive(),
        this.emailQueue.getCompleted(),
        this.emailQueue.getFailed(),
        this.emailQueue.getDelayed(),
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
        total:
          waiting.length +
          active.length +
          completed.length +
          failed.length +
          delayed.length,
        status: "connected",
      };
    } catch (error) {
      console.error("Failed to get queue stats:", error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        total: 0,
        status: "error",
      };
    }
  }

  async cleanup() {
    try {
      if (this.worker) {
        await this.worker.close();
      }
      if (this.emailQueue) {
        await this.emailQueue.close();
      }
      if (this.connection) {
        await this.connection.quit();
      }
    } catch (error) {
      console.error("Error during queue cleanup:", error);
    }
  }

  setupEventListeners() {
    if (!this.worker) return;

    this.worker.on("completed", (job) => {
      console.log(`✅ Job ${job.id} completed successfully`);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`❌ Job ${job?.id} failed:`, err.message);
    });

    this.worker.on("stalled", (jobId) => {
      console.warn(`⚠️ Job ${jobId} stalled`);
    });

    this.worker.on("error", (err) => {
      console.error("❌ Worker error:", err.message);
    });
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
export const redisQueue = new RedisQueueService();
