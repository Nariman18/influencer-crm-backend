"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisQueue = void 0;
// lib/redis-queue.ts
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const email_controller_1 = require("../controllers/email.controller");
const prisma_1 = __importDefault(require("../config/prisma"));
const client_1 = require("@prisma/client");
class RedisQueueService {
    constructor() {
        this.connection = null;
        this.emailQueue = null;
        this.worker = null;
        this.isConnected = false;
        this.initializeRedis();
    }
    async initializeRedis() {
        try {
            const redisUrl = process.env.REDIS_URL;
            if (!redisUrl) {
                console.error("REDIS_URL is not defined in environment variables");
                this.initializeFallback();
                return;
            }
            // Mask password for logging
            const maskedUrl = redisUrl.replace(/:([^:]+)@/, ":****@");
            console.log(`Attempting to connect to Redis: ${maskedUrl}`);
            const isRedisCloud = redisUrl.includes("redislabs.com") ||
                redisUrl.includes("redis-cloud.com") ||
                redisUrl.includes("redns.redis-cloud.com");
            // Try different connection strategies
            await this.tryRedisConnection(redisUrl, isRedisCloud);
        }
        catch (error) {
            console.error("Failed to initialize Redis queue:", error);
            this.initializeFallback();
        }
    }
    async tryRedisConnection(redisUrl, isRedisCloud) {
        console.log("Trying simple Redis connection...");
        try {
            // Use optimized Redis options for Redis Cloud
            const connection = new ioredis_1.default(redisUrl, {
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
            console.log("Redis ping response:", result);
            this.connection = connection;
            this.isConnected = true;
            console.log("Redis connected successfully");
            this.setupConnectionEvents();
            this.initializeQueueAndWorker();
            return;
        }
        catch (error) {
            console.log("Simple connection failed:", error.message);
            throw error;
        }
    }
    setupConnectionEvents() {
        if (!this.connection)
            return;
        this.connection.on("error", (error) => {
            console.error("Redis connection error:", error.message);
            this.isConnected = false;
        });
        this.connection.on("close", () => {
            console.log("Redis connection closed");
            this.isConnected = false;
        });
        this.connection.on("end", () => {
            console.log("Redis connection ended");
            this.isConnected = false;
        });
    }
    initializeQueueAndWorker() {
        if (!this.connection) {
            this.initializeFallback();
            return;
        }
        try {
            this.emailQueue = new bullmq_1.Queue("email", {
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
            console.log("Redis queue and worker initialized successfully");
        }
        catch (error) {
            console.error("Failed to initialize queue and worker:", error);
            this.initializeFallback();
        }
    }
    initializeFallback() {
        console.warn("Initializing Redis queue in FALLBACK MODE...");
        console.warn("All emails will be sent directly (no queueing)");
        this.isConnected = false;
        this.connection = null;
        this.emailQueue = null;
        this.worker = null;
    }
    setupWorker() {
        if (!this.connection) {
            throw new Error("No Redis connection available for worker");
        }
        const worker = new bullmq_1.Worker("email", async (job) => {
            const { userId, to, subject, body, influencerName, emailRecordId, influencerId, } = job.data;
            console.log(`Processing email job ${job.id} to ${to}`);
            try {
                // Use proper EmailStatus enum values
                await prisma_1.default.email.update({
                    where: { id: emailRecordId },
                    data: { status: client_1.EmailStatus.PROCESSING },
                });
                // Send the email using your existing EmailService
                const result = await email_controller_1.EmailService.sendEmail(userId, to, subject, body, influencerName);
                // Email record with success
                await prisma_1.default.email.update({
                    where: { id: emailRecordId },
                    data: {
                        status: client_1.EmailStatus.SENT,
                        sentAt: result.sentAt,
                    },
                });
                // Update influencer status
                await this.updateInfluencerStatus(influencerId);
                console.log(`Completed email job ${job.id}`);
                return { success: true, messageId: result.messageId };
            }
            catch (error) {
                console.error(`Failed email job ${job.id}:`, error);
                await prisma_1.default.email.update({
                    where: { id: emailRecordId },
                    data: {
                        status: client_1.EmailStatus.FAILED,
                        errorMessage: error instanceof Error ? error.message : "Unknown error",
                    },
                });
                throw error;
            }
        }, {
            connection: this.connection,
            concurrency: 3,
            limiter: {
                max: 10,
                duration: 60000,
            },
        });
        return worker;
    }
    async updateInfluencerStatus(influencerId) {
        try {
            const influencer = await prisma_1.default.influencer.findUnique({
                where: { id: influencerId },
            });
            if (!influencer)
                return;
            let newStatus = influencer.status;
            switch (influencer.status) {
                case client_1.InfluencerStatus.PING_1:
                    newStatus = client_1.InfluencerStatus.PING_2;
                    break;
                case client_1.InfluencerStatus.PING_2:
                    newStatus = client_1.InfluencerStatus.PING_3;
                    break;
                case client_1.InfluencerStatus.PING_3:
                    newStatus = client_1.InfluencerStatus.CONTRACT;
                    break;
                default:
                    // Don't change status if already in CONTRACT, REJECTED, or COMPLETED
                    break;
            }
            await prisma_1.default.influencer.update({
                where: { id: influencerId },
                data: {
                    lastContactDate: new Date(),
                    status: newStatus,
                },
            });
        }
        catch (error) {
            console.error("Failed to update influencer status:", error);
        }
    }
    async addEmailJob(jobData, delayMs = 0) {
        if (!this.isConnected || !this.emailQueue) {
            console.warn("⚠️ Redis not connected, falling back to direct email send");
            return this.fallbackToDirectSend(jobData);
        }
        try {
            const job = await this.emailQueue.add("send-email", jobData, {
                delay: delayMs,
            });
            // Use proper EmailStatus enum value
            await prisma_1.default.email.update({
                where: { id: jobData.emailRecordId },
                data: { status: client_1.EmailStatus.QUEUED },
            });
            console.log(`📨 Email job queued: ${job.id} for ${jobData.to}`);
            return job.id;
        }
        catch (error) {
            console.error("Failed to queue email, falling back to direct send:", error);
            return this.fallbackToDirectSend(jobData);
        }
    }
    async fallbackToDirectSend(jobData) {
        console.log("🔄 Falling back to direct email send");
        try {
            const result = await email_controller_1.EmailService.sendEmail(jobData.userId, jobData.to, jobData.subject, jobData.body, jobData.influencerName);
            await prisma_1.default.email.update({
                where: { id: jobData.emailRecordId },
                data: {
                    status: client_1.EmailStatus.SENT,
                    sentAt: result.sentAt,
                },
            });
            await this.updateInfluencerStatus(jobData.influencerId);
            console.log("Email sent directly (fallback)");
            return `direct-${Date.now()}`;
        }
        catch (error) {
            console.error("Direct email send failed:", error);
            await prisma_1.default.email.update({
                where: { id: jobData.emailRecordId },
                data: {
                    status: client_1.EmailStatus.FAILED,
                    errorMessage: error instanceof Error ? error.message : "Unknown error",
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
                total: waiting.length +
                    active.length +
                    completed.length +
                    failed.length +
                    delayed.length,
                status: "connected",
            };
        }
        catch (error) {
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
        }
        catch (error) {
            console.error("Error during queue cleanup:", error);
        }
    }
    setupEventListeners() {
        if (!this.worker)
            return;
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
    getConnectionStatus() {
        return this.isConnected;
    }
}
// Singleton instance
exports.redisQueue = new RedisQueueService();
