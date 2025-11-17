"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkForReplyAndHandle = void 0;
// src/lib/followup-service.ts
const prisma_1 = __importDefault(require("../config/prisma"));
const googleapis_1 = require("googleapis");
const redis_queue_1 = require("./redis-queue");
const client_1 = require("@prisma/client");
const OAuth2 = googleapis_1.google.auth.OAuth2;
const TEMPLATE_24H = process.env.FOLLOWUP_TEMPLATE_24H || "24-Hour Reminder";
const TEMPLATE_48H = process.env.FOLLOWUP_TEMPLATE_48H || "48-Hour Reminder";
/**
 * jobData expected: { influencerId, emailRecordId, step, userId }
 */
const checkForReplyAndHandle = async (jobData) => {
    const { influencerId, emailRecordId, step = 1, userId } = jobData;
    const emailRecord = await prisma_1.default.email.findUnique({
        where: { id: emailRecordId },
        include: { influencer: true, sentBy: true, template: true },
    });
    if (!emailRecord) {
        console.warn("[followup] email record not found, aborting check", emailRecordId);
        return;
    }
    const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
    if (!user) {
        console.warn("[followup] user record not found, aborting check", userId);
        return;
    }
    if (emailRecord.status === client_1.EmailStatus.REPLIED)
        return;
    // Build Gmail query
    const gmailQueryParts = [];
    if (emailRecord.influencer?.email) {
        gmailQueryParts.push(`from:${emailRecord.influencer.email}`);
    }
    else {
        return await handleNoReplyFallback(jobData);
    }
    const subjectSnippet = (emailRecord.subject || "").replace(/"/g, "");
    gmailQueryParts.push(`subject:("${subjectSnippet}" OR "Re: ${subjectSnippet}" OR "re: ${subjectSnippet}")`);
    if (emailRecord.sentAt) {
        const afterEpoch = Math.floor(emailRecord.sentAt.getTime() / 1000);
        gmailQueryParts.push(`after:${afterEpoch}`);
    }
    const q = gmailQueryParts.join(" ");
    if (!user.googleAccessToken || !user.googleRefreshToken) {
        console.warn("User has no Google tokens; skipping reply check for", user.id);
        return await handleNoReplyFallback(jobData);
    }
    const oauth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
    });
    try {
        await oauth2Client.getTokenInfo(user.googleAccessToken);
    }
    catch (err) {
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            await prisma_1.default.user.update({
                where: { id: userId },
                data: {
                    googleAccessToken: credentials.access_token,
                    ...(credentials.refresh_token && {
                        googleRefreshToken: credentials.refresh_token,
                    }),
                },
            });
            oauth2Client.setCredentials(credentials);
        }
        catch (refreshErr) {
            console.error("Failed to refresh Google token:", refreshErr);
            return await handleNoReplyFallback(jobData);
        }
    }
    const gmail = googleapis_1.google.gmail({ version: "v1", auth: oauth2Client });
    try {
        const resp = await gmail.users.messages.list({
            userId: "me",
            q,
            maxResults: 10,
        });
        const messages = resp.data.messages || [];
        if (messages.length > 0) {
            // Found reply(s)
            const msg = await gmail.users.messages.get({
                userId: "me",
                id: messages[0].id,
            });
            const internalDate = Number(msg.data.internalDate || Date.now());
            const repliedAt = new Date(internalDate);
            try {
                await prisma_1.default.email.update({
                    where: { id: emailRecordId },
                    data: {
                        status: client_1.EmailStatus.REPLIED,
                        repliedAt,
                    },
                });
            }
            catch (e) {
                console.warn("[followup] failed to update email status to REPLIED:", emailRecordId, e);
            }
            try {
                await prisma_1.default.influencer.update({
                    where: { id: influencerId },
                    data: { status: client_1.InfluencerStatus.NOT_SENT },
                });
            }
            catch (e) {
                console.warn("[followup] failed to reset influencer status:", e);
            }
            // Cancel scheduled follow-up (if present)
            if (emailRecord.scheduledJobId) {
                try {
                    await redis_queue_1.followUpQueue.remove(emailRecord.scheduledJobId);
                }
                catch (e) {
                    console.warn("Could not remove followup job", emailRecord.scheduledJobId, e);
                }
            }
            return;
        }
        else {
            // No replies found
            return await handleNoReplyFallback(jobData);
        }
    }
    catch (err) {
        console.error("Error checking Gmail for replies:", err);
        return await handleNoReplyFallback(jobData);
    }
};
exports.checkForReplyAndHandle = checkForReplyAndHandle;
/**
 * No-reply handling:
 * - step=1: send 24H reminder -> schedule step=2
 * - step=2: send 48H reminder -> schedule step=3 (final verification)
 * - step=3: final verification (NO SEND) -> mark influencer REJECTED (do not change email statuses)
 */
const handleNoReplyFallback = async (jobData) => {
    const { influencerId, emailRecordId, step = 1, userId } = jobData;
    if (step > 3) {
        console.warn("[followup] step beyond expected range, aborting:", step);
        return;
    }
    // Step 3: final verification (do NOT modify the send-status of historical sent emails)
    if (step === 3) {
        try {
            await prisma_1.default.influencer.update({
                where: { id: influencerId },
                data: { status: client_1.InfluencerStatus.REJECTED },
            });
        }
        catch (e) {
            console.warn("[followup] failed to set influencer to REJECTED:", e);
        }
        // do NOT set email to FAILED here — keep the send history intact
        return;
    }
    const templateName = step === 1 ? TEMPLATE_24H : TEMPLATE_48H;
    const nextTemplate = await prisma_1.default.emailTemplate.findFirst({
        where: { name: templateName, isActive: true },
    });
    const sendDelay = process.env.NODE_ENV === "production"
        ? Number(process.env.PROD_FOLLOWUP_DELAY_MS)
        : Number(process.env.DEV_FOLLOWUP_DELAY_MS);
    if (!nextTemplate) {
        console.warn("Follow-up template not found:", templateName);
        const nextStep = step + 1;
        const nextDelay = step === 1
            ? sendDelay
            : Number(process.env.FOLLOWUP_FINAL_WAIT_MS || sendDelay);
        const nextJob = await redis_queue_1.followUpQueue.add("follow-up-check", { influencerId, emailRecordId, step: nextStep, userId }, {
            delay: nextDelay,
            attempts: 3,
            backoff: { type: "exponential", delay: 10000 },
        });
        if (emailRecordId) {
            try {
                await prisma_1.default.email.update({
                    where: { id: emailRecordId },
                    data: { scheduledJobId: String(nextJob.id) },
                });
            }
            catch (e) {
                console.warn("[followup] failed to persist scheduledJobId:", e);
            }
        }
        return;
    }
    // Prepare personalization and ensure influencer/user exist
    const influencer = await prisma_1.default.influencer.findUnique({
        where: { id: influencerId },
    });
    const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
    if (!influencer || !user) {
        console.warn("[followup] missing influencer or user; aborting fallback", {
            influencerId,
            userId,
        });
        return;
    }
    const personalizedSubject = nextTemplate.subject
        .replace(/{{name}}/g, influencer.name || "")
        .replace(/{{email}}/g, influencer.email || "");
    const personalizedBody = nextTemplate.body
        .replace(/{{name}}/g, influencer.name || "")
        .replace(/{{email}}/g, influencer.email || "");
    // Create follow-up email record
    let newEmail;
    try {
        newEmail = await prisma_1.default.email.create({
            data: {
                influencerId,
                templateId: nextTemplate.id,
                sentById: userId,
                subject: personalizedSubject,
                body: personalizedBody,
                status: client_1.EmailStatus.PENDING,
                isAutomation: true,
            },
        });
    }
    catch (e) {
        console.error("[followup] failed to create follow-up email record:", e);
        return;
    }
    // Enqueue send (replyTo set so replies are tracked)
    try {
        await redis_queue_1.emailSendQueue.add("send-email", {
            userId,
            to: influencer.email,
            subject: personalizedSubject,
            body: personalizedBody,
            influencerName: influencer.name,
            emailRecordId: newEmail.id,
            influencerId,
            replyTo: user.googleEmail || process.env.MAILGUN_FROM_EMAIL,
        });
    }
    catch (e) {
        console.error("[followup] failed to enqueue follow-up send:", e, {
            influencerId,
            emailRecordId: newEmail.id,
        });
        // continue to scheduling the next check anyway
    }
    // Update influencer pipeline to PING_2 or PING_3 now that follow-up has been created/sent
    const nextStatus = step === 1 ? client_1.InfluencerStatus.PING_2 : client_1.InfluencerStatus.PING_3;
    try {
        await prisma_1.default.influencer.update({
            where: { id: influencerId },
            data: { status: nextStatus, lastContactDate: new Date() },
        });
    }
    catch (e) {
        console.warn("[followup] failed to update influencer status:", e);
    }
    // Schedule next check: if step=1 -> schedule step=2 after sendDelay; if step=2 -> schedule step=3 after final wait
    try {
        if (step === 1) {
            const nextCheckJob = await redis_queue_1.followUpQueue.add("follow-up-check", { influencerId, emailRecordId: newEmail.id, step: 2, userId }, {
                delay: sendDelay,
                attempts: 3,
                backoff: { type: "exponential", delay: 10000 },
            });
            await prisma_1.default.email.update({
                where: { id: newEmail.id },
                data: { scheduledJobId: String(nextCheckJob.id) },
            });
        }
        else if (step === 2) {
            const finalWait = Number(process.env.FOLLOWUP_FINAL_WAIT_MS) || sendDelay;
            const finalCheckJob = await redis_queue_1.followUpQueue.add("follow-up-check", { influencerId, emailRecordId: newEmail.id, step: 3, userId }, {
                delay: finalWait,
                attempts: 3,
                backoff: { type: "exponential", delay: 10000 },
            });
            await prisma_1.default.email.update({
                where: { id: newEmail.id },
                data: { scheduledJobId: String(finalCheckJob.id) },
            });
        }
    }
    catch (e) {
        console.warn("[followup] failed to schedule next follow-up check:", e);
    }
};
exports.default = {
    checkForReplyAndHandle: exports.checkForReplyAndHandle,
};
