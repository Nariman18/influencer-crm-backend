"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailScheduler = void 0;
const cron = __importStar(require("node-cron"));
const emailAutomation_service_1 = require("../services/emailAutomation.service");
const isDev = process.env.NODE_ENV === "development";
class EmailScheduler {
    /**
     * Start the email automation scheduler
     */
    static start() {
        console.log("🚀 [Scheduler] Starting email automation scheduler...");
        console.log(`📊 [Scheduler] Environment: ${isDev ? "DEVELOPMENT" : "PRODUCTION"}`);
        console.log(`⏱️  [Scheduler] Polling interval: ${emailAutomation_service_1.AUTOMATION_CONFIG.POLLING_INTERVAL / 1000}s`);
        console.log(`📧 [Scheduler] PING_1 → PING_2: ${emailAutomation_service_1.AUTOMATION_CONFIG.PING_1_TO_PING_2_DELAY / 1000 / 60} minutes`);
        console.log(`📧 [Scheduler] PING_2 → PING_3: ${emailAutomation_service_1.AUTOMATION_CONFIG.PING_2_TO_PING_3_DELAY / 1000 / 60} minutes`);
        console.log(`📧 [Scheduler] PING_3 → REJECTED: ${emailAutomation_service_1.AUTOMATION_CONFIG.PING_3_TO_REJECTED_DELAY / 1000 / 60} minutes`);
        if (isDev) {
            // In development, use setInterval for more frequent checks
            this.startPolling();
        }
        else {
            // In production, use cron for scheduled checks
            this.startCronJob();
        }
        console.log("✅ [Scheduler] Email automation scheduler started successfully");
    }
    /**
     * Start polling-based scheduler (for development)
     */
    static startPolling() {
        console.log("🔄 [Scheduler] Using polling mode (development)");
        // Run immediately on start
        emailAutomation_service_1.EmailAutomationService.processAutomatedFollowUps().catch((error) => {
            console.error("❌ [Scheduler] Initial automation check failed:", error);
        });
        // Then run at regular intervals
        this.pollingInterval = setInterval(async () => {
            try {
                await emailAutomation_service_1.EmailAutomationService.processAutomatedFollowUps();
            }
            catch (error) {
                console.error("❌ [Scheduler] Automation check failed:", error);
            }
        }, emailAutomation_service_1.AUTOMATION_CONFIG.POLLING_INTERVAL);
        console.log(`✅ [Scheduler] Polling started (every ${emailAutomation_service_1.AUTOMATION_CONFIG.POLLING_INTERVAL / 1000}s)`);
    }
    /**
     * Start cron-based scheduler (for production)
     */
    static startCronJob() {
        console.log("⏰ [Scheduler] Using cron mode (production)");
        // Run every minute in production
        this.cronJob = cron.schedule("* * * * *", async () => {
            try {
                await emailAutomation_service_1.EmailAutomationService.processAutomatedFollowUps();
            }
            catch (error) {
                console.error("❌ [Scheduler] Automation check failed:", error);
            }
        });
        console.log("✅ [Scheduler] Cron job scheduled (every minute)");
        // Run immediately on start
        emailAutomation_service_1.EmailAutomationService.processAutomatedFollowUps().catch((error) => {
            console.error("❌ [Scheduler] Initial automation check failed:", error);
        });
    }
    /**
     * Stop the scheduler
     */
    static stop() {
        console.log("🛑 [Scheduler] Stopping email automation scheduler...");
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            console.log("✅ [Scheduler] Cron job stopped");
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log("✅ [Scheduler] Polling stopped");
        }
        console.log("✅ [Scheduler] Email automation scheduler stopped successfully");
    }
    /**
     * Get scheduler status
     */
    static getStatus() {
        const running = (isDev && this.pollingInterval !== null) || (!isDev && this.cronJob !== null);
        return {
            running,
            mode: isDev ? "polling" : "cron",
            config: emailAutomation_service_1.AUTOMATION_CONFIG,
        };
    }
}
exports.EmailScheduler = EmailScheduler;
EmailScheduler.cronJob = null;
EmailScheduler.pollingInterval = null;
