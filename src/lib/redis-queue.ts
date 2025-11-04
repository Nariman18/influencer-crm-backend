// lib/redis-queue.ts
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

  // Rate limiting configuration for Gmail Business (2000/day = ~83/hour = ~1.38/minute)
  private readonly RATE_LIMITS = {
    MAX_DAILY_EMAILS: 1000, // Conservative limit
    MAX_HOURLY_EMAILS: 42, // 1000/24 ≈ 42 per hour
    MAX_CONCURRENT_JOBS: 2, // Be gentle with Gmail
    DELAY_BETWEEN_EMAILS: 90000, // 90 seconds between emails
    BATCH_SIZE: 50, // Process in small batches
  };

  // Tracking for rate limiting
  private dailyCount: number = 0;
  private hourlyCount: number = 0;
  private lastReset: Date = new Date();

  constructor() {
    this.initializeRedis();
    this.startRateLimitResetInterval();
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

      await this.tryRedisConnection(redisUrl);
    } catch (error) {
      console.error("❌ Failed to initialize Redis queue:", error);
      this.initializeFallback();
    }
  }

  private async tryRedisConnection(redisUrl: string) {
    console.log("🔄 Trying Redis connection...");

    try {
      // Use simplified Redis options - remove unsupported properties
      const connection = new IORedis(redisUrl, {
        // BullMQ REQUIRES this to be null
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        // Increase timeouts
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
      await this.initializeQueueAndWorker();
    } catch (error: any) {
      console.log("Redis connection failed:", error.message);
      throw error;
    }
  }

  private setupConnectionEvents() {
    if (!this.connection) return;

    this.connection.on("error", (error) => {
      console.error("Redis connection error:", error.message);
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
      // Initialize main email queue without QueueScheduler
      this.emailQueue = new Queue("email", {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: 1000, // Keep more completed jobs for monitoring
          removeOnFail: 1000,
          attempts: 5, // More retries for temporary failures
          backoff: {
            type: "exponential",
            delay: 60000, // Start with 1 minute delay
          },
          delay: this.calculateDynamicDelay(), // Dynamic delay based on rate limits
        },
      });

      this.worker = this.setupWorker();
      this.setupEventListeners();

      // Restore rate limit counters from Redis on startup
      await this.restoreRateLimitCounters();

      console.log("✅ Advanced Redis queue system initialized");
    } catch (error) {
      console.error("❌ Failed to initialize queue system:", error);
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
        await this.processEmailJob(job);
      },
      {
        connection: this.connection,
        concurrency: this.RATE_LIMITS.MAX_CONCURRENT_JOBS,
        limiter: {
          max: this.RATE_LIMITS.MAX_HOURLY_EMAILS,
          duration: 3600000, // 1 hour in milliseconds
        },
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

    console.log(`📧 Processing email job ${job.id} to ${to}`);

    // Check rate limits before processing
    if (!this.canSendEmail()) {
      const delay = this.calculateRetryDelay();
      console.log(
        `⏳ Rate limit reached, delaying job ${job.id} by ${delay}ms`
      );
      await job.moveToDelayed(Date.now() + delay);
      return;
    }

    try {
      // Update email status to processing
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

      // Update counters
      this.incrementCounters();

      // Email record with success
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
        `✅ Completed email job ${job.id} (Daily: ${this.dailyCount}/${this.RATE_LIMITS.MAX_DAILY_EMAILS})`
      );
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error(`❌ Failed email job ${job.id}:`, error);

      // Check if it's a rate limit error from Gmail
      if (this.isRateLimitError(error)) {
        console.warn(`🚨 Gmail rate limit detected, pausing queue temporarily`);
        await this.handleRateLimitExceeded(job);
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

  private canSendEmail(): boolean {
    const now = new Date();
    const hoursSinceReset =
      (now.getTime() - this.lastReset.getTime()) / (1000 * 60 * 60);

    // Reset hourly counter if more than 1 hour passed
    if (hoursSinceReset >= 1) {
      this.hourlyCount = 0;
      this.lastReset = now;
    }

    return (
      this.dailyCount < this.RATE_LIMITS.MAX_DAILY_EMAILS &&
      this.hourlyCount < this.RATE_LIMITS.MAX_HOURLY_EMAILS
    );
  }

  private incrementCounters() {
    this.dailyCount++;
    this.hourlyCount++;

    // Persist counters to Redis for durability
    this.saveRateLimitCounters();
  }

  private calculateDynamicDelay(): number {
    // Increase delay as we approach daily limits
    const usageRatio = this.dailyCount / this.RATE_LIMITS.MAX_DAILY_EMAILS;

    if (usageRatio > 0.8) {
      return 300000; // 5 minutes when near limit
    } else if (usageRatio > 0.5) {
      return 180000; // 3 minutes when half used
    } else {
      return this.RATE_LIMITS.DELAY_BETWEEN_EMAILS; // Normal delay
    }
  }

  private calculateRetryDelay(): number {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);

    return nextHour.getTime() - now.getTime();
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

  private async handleRateLimitExceeded(job: Job<EmailJobData>) {
    // Move job to delayed state for 1 hour
    await job.moveToDelayed(Date.now() + 3600000);

    // Reduce concurrency temporarily
    if (this.worker) {
      this.worker.concurrency = 1;

      // Restore normal concurrency after 2 hours
      setTimeout(() => {
        if (this.worker) {
          this.worker.concurrency = this.RATE_LIMITS.MAX_CONCURRENT_JOBS;
          console.log("🔄 Restored normal concurrency after rate limit");
        }
      }, 7200000);
    }
  }

  private async saveRateLimitCounters() {
    if (!this.connection || !this.isConnected) return;

    try {
      await this.connection.setex(
        "email:rate_limit:daily_count",
        86400, // 24 hours TTL
        this.dailyCount.toString()
      );
      await this.connection.setex(
        "email:rate_limit:hourly_count",
        3600, // 1 hour TTL
        this.hourlyCount.toString()
      );
      await this.connection.setex(
        "email:rate_limit:last_reset",
        3600,
        this.lastReset.toISOString()
      );
    } catch (error) {
      console.error("Failed to save rate limit counters:", error);
    }
  }

  private async restoreRateLimitCounters() {
    if (!this.connection || !this.isConnected) return;

    try {
      const [daily, hourly, lastReset] = await Promise.all([
        this.connection.get("email:rate_limit:daily_count"),
        this.connection.get("email:rate_limit:hourly_count"),
        this.connection.get("email:rate_limit:last_reset"),
      ]);

      this.dailyCount = daily ? parseInt(daily) : 0;
      this.hourlyCount = hourly ? parseInt(hourly) : 0;
      this.lastReset = lastReset ? new Date(lastReset) : new Date();

      console.log(
        `📊 Restored rate limits - Daily: ${this.dailyCount}, Hourly: ${this.hourlyCount}`
      );
    } catch (error) {
      console.error("Failed to restore rate limit counters:", error);
    }
  }

  private startRateLimitResetInterval() {
    // Reset daily counter at midnight
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        this.dailyCount = 0;
        console.log("🔄 Daily email counter reset");
        this.saveRateLimitCounters();
      }
    }, 60000); // Check every minute

    // Reset hourly counter every hour
    setInterval(() => {
      this.hourlyCount = 0;
      this.lastReset = new Date();
      this.saveRateLimitCounters();
    }, 3600000); // Every hour
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
        delay: delayMs > 0 ? delayMs : this.calculateDynamicDelay(),
      });

      // Update email record to QUEUED status
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

  async addBulkEmailJobs(jobsData: EmailJobData[]): Promise<string[]> {
    if (!this.isConnected || !this.emailQueue) {
      console.warn("⚠️ Redis not connected, falling back to direct processing");
      return this.fallbackBulkSend(jobsData);
    }

    const jobIds: string[] = [];

    try {
      // Process in batches to avoid overwhelming the system
      for (let i = 0; i < jobsData.length; i += this.RATE_LIMITS.BATCH_SIZE) {
        const batch = jobsData.slice(i, i + this.RATE_LIMITS.BATCH_SIZE);
        const jobs = batch.map((jobData, index) => ({
          name: "send-email",
          data: jobData,
          opts: {
            delay:
              this.calculateDynamicDelay() *
              (i / this.RATE_LIMITS.BATCH_SIZE + index * 0.1), // Stagger batches
          },
        }));

        const addedJobs = await this.emailQueue.addBulk(jobs);

        // Update email records to QUEUED status
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
          `📨 Queued batch ${i / this.RATE_LIMITS.BATCH_SIZE + 1} with ${
            batch.length
          } emails`
        );

        // Small delay between batches
        if (i + this.RATE_LIMITS.BATCH_SIZE < jobsData.length) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
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

    console.log("🔄 Processing bulk emails in fallback mode...");

    for (const jobData of jobsData) {
      try {
        if (!this.canSendEmail()) {
          console.log("⏳ Rate limit reached in fallback mode, pausing...");
          await new Promise((resolve) =>
            setTimeout(resolve, this.calculateRetryDelay())
          );
        }

        const jobId = await this.fallbackToDirectSend(jobData);
        jobIds.push(jobId);

        // Rate limiting in fallback mode
        await new Promise((resolve) =>
          setTimeout(resolve, this.RATE_LIMITS.DELAY_BETWEEN_EMAILS)
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

      // Update counters even in fallback mode
      this.incrementCounters();

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
          // Don't change status if already in CONTRACT, REJECTED, or COMPLETED
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

    return {
      ...basicStats,
      rateLimits: {
        daily: {
          used: this.dailyCount,
          limit: this.RATE_LIMITS.MAX_DAILY_EMAILS,
          remaining: this.RATE_LIMITS.MAX_DAILY_EMAILS - this.dailyCount,
        },
        hourly: {
          used: this.hourlyCount,
          limit: this.RATE_LIMITS.MAX_HOURLY_EMAILS,
          remaining: this.RATE_LIMITS.MAX_HOURLY_EMAILS - this.hourlyCount,
        },
      },
      nextReset: new Date(this.lastReset.getTime() + 3600000), // Next hourly reset
      configuration: {
        maxConcurrent: this.RATE_LIMITS.MAX_CONCURRENT_JOBS,
        delayBetweenEmails: this.RATE_LIMITS.DELAY_BETWEEN_EMAILS,
        batchSize: this.RATE_LIMITS.BATCH_SIZE,
      },
    };
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

    this.worker.on("progress", (job) => {
      console.log(`📊 Job ${job.id} progress:`, job.progress);
    });
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  getRateLimitStatus() {
    return {
      daily: {
        used: this.dailyCount,
        limit: this.RATE_LIMITS.MAX_DAILY_EMAILS,
        remaining: this.RATE_LIMITS.MAX_DAILY_EMAILS - this.dailyCount,
      },
      hourly: {
        used: this.hourlyCount,
        limit: this.RATE_LIMITS.MAX_HOURLY_EMAILS,
        remaining: this.RATE_LIMITS.MAX_HOURLY_EMAILS - this.hourlyCount,
      },
    };
  }
}

// Singleton instance
export const redisQueue = new RedisQueueService();
