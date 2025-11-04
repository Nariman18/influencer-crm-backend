// lib/redis-queue.ts - DYNAMIC VERSION
import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
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

  // Dynamic configuration based on daily volume
  private readonly CONFIG = {
    MAX_DAILY_EMAILS: 2000, // Absolute maximum
    BATCH_SIZE: 20,
  };

  // Tracking
  private dailyCount: number = 0;
  private lastReset: Date = new Date();

  constructor() {
    this.initializeRedis();
    this.startDailyResetInterval();
  }

  /**
   * DYNAMIC RATE LIMITING - Adapts based on daily volume
   */
  private getDynamicConfig() {
    const usageRatio = this.dailyCount / this.CONFIG.MAX_DAILY_EMAILS;

    if (usageRatio > 0.8) {
      // High volume mode: Near daily limit
      return {
        maxConcurrent: 1,
        delayBetweenEmails: 120000, // 2 minutes
        retryDelay: 1800000, // 30 minutes if rate limited
        mode: "HIGH_VOLUME" as const,
      };
    } else if (usageRatio > 0.5) {
      // Medium volume mode: Half daily limit used
      return {
        maxConcurrent: 2,
        delayBetweenEmails: 45000, // 45 seconds
        retryDelay: 900000, // 15 minutes if rate limited
        mode: "MEDIUM_VOLUME" as const,
      };
    } else if (usageRatio > 0.2) {
      // Low volume mode: Just started sending
      return {
        maxConcurrent: 3,
        delayBetweenEmails: 20000, // 20 seconds
        retryDelay: 300000, // 5 minutes if rate limited
        mode: "LOW_VOLUME" as const,
      };
    } else {
      // Minimal volume mode: Sending very few emails
      return {
        maxConcurrent: 4,
        delayBetweenEmails: 5000, // 5 seconds
        retryDelay: 120000, // 2 minutes if rate limited
        mode: "MINIMAL_VOLUME" as const,
      };
    }
  }

  private async initializeRedis() {
    try {
      const redisUrl = process.env.REDIS_URL;

      if (!redisUrl) {
        console.error("❌ REDIS_URL is not defined");
        this.initializeFallback();
        return;
      }

      console.log(`🔗 Connecting to Redis...`);

      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 30000,
        commandTimeout: 20000,
      });

      await connection.ping();
      this.connection = connection;
      this.isConnected = true;
      console.log("✅ Redis connected successfully");

      this.setupConnectionEvents();
      await this.initializeQueueAndWorker();
      await this.restoreDailyCounter();
    } catch (error) {
      console.error("❌ Failed to initialize Redis queue:", error);
      this.initializeFallback();
    }
  }

  private setupConnectionEvents() {
    if (!this.connection) return;

    this.connection.on("error", (error) => {
      console.error("Redis connection error:", error.message);
      this.isConnected = false;
    });

    this.connection.on("connect", () => {
      console.log("🔗 Redis connection established");
      this.isConnected = true;
    });
  }

  private async initializeQueueAndWorker() {
    if (!this.connection) {
      this.initializeFallback();
      return;
    }

    try {
      this.emailQueue = new Queue("email", {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: 500,
          removeOnFail: 500,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 30000,
          },
        },
      });

      this.worker = this.setupWorker();
      this.setupEventListeners();

      console.log("✅ Dynamic Redis queue system initialized");
    } catch (error) {
      console.error("❌ Failed to initialize queue system:", error);
      this.initializeFallback();
    }
  }

  private setupWorker(): Worker<EmailJobData> {
    if (!this.connection) {
      throw new Error("No Redis connection available for worker");
    }

    const worker = new Worker<EmailJobData>(
      "email",
      async (job: Job<EmailJobData>) => {
        await this.processEmailJob(job);
      },
      {
        connection: this.connection,
        // Dynamic concurrency - will be updated based on volume
        concurrency: this.getDynamicConfig().maxConcurrent,
      }
    );

    return worker;
  }

  private async processEmailJob(job: Job<EmailJobData>) {
    const {
      userId,
      to,
      subject,
      body,
      influencerName,
      emailRecordId,
      influencerId,
    } = job.data;

    const dynamicConfig = this.getDynamicConfig();

    console.log(
      `📧 Processing email job ${job.id} to ${to} [Mode: ${dynamicConfig.mode}]`
    );

    try {
      // Update email status to processing
      await prisma.email.update({
        where: { id: emailRecordId },
        data: { status: EmailStatus.PROCESSING },
      });

      // Dynamic delay based on current volume
      console.log(
        `⏳ Applying ${dynamicConfig.delayBetweenEmails / 1000}s delay (Mode: ${
          dynamicConfig.mode
        })`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, dynamicConfig.delayBetweenEmails)
      );

      // Send the email
      const result = await EmailService.sendEmail(
        userId,
        to,
        subject,
        body,
        influencerName
      );

      // Update counters
      this.dailyCount++;
      await this.saveDailyCounter();

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

      console.log(
        `✅ Completed email job ${job.id} (Daily: ${this.dailyCount}/${this.CONFIG.MAX_DAILY_EMAILS}, Mode: ${dynamicConfig.mode})`
      );
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error(`❌ Failed email job ${job.id}:`, error);

      // Dynamic retry delay based on volume
      if (this.isRateLimitError(error)) {
        console.warn(
          `🚨 Gmail rate limit detected, delaying for ${
            dynamicConfig.retryDelay / 1000 / 60
          } minutes`
        );
        await job.moveToDelayed(Date.now() + dynamicConfig.retryDelay);
        return;
      }

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
  }

  private isRateLimitError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || "";
    return (
      errorMessage.includes("rate limit") ||
      errorMessage.includes("quota exceeded") ||
      errorMessage.includes("too many requests") ||
      error?.code === 429
    );
  }

  private async saveDailyCounter() {
    if (!this.connection || !this.isConnected) return;

    try {
      await this.connection.setex(
        "email:daily_count",
        86400, // 24 hours
        this.dailyCount.toString()
      );
    } catch (error) {
      console.error("Failed to save daily counter:", error);
    }
  }

  private async restoreDailyCounter() {
    if (!this.connection || !this.isConnected) return;

    try {
      const daily = await this.connection.get("email:daily_count");
      this.dailyCount = daily ? parseInt(daily) : 0;
      console.log(`📊 Restored daily counter: ${this.dailyCount}`);
    } catch (error) {
      console.error("Failed to restore daily counter:", error);
    }
  }

  private startDailyResetInterval() {
    // Reset daily counter at midnight
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        this.dailyCount = 0;
        console.log("🔄 Daily email counter reset");
        this.saveDailyCounter();
      }
    }, 60000); // Check every minute
  }

  async addEmailJob(jobData: EmailJobData): Promise<string> {
    if (!this.isConnected || !this.emailQueue) {
      console.warn("⚠️ Redis not connected, falling back to direct email send");
      return this.fallbackToDirectSend(jobData);
    }

    try {
      const job = await this.emailQueue.add("send-email", jobData);

      await prisma.email.update({
        where: { id: jobData.emailRecordId },
        data: { status: EmailStatus.QUEUED },
      });

      console.log(`📨 Email job queued: ${job.id} for ${jobData.to}`);
      return job.id!;
    } catch (error) {
      console.error("❌ Failed to queue email:", error);
      return this.fallbackToDirectSend(jobData);
    }
  }

  async addBulkEmailJobs(jobsData: EmailJobData[]): Promise<string[]> {
    if (!this.isConnected || !this.emailQueue) {
      console.warn("⚠️ Redis not connected, falling back to direct processing");
      return this.fallbackBulkSend(jobsData);
    }

    const jobIds: string[] = [];
    const dynamicConfig = this.getDynamicConfig();

    try {
      for (let i = 0; i < jobsData.length; i += this.CONFIG.BATCH_SIZE) {
        const batch = jobsData.slice(i, i + this.CONFIG.BATCH_SIZE);
        const jobs = batch.map((jobData, index) => ({
          name: "send-email",
          data: jobData,
          opts: {
            delay: index * (dynamicConfig.delayBetweenEmails / 2), // Stagger within batch
          },
        }));

        const addedJobs = await this.emailQueue.addBulk(jobs);

        await Promise.all(
          batch.map((jobData) =>
            prisma.email.update({
              where: { id: jobData.emailRecordId },
              data: { status: EmailStatus.QUEUED },
            })
          )
        );

        addedJobs.forEach((job) => {
          if (job.id) jobIds.push(job.id);
        });

        console.log(
          `📨 Queued batch ${i / this.CONFIG.BATCH_SIZE + 1} with ${
            batch.length
          } emails [Mode: ${dynamicConfig.mode}]`
        );

        // Dynamic delay between batches
        if (i + this.CONFIG.BATCH_SIZE < jobsData.length) {
          await new Promise((resolve) =>
            setTimeout(resolve, dynamicConfig.delayBetweenEmails * 2)
          );
        }
      }

      console.log(`✅ Successfully queued ${jobIds.length} email jobs`);
      return jobIds;
    } catch (error) {
      console.error("❌ Failed to bulk queue emails:", error);
      return this.fallbackBulkSend(jobsData);
    }
  }

  private async fallbackBulkSend(jobsData: EmailJobData[]): Promise<string[]> {
    const jobIds: string[] = [];
    const dynamicConfig = this.getDynamicConfig();

    console.log("🔄 Processing bulk emails in fallback mode...");

    for (const jobData of jobsData) {
      try {
        const jobId = await this.fallbackToDirectSend(jobData);
        jobIds.push(jobId);

        // Dynamic delay in fallback mode
        await new Promise((resolve) =>
          setTimeout(resolve, dynamicConfig.delayBetweenEmails)
        );
      } catch (error) {
        console.error(`Failed to send email to ${jobData.to}:`, error);
        jobIds.push(`failed-${Date.now()}`);
      }
    }

    return jobIds;
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

      this.dailyCount++;
      await this.saveDailyCounter();

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
        case InfluencerStatus.PING_3:
          newStatus = InfluencerStatus.CONTRACT;
          break;
        default:
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

  async getEnhancedQueueStats() {
    const basicStats = await this.getQueueStats();
    const dynamicConfig = this.getDynamicConfig();

    return {
      ...basicStats,
      dailyUsage: {
        used: this.dailyCount,
        limit: this.CONFIG.MAX_DAILY_EMAILS,
        remaining: this.CONFIG.MAX_DAILY_EMAILS - this.dailyCount,
        usagePercentage: Math.round(
          (this.dailyCount / this.CONFIG.MAX_DAILY_EMAILS) * 100
        ),
      },
      currentMode: dynamicConfig.mode,
      configuration: {
        maxConcurrent: dynamicConfig.maxConcurrent,
        delayBetweenEmails: dynamicConfig.delayBetweenEmails,
        retryDelay: dynamicConfig.retryDelay,
      },
    };
  }

  // ... (rest of the methods remain the same: pauseQueue, resumeQueue, cleanup, setupEventListeners, etc.)
  private initializeFallback() {
    console.warn("🔄 Initializing Redis queue in FALLBACK MODE...");
    console.warn("📧 All emails will be sent directly (no queueing)");

    this.isConnected = false;
    this.connection = null;
    this.emailQueue = null;
    this.worker = null;
  }

  async pauseQueue(): Promise<void> {
    if (this.worker) {
      await this.worker.pause();
      console.log("⏸️ Email queue paused");
    }
  }

  async resumeQueue(): Promise<void> {
    if (this.worker) {
      await this.worker.resume();
      console.log("▶️ Email queue resumed");
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
