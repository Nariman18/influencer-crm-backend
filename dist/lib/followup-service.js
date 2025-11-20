"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkForReplyAndHandle = void 0;
// src/lib/followup-service.ts
const prisma_1 = require("../config/prisma");
const googleapis_1 = require("googleapis");
const redis_queue_1 = require("./redis-queue");
const client_1 = require("@prisma/client");
const email_wrap_body_1 = require("./email-wrap-body");
const prisma = (0, prisma_1.getPrisma)();
const OAuth2 = googleapis_1.google.auth.OAuth2;
const TEMPLATE_24H = process.env.FOLLOWUP_TEMPLATE_24H || "24-Hour Reminder";
const TEMPLATE_48H = process.env.FOLLOWUP_TEMPLATE_48H || "48-Hour Reminder";
/**
 * Helper: ensure OAuth2 client tokens are valid (refresh when needed).
 * Accepts both older and some newer googleapis method names (defensive).
 */
const ensureValidGoogleClient = async (user, oauth2Client) => {
    oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
    });
    try {
        if (user.googleAccessToken) {
            // tokenInfo will throw if token invalid/expired
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            await oauth2Client.getTokenInfo(user.googleAccessToken);
            return;
        }
    }
    catch (err) {
        // try to refresh - try both older and newer API forms
        try {
            // older googleapis had refreshAccessToken()
            if (typeof oauth2Client.refreshAccessToken === "function") {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                return credentials;
            }
            else if (typeof oauth2Client.refreshToken === "function") {
                // some environments / versions expose refreshToken()
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const credentials = await oauth2Client.refreshToken(oauth2Client.credentials.refresh_token);
                oauth2Client.setCredentials(credentials);
                return credentials;
            }
            else if (typeof oauth2Client.getAccessToken === "function") {
                // last resort, trigger getAccessToken which may refresh
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const maybe = await oauth2Client.getAccessToken();
                if (maybe && maybe.token) {
                    oauth2Client.setCredentials({ access_token: maybe.token });
                    return maybe;
                }
            }
            // if none available, throw to caller to fallback
            throw new Error("No refresh method available on oauth2 client");
        }
        catch (refreshErr) {
            throw refreshErr;
        }
    }
};
/**
 * Normalize Message-ID value: remove angle brackets and whitespace
 */
const normalizeMessageId = (v) => {
    if (!v || typeof v !== "string")
        return null;
    return v.replace(/[<>\s]/g, "").trim() || null;
};
/**
 * Check candidate Gmail message headers to determine whether it is a reply to the original message.
 */
const isReplyToOriginal = (candidateHeaders, originalMidNoAngle, influencerEmail, userGmailAddress, sentAt, afterBufferSeconds = 30) => {
    const hdr = (key) => candidateHeaders[key.toLowerCase()] || candidateHeaders[key] || undefined;
    // header values of interest
    const from = (hdr("From") || "").toLowerCase();
    const to = (hdr("To") || hdr("Delivered-To") || "").toLowerCase();
    const inReplyTo = (hdr("In-Reply-To") || "").trim();
    const references = (hdr("References") || "").trim();
    const msgid = normalizeMessageId(hdr("Message-ID") || hdr("Message-Id"));
    // If we have original message-id, check In-Reply-To/References for inclusion
    if (originalMidNoAngle) {
        const inReplyNorm = normalizeMessageId(inReplyTo) || null;
        if (inReplyTo && inReplyNorm && inReplyNorm.includes(originalMidNoAngle)) {
            return true;
        }
        if (references) {
            const parts = references.split(/\s+/).map((r) => normalizeMessageId(r));
            if (parts.some((r) => r && r === originalMidNoAngle))
                return true;
        }
        if (msgid && msgid === originalMidNoAngle) {
            return true;
        }
    }
    // If message-id matching not available, check From/To/Subject/Time as a fallback:
    if (influencerEmail && from.includes(influencerEmail.toLowerCase())) {
        if (userGmailAddress && to.includes(userGmailAddress.toLowerCase())) {
            if (inReplyTo || references)
                return true;
            return true; // last-resort heuristic
        }
    }
    return false;
};
const extractHeaders = (msg) => {
    const headers = {};
    const parts = msg?.payload?.headers || [];
    for (const h of parts) {
        if (!h || !h.name)
            continue;
        headers[h.name.toLowerCase()] = h.value;
    }
    return headers;
};
const checkForReplyAndHandle = async (jobData) => {
    const { influencerId, emailRecordId, step = 1, userId } = jobData;
    const emailRecord = await prisma.email.findUnique({
        where: { id: emailRecordId },
        include: { influencer: true, sentBy: true, template: true },
    });
    if (!emailRecord) {
        console.warn("[followup] email record not found, aborting check", emailRecordId);
        return;
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        console.warn("[followup] user record not found, aborting check", userId);
        return;
    }
    if (emailRecord.status === client_1.EmailStatus.REPLIED) {
        console.log("[followup] email already marked REPLIED; skipping", emailRecordId);
        return;
    }
    const mailgunMessageIdNormalized = emailRecord.mailgunMessageIdNormalized ||
        normalizeMessageId(emailRecord.mailgunMessageId) ||
        normalizeMessageId(emailRecord.mailgunId) ||
        null;
    const influencerEmail = emailRecord.influencer?.email || null;
    const userGmailAddress = user.googleEmail || user.email || null;
    const afterEpochBufferSec = 30;
    let afterEpoch = null;
    if (emailRecord.sentAt) {
        afterEpoch =
            Math.floor(emailRecord.sentAt.getTime() / 1000) - afterEpochBufferSec;
    }
    if (!user.googleAccessToken || !user.googleRefreshToken) {
        console.warn("[followup] user has no google tokens; cannot check replies for user", userId);
        return await handleNoReplyFallback(jobData);
    }
    const oauth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    try {
        oauth2Client.setCredentials({
            access_token: user.googleAccessToken,
            refresh_token: user.googleRefreshToken,
        });
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            await oauth2Client.getTokenInfo(user.googleAccessToken);
        }
        catch (tokenErr) {
            try {
                await ensureValidGoogleClient(user, oauth2Client);
                const newCreds = oauth2Client.credentials;
                if (newCreds?.access_token) {
                    const updateData = { googleAccessToken: newCreds.access_token };
                    if (newCreds.refresh_token)
                        updateData.googleRefreshToken = newCreds.refresh_token;
                    try {
                        await prisma.user.update({
                            where: { id: userId },
                            data: updateData,
                        });
                        console.log("[followup] persisted refreshed google tokens for user:", userId);
                    }
                    catch (uErr) {
                        console.warn("[followup] failed to persist refreshed google tokens:", uErr);
                    }
                }
            }
            catch (refreshErr) {
                console.error("[followup] failed to refresh google token:", refreshErr);
                return await handleNoReplyFallback(jobData);
            }
        }
        const gmail = googleapis_1.google.gmail({ version: "v1", auth: oauth2Client });
        let queriesTried = [];
        if (mailgunMessageIdNormalized) {
            const q = `rfc822msgid:${mailgunMessageIdNormalized}` +
                (afterEpoch ? ` after:${afterEpoch}` : "");
            queriesTried.push(q);
            console.debug("[followup] trying Gmail query (rfc822msgid):", q);
            try {
                const listResp = await gmail.users.messages.list({
                    userId: "me",
                    q,
                    maxResults: 25,
                });
                const candidates = listResp.data.messages || [];
                console.log("[followup] Gmail.list (rfc822msgid) resultSizeEstimate:", listResp.data.resultSizeEstimate, "candidates:", candidates.length);
                if (candidates.length > 0) {
                    for (const c of candidates) {
                        try {
                            const getResp = await gmail.users.messages.get({
                                userId: "me",
                                id: c.id,
                                format: "metadata",
                            });
                            const headersMap = extractHeaders(getResp.data);
                            const valid = isReplyToOriginal(headersMap, mailgunMessageIdNormalized, influencerEmail, userGmailAddress, emailRecord.sentAt || null);
                            console.debug("[followup] candidate headers (rfc822msgid) checked:", {
                                candidateId: c.id,
                                valid,
                                headersSample: {
                                    from: headersMap["from"],
                                    to: headersMap["to"] || headersMap["delivered-to"],
                                    inReplyTo: headersMap["in-reply-to"],
                                    references: headersMap["references"],
                                    messageId: headersMap["message-id"],
                                },
                            });
                            if (valid) {
                                await markEmailReplied(emailRecordId, influencerId, redis_queue_1.followUpQueue, emailRecord);
                                return;
                            }
                        }
                        catch (gErr) {
                            console.warn("[followup] failed to fetch message metadata for candidate", c.id, gErr);
                        }
                    }
                }
            }
            catch (listErr) {
                console.error("[followup] gmail.list (rfc822msgid) failed:", listErr);
            }
        }
        const subjectSnippet = (emailRecord.subject || "")
            .replace(/"/g, "")
            .slice(0, 80)
            .trim();
        const subjectQuery = subjectSnippet
            ? `subject:("${subjectSnippet}" OR "Re: ${subjectSnippet}" OR "re: ${subjectSnippet}")`
            : "";
        const parts = [
            influencerEmail ? `from:${influencerEmail}` : "",
            "in:inbox",
            userGmailAddress ? `to:${userGmailAddress}` : "",
            subjectQuery,
        ].filter(Boolean);
        if (afterEpoch)
            parts.push(`after:${afterEpoch}`);
        const fallbackQuery = parts.join(" ");
        queriesTried.push(fallbackQuery);
        console.debug("[followup] trying fallback Gmail query:", fallbackQuery);
        try {
            const listResp = await gmail.users.messages.list({
                userId: "me",
                q: fallbackQuery,
                maxResults: 50,
            });
            console.log("[followup] Gmail.list (fallback) resultSizeEstimate:", listResp.data.resultSizeEstimate, "candidates:", (listResp.data.messages || []).length);
            const candidates = listResp.data.messages || [];
            if (!candidates.length) {
                console.debug("[followup] no candidate messages found for any query. queriesTried:", queriesTried);
                return await handleNoReplyFallback(jobData);
            }
            for (const c of candidates) {
                if (!c?.id)
                    continue;
                try {
                    const meta = await gmail.users.messages.get({
                        userId: "me",
                        id: c.id,
                        format: "metadata",
                    });
                    const headersMap = extractHeaders(meta.data);
                    let internalDate = Number(meta.data.internalDate || 0);
                    if (!internalDate) {
                        try {
                            const full = await gmail.users.messages.get({
                                userId: "me",
                                id: c.id,
                            });
                            internalDate = Number(full.data.internalDate || 0);
                        }
                        catch (fullErr) {
                            console.warn("[followup] failed to fetch full message for internalDate fallback:", c.id, fullErr);
                        }
                    }
                    if (emailRecord.sentAt && internalDate) {
                        const msgDate = new Date(internalDate);
                        if (msgDate.getTime() <
                            emailRecord.sentAt.getTime() - afterEpochBufferSec * 1000) {
                            console.debug("[followup] skipping candidate older than sentAt:", c.id, msgDate.toISOString());
                            continue;
                        }
                    }
                    const valid = isReplyToOriginal(headersMap, mailgunMessageIdNormalized, influencerEmail, userGmailAddress, emailRecord.sentAt || null);
                    console.debug("[followup] fallback candidate checked:", {
                        candidateId: c.id,
                        valid,
                        headersSample: {
                            from: headersMap["from"],
                            to: headersMap["to"] || headersMap["delivered-to"],
                            inReplyTo: headersMap["in-reply-to"],
                            references: headersMap["references"],
                            messageId: headersMap["message-id"],
                        },
                        internalDate,
                    });
                    if (valid) {
                        await markEmailReplied(emailRecordId, influencerId, redis_queue_1.followUpQueue, emailRecord);
                        return;
                    }
                }
                catch (cErr) {
                    console.warn("[followup] failed to inspect candidate:", c.id, cErr);
                }
            }
            console.debug("[followup] examined fallback candidates but none validated as reply. queriesTried:", queriesTried);
            return await handleNoReplyFallback(jobData);
        }
        catch (fallbackErr) {
            console.error("[followup] gmail.list (fallback) failed:", fallbackErr);
            return await handleNoReplyFallback(jobData);
        }
    }
    catch (err) {
        console.error("[followup] unexpected error in reply checking:", err);
        return await handleNoReplyFallback(jobData);
    }
};
exports.checkForReplyAndHandle = checkForReplyAndHandle;
const markEmailReplied = async (emailRecordId, influencerId, followUpQueueRef, emailRecord) => {
    try {
        await prisma.email.update({
            where: { id: emailRecordId },
            data: { status: client_1.EmailStatus.REPLIED, repliedAt: new Date() },
        });
        console.log("[followup] marked email as REPLIED:", emailRecordId);
    }
    catch (e) {
        console.warn("[followup] failed to update email record to REPLIED:", emailRecordId, e);
    }
    try {
        await prisma.influencer.update({
            where: { id: influencerId },
            data: { status: client_1.InfluencerStatus.NOT_SENT },
        });
        console.log("[followup] reset influencer status to NOT_SENT:", influencerId);
    }
    catch (e) {
        console.warn("[followup] failed to reset influencer status:", e);
    }
    if (emailRecord?.scheduledJobId) {
        try {
            await followUpQueueRef.remove(emailRecord.scheduledJobId);
            console.log("[followup] cancelled scheduled follow-up job:", emailRecord.scheduledJobId);
        }
        catch (e) {
            console.warn("[followup] failed to remove scheduled follow-up job:", emailRecord.scheduledJobId, e);
        }
    }
};
const handleNoReplyFallback = async (jobData) => {
    const { influencerId, emailRecordId, step = 1, userId } = jobData;
    if (step > 3) {
        console.warn("[followup] step beyond expected range, aborting:", step);
        return;
    }
    if (step === 3) {
        try {
            await prisma.influencer.update({
                where: { id: influencerId },
                data: { status: client_1.InfluencerStatus.REJECTED },
            });
        }
        catch (e) {
            console.warn("[followup] failed to set influencer to REJECTED:", e);
        }
        return;
    }
    const templateName = step === 1 ? TEMPLATE_24H : TEMPLATE_48H;
    const nextTemplate = await prisma.emailTemplate.findFirst({
        where: { name: templateName, isActive: true },
    });
    const sendDelay = process.env.NODE_ENV === "production"
        ? Number(process.env.PROD_FOLLOWUP_DELAY_MS)
        : Number(process.env.DEV_FOLLOWUP_DELAY_MS);
    if (!nextTemplate) {
        console.warn("[followup] Follow-up template not found:", templateName);
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
                await prisma.email.update({
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
    const influencer = await prisma.influencer.findUnique({
        where: { id: influencerId },
    });
    const user = await prisma.user.findUnique({ where: { id: userId } });
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
    const senderAddress = user?.googleEmail || user?.email || process.env.MAILGUN_FROM_EMAIL || "";
    const wrappedBody = (0, email_wrap_body_1.buildEmailHtml)(personalizedBody, influencer.name || "", senderAddress);
    let newEmail;
    try {
        newEmail = await prisma.email.create({
            data: {
                influencerId,
                templateId: nextTemplate.id,
                sentById: userId,
                subject: personalizedSubject,
                body: wrappedBody,
                status: client_1.EmailStatus.PENDING,
                isAutomation: true,
            },
        });
    }
    catch (e) {
        console.error("[followup] failed to create follow-up email record:", e);
        return;
    }
    try {
        await redis_queue_1.emailSendQueue.add("send-email", {
            userId,
            to: influencer.email,
            subject: personalizedSubject,
            body: wrappedBody,
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
    }
    const nextStatus = step === 1 ? client_1.InfluencerStatus.PING_2 : client_1.InfluencerStatus.PING_3;
    try {
        await prisma.influencer.update({
            where: { id: influencerId },
            data: { status: nextStatus, lastContactDate: new Date() },
        });
    }
    catch (e) {
        console.warn("[followup] failed to update influencer status:", e);
    }
    try {
        if (step === 1) {
            const nextCheckJob = await redis_queue_1.followUpQueue.add("follow-up-check", { influencerId, emailRecordId: newEmail.id, step: 2, userId }, {
                delay: sendDelay,
                attempts: 3,
                backoff: { type: "exponential", delay: 10000 },
            });
            await prisma.email.update({
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
            await prisma.email.update({
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
