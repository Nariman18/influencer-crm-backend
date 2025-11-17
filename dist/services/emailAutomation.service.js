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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailAutomationService = exports.AUTOMATION_CONFIG = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const client_1 = require("@prisma/client");
const redis_queue_1 = require("../lib/redis-queue");
// Timing configuration based on environment
const isDev = process.env.NODE_ENV === "development";
exports.AUTOMATION_CONFIG = {
    // Check frequency
    POLLING_INTERVAL: isDev ? 30 * 1000 : 60 * 1000, // 30s (dev) / 60s (prod)
    // Follow-up delays
    PING_1_TO_PING_2_DELAY: isDev ? 2 * 60 * 1000 : 24 * 60 * 60 * 1000, // 2min (dev) / 24hrs (prod)
    PING_2_TO_PING_3_DELAY: isDev ? 2 * 60 * 1000 : 24 * 60 * 60 * 1000, // 2min (dev) / 24hrs (prod)
    PING_3_TO_REJECTED_DELAY: isDev ? 2 * 60 * 1000 : 24 * 60 * 60 * 1000, // 2min (dev) / 24hrs (prod)
};
class EmailAutomationService {
    /**
     * Main function to process pending follow-ups
     */
    static async processAutomatedFollowUps() {
        console.log("🤖 [Automation] Checking for pending follow-ups...");
        try {
            // Get influencers due for follow-up
            const influencersDueForFollowUp = await prisma_1.default.influencer.findMany({
                where: {
                    autoFollowUpEnabled: true,
                    nextFollowUpDate: {
                        lte: new Date(), // Due date has passed
                    },
                    status: {
                        in: [client_1.InfluencerStatus.PING_1, client_1.InfluencerStatus.PING_2, client_1.InfluencerStatus.PING_3],
                    },
                },
                include: {
                    manager: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            googleAccessToken: true,
                            googleRefreshToken: true,
                        },
                    },
                    emails: {
                        orderBy: {
                            createdAt: "desc",
                        },
                        take: 1,
                    },
                },
            });
            console.log(`📊 [Automation] Found ${influencersDueForFollowUp.length} influencers due for follow-up`);
            for (const influencer of influencersDueForFollowUp) {
                await this.processInfluencerFollowUp(influencer);
            }
            console.log("✅ [Automation] Follow-up processing completed");
        }
        catch (error) {
            console.error("❌ [Automation] Error processing follow-ups:", error);
        }
    }
    /**
     * Process a single influencer for follow-up
     */
    static async processInfluencerFollowUp(influencer) {
        try {
            console.log(`🔍 [Automation] Processing influencer: ${influencer.name} (${influencer.status})`);
            // Check if influencer has replied
            const hasReplied = await this.checkIfInfluencerReplied(influencer);
            if (hasReplied) {
                console.log(`✉️ [Automation] Influencer ${influencer.name} has replied - stopping automation`);
                // Reset to NOT_SENT and disable automation
                await prisma_1.default.influencer.update({
                    where: { id: influencer.id },
                    data: {
                        status: client_1.InfluencerStatus.NOT_SENT,
                        autoFollowUpEnabled: true, // Keep enabled for future campaigns
                        nextFollowUpDate: null,
                    },
                });
                return;
            }
            // Determine next action based on current status
            switch (influencer.status) {
                case client_1.InfluencerStatus.PING_1:
                    await this.sendFollowUp(influencer, client_1.InfluencerStatus.PING_2, "PING_2");
                    break;
                case client_1.InfluencerStatus.PING_2:
                    await this.sendFollowUp(influencer, client_1.InfluencerStatus.PING_3, "PING_3");
                    break;
                case client_1.InfluencerStatus.PING_3:
                    await this.markAsRejected(influencer);
                    break;
                default:
                    console.log(`⚠️ [Automation] Unexpected status for ${influencer.name}: ${influencer.status}`);
            }
        }
        catch (error) {
            console.error(`❌ [Automation] Error processing ${influencer.name}:`, error);
        }
    }
    /**
     * Check if influencer has replied to the email thread using Gmail API
     * This is the ONLY use of Gmail API - for detecting replies
     */
    static async checkIfInfluencerReplied(influencer) {
        try {
            // First check database for already detected replies
            const repliedEmail = await prisma_1.default.email.findFirst({
                where: {
                    influencerId: influencer.id,
                    status: client_1.EmailStatus.REPLIED,
                },
                orderBy: {
                    repliedAt: "desc",
                },
            });
            if (repliedEmail) {
                console.log(`✅ [Automation] Reply already detected from ${influencer.name} at ${repliedEmail.repliedAt}`);
                return true;
            }
            // Check Gmail for new replies if we have a thread ID
            if (!influencer.lastEmailThreadId) {
                return false; // No thread to check
            }
            // Get manager's Gmail credentials
            if (!influencer.manager?.googleAccessToken || !influencer.manager?.googleRefreshToken) {
                console.log(`⚠️ [Automation] No Gmail credentials for manager of ${influencer.name}`);
                return false; // Can't check without credentials
            }
            // Check Gmail API for replies
            const hasReply = await this.checkGmailThreadForReplies(influencer.manager.googleAccessToken, influencer.manager.googleRefreshToken, influencer.lastEmailThreadId, influencer.email);
            if (hasReply) {
                console.log(`✅ [Automation] New reply detected from ${influencer.name} via Gmail API`);
                // Mark email as REPLIED in database
                await prisma_1.default.email.updateMany({
                    where: {
                        influencerId: influencer.id,
                        gmailThreadId: influencer.lastEmailThreadId,
                    },
                    data: {
                        status: client_1.EmailStatus.REPLIED,
                        repliedAt: new Date(),
                    },
                });
                return true;
            }
            return false;
        }
        catch (error) {
            console.error(`❌ [Automation] Error checking replies for ${influencer.name}:`, error);
            return false; // If we can't check, assume no reply and continue automation
        }
    }
    /**
     * Check Gmail thread for replies from influencer
     * This uses Gmail API to detect if influencer has replied
     */
    static async checkGmailThreadForReplies(accessToken, refreshToken, threadId, influencerEmail) {
        try {
            const { google } = await Promise.resolve().then(() => __importStar(require("googleapis")));
            const OAuth2 = google.auth.OAuth2;
            // Create OAuth2 client
            const oauth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
            oauth2Client.setCredentials({
                access_token: accessToken,
                refresh_token: refreshToken,
            });
            // Initialize Gmail API
            const gmail = google.gmail({ version: "v1", auth: oauth2Client });
            // Get thread messages
            const threadResponse = await gmail.users.threads.get({
                userId: "me",
                id: threadId,
                format: "metadata",
                metadataHeaders: ["From", "To"],
            });
            const messages = threadResponse.data.messages || [];
            // Check if any message is FROM the influencer (means they replied)
            for (const message of messages) {
                const headers = message.payload?.headers || [];
                const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from");
                const fromEmail = fromHeader?.value || "";
                // If message is from influencer, they replied
                if (fromEmail.toLowerCase().includes(influencerEmail.toLowerCase())) {
                    console.log(`📧 [Gmail API] Found reply from ${influencerEmail} in thread ${threadId}`);
                    return true;
                }
            }
            console.log(`📧 [Gmail API] No reply from ${influencerEmail} in thread ${threadId}`);
            return false;
        }
        catch (error) {
            // Handle token refresh errors
            if (error.code === 401 || error.message?.includes("invalid_grant")) {
                console.error(`❌ [Gmail API] Token expired or invalid - need to reconnect Google account`);
            }
            else {
                console.error(`❌ [Gmail API] Error checking thread:`, error);
            }
            return false;
        }
    }
    /**
     * Send automated follow-up email
     */
    static async sendFollowUp(influencer, targetStatus, templateType) {
        try {
            if (!influencer.email) {
                console.log(`⚠️ [Automation] No email for ${influencer.name}, skipping`);
                return;
            }
            if (!influencer.manager) {
                console.log(`⚠️ [Automation] No manager assigned to ${influencer.name}, skipping`);
                return;
            }
            const manager = influencer.manager;
            // Get appropriate template
            const template = await this.getAutomationTemplate(templateType);
            if (!template) {
                console.log(`⚠️ [Automation] No template found for ${templateType}, skipping`);
                return;
            }
            // Personalize template
            const subject = this.replaceVariables(template.subject, {
                name: influencer.name,
                email: influencer.email,
                instagramHandle: influencer.instagramHandle || "",
            });
            const body = this.replaceVariables(template.body, {
                name: influencer.name,
                email: influencer.email,
                instagramHandle: influencer.instagramHandle || "",
            });
            console.log(`📧 [Automation] Sending ${templateType} follow-up to ${influencer.name}`);
            // Create email record
            const email = await prisma_1.default.email.create({
                data: {
                    influencerId: influencer.id,
                    templateId: template.id,
                    sentById: manager.id,
                    subject,
                    body,
                    status: client_1.EmailStatus.PENDING,
                    isAutomated: true,
                },
            });
            // Get the original message ID from the last sent email for proper reply headers
            let originalMessageId;
            if (influencer.lastEmailThreadId) {
                const lastEmail = await prisma_1.default.email.findFirst({
                    where: {
                        influencerId: influencer.id,
                        gmailThreadId: influencer.lastEmailThreadId,
                    },
                    orderBy: {
                        createdAt: "desc",
                    },
                    select: {
                        gmailMessageId: true,
                    },
                });
                originalMessageId = lastEmail?.gmailMessageId || undefined;
            }
            // Queue the email with automation flag and target status
            await redis_queue_1.redisQueue.addEmailJob({
                userId: manager.id,
                to: influencer.email,
                subject,
                body,
                influencerName: influencer.name,
                emailRecordId: email.id,
                influencerId: influencer.id,
                isAutomated: true,
                targetStatus: targetStatus,
                threadId: influencer.lastEmailThreadId, // Reply to the original thread
                originalMessageId: originalMessageId, // Original message ID for reply headers
            });
            console.log(`📧 [Automation] Queued ${templateType} as reply to thread: ${influencer.lastEmailThreadId}`);
            if (originalMessageId) {
                console.log(`📧 [Automation] Using original message ID for reply headers: ${originalMessageId}`);
            }
            // Calculate next follow-up date
            const nextDelay = targetStatus === client_1.InfluencerStatus.PING_2
                ? exports.AUTOMATION_CONFIG.PING_2_TO_PING_3_DELAY
                : exports.AUTOMATION_CONFIG.PING_3_TO_REJECTED_DELAY;
            const nextFollowUpDate = new Date(Date.now() + nextDelay);
            // Update influencer with next follow-up date (status will be updated by queue worker)
            await prisma_1.default.influencer.update({
                where: { id: influencer.id },
                data: {
                    nextFollowUpDate: nextFollowUpDate,
                    lastEmailThreadId: influencer.lastEmailThreadId, // Keep the same thread
                },
            });
            console.log(`✅ [Automation] Queued ${templateType} for ${influencer.name}, next check at ${nextFollowUpDate}`);
        }
        catch (error) {
            console.error(`❌ [Automation] Error sending follow-up to ${influencer.name}:`, error);
        }
    }
    /**
     * Mark influencer as REJECTED after final follow-up
     */
    static async markAsRejected(influencer) {
        try {
            console.log(`❌ [Automation] Marking ${influencer.name} as REJECTED (no response after PING_3)`);
            await prisma_1.default.influencer.update({
                where: { id: influencer.id },
                data: {
                    status: client_1.InfluencerStatus.REJECTED,
                    autoFollowUpEnabled: false, // Disable automation
                    nextFollowUpDate: null,
                },
            });
            console.log(`✅ [Automation] ${influencer.name} marked as REJECTED`);
        }
        catch (error) {
            console.error(`❌ [Automation] Error marking ${influencer.name} as rejected:`, error);
        }
    }
    /**
     * Get automation email template by type
     */
    static async getAutomationTemplate(type) {
        const templateName = type === "PING_2" ? "24-Hour Reminder" : "48-Hour Follow-up";
        const template = await prisma_1.default.emailTemplate.findFirst({
            where: {
                name: templateName,
                isActive: true,
            },
        });
        return template;
    }
    /**
     * Replace variables in template
     */
    static replaceVariables(text, variables) {
        let result = text;
        Object.entries(variables).forEach(([key, value]) => {
            const regex = new RegExp(`{{${key}}}`, "g");
            result = result.replace(regex, value);
        });
        return result;
    }
    /**
     * Schedule initial follow-up after first email sent
     */
    static async scheduleInitialFollowUp(influencerId, threadId) {
        try {
            const influencer = await prisma_1.default.influencer.findUnique({
                where: { id: influencerId },
            });
            if (!influencer || influencer.status !== client_1.InfluencerStatus.PING_1) {
                return; // Only schedule for PING_1 status
            }
            const nextFollowUpDate = new Date(Date.now() + exports.AUTOMATION_CONFIG.PING_1_TO_PING_2_DELAY);
            await prisma_1.default.influencer.update({
                where: { id: influencerId },
                data: {
                    nextFollowUpDate: nextFollowUpDate,
                    lastEmailThreadId: threadId,
                    autoFollowUpEnabled: true,
                },
            });
            console.log(`📅 [Automation] Scheduled first follow-up for ${influencer.name} at ${nextFollowUpDate} (${isDev ? "2 minutes" : "24 hours"})`);
        }
        catch (error) {
            console.error(`❌ [Automation] Error scheduling initial follow-up:`, error);
        }
    }
}
exports.EmailAutomationService = EmailAutomationService;
