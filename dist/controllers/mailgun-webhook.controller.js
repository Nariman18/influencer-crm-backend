"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMailgunWebhook = void 0;
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = __importDefault(require("../config/prisma"));
const client_1 = require("@prisma/client");
/**
 * Verify Mailgun webhook signature
 */
function verifyWebhookSignature(timestamp, token, signature) {
    const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!signingKey) {
        console.error("❌ [WEBHOOK] MAILGUN_WEBHOOK_SIGNING_KEY not configured");
        return false;
    }
    const encodedToken = crypto_1.default
        .createHmac("sha256", signingKey)
        .update(timestamp + token)
        .digest("hex");
    return encodedToken === signature;
}
/**
 * Handle Mailgun webhook events
 */
const handleMailgunWebhook = async (req, res) => {
    try {
        const { signature, "event-data": eventData } = req.body;
        // Verify webhook signature
        if (signature) {
            const isValid = verifyWebhookSignature(signature.timestamp, signature.token, signature.signature);
            if (!isValid) {
                console.error("❌ [WEBHOOK] Invalid webhook signature");
                res.status(403).json({ error: "Invalid signature" });
                return;
            }
        }
        const event = eventData?.event;
        const messageId = eventData?.message?.headers?.["message-id"];
        const recipientEmail = eventData?.recipient;
        console.log(`📧 [WEBHOOK] Received ${event} event for ${recipientEmail}`);
        if (!messageId) {
            console.warn("⚠️ [WEBHOOK] No message ID in webhook");
            res.status(200).json({ message: "No message ID" });
            return;
        }
        // Find email record by Mailgun message ID
        const emailRecord = await prisma_1.default.email.findFirst({
            where: {
                gmailMessageId: messageId,
            },
            include: {
                influencer: true,
            },
        });
        if (!emailRecord) {
            console.log(`⚠️ [WEBHOOK] Email record not found for message: ${messageId}`);
            res.status(200).json({ message: "Email not found" });
            return;
        }
        // Handle different webhook events
        // NOTE: Mailgun does NOT have a "replied" event
        // Reply detection is handled by Gmail API in emailAutomation.service.ts
        switch (event) {
            case "delivered":
                await handleDelivered(emailRecord);
                break;
            case "opened":
                await handleOpened(emailRecord);
                break;
            case "clicked":
                await handleClicked(emailRecord);
                break;
            case "unsubscribed":
                await handleUnsubscribed(emailRecord);
                break;
            case "complained":
                await handleComplained(emailRecord);
                break;
            case "failed":
            case "permanent_fail":
                await handleFailed(emailRecord, eventData);
                break;
            default:
                console.log(`ℹ️ [WEBHOOK] Unhandled event type: ${event}`);
        }
        res.status(200).json({ message: "Webhook processed" });
    }
    catch (error) {
        console.error("❌ [WEBHOOK] Error processing webhook:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
exports.handleMailgunWebhook = handleMailgunWebhook;
/**
 * Handle email delivered event
 */
async function handleDelivered(emailRecord) {
    console.log(`✅ [WEBHOOK] Email ${emailRecord.id} delivered to ${emailRecord.influencer.email}`);
    // Email is already marked as SENT by the queue worker
    // No action needed
}
/**
 * Handle email opened event
 */
async function handleOpened(emailRecord) {
    console.log(`👀 [WEBHOOK] Email ${emailRecord.id} opened by ${emailRecord.influencer.email}`);
    await prisma_1.default.email.update({
        where: { id: emailRecord.id },
        data: {
            status: client_1.EmailStatus.OPENED,
            openedAt: new Date(),
        },
    });
}
/**
 * Handle link clicked event
 */
async function handleClicked(emailRecord) {
    console.log(`🖱️ [WEBHOOK] Link clicked in email ${emailRecord.id} by ${emailRecord.influencer.email}`);
    // Update to OPENED if not already
    if (emailRecord.status === client_1.EmailStatus.SENT) {
        await prisma_1.default.email.update({
            where: { id: emailRecord.id },
            data: {
                status: client_1.EmailStatus.OPENED,
                openedAt: new Date(),
            },
        });
    }
}
/**
 * NOTE: Mailgun does NOT provide a "replied" webhook event
 * Reply detection is handled by Gmail API in emailAutomation.service.ts
 */
/**
 * Handle unsubscribe event
 */
async function handleUnsubscribed(emailRecord) {
    console.log(`🚫 [WEBHOOK] ${emailRecord.influencer.email} unsubscribed`);
    // Disable automation for this influencer
    await prisma_1.default.influencer.update({
        where: { id: emailRecord.influencer.id },
        data: {
            autoFollowUpEnabled: false,
            nextFollowUpDate: null,
            status: client_1.InfluencerStatus.REJECTED,
            notes: emailRecord.influencer.notes
                ? `${emailRecord.influencer.notes}\n\n[UNSUBSCRIBED via Mailgun]`
                : "[UNSUBSCRIBED via Mailgun]",
        },
    });
}
/**
 * Handle spam complaint event
 */
async function handleComplained(emailRecord) {
    console.log(`⚠️ [WEBHOOK] Spam complaint from ${emailRecord.influencer.email}`);
    // Disable automation and mark as rejected
    await prisma_1.default.influencer.update({
        where: { id: emailRecord.influencer.id },
        data: {
            autoFollowUpEnabled: false,
            nextFollowUpDate: null,
            status: client_1.InfluencerStatus.REJECTED,
            notes: emailRecord.influencer.notes
                ? `${emailRecord.influencer.notes}\n\n[SPAM COMPLAINT via Mailgun]`
                : "[SPAM COMPLAINT via Mailgun]",
        },
    });
}
/**
 * Handle email delivery failure
 */
async function handleFailed(emailRecord, eventData) {
    const reason = eventData?.["delivery-status"]?.message || "Unknown error";
    console.log(`❌ [WEBHOOK] Email ${emailRecord.id} failed: ${reason}`);
    await prisma_1.default.email.update({
        where: { id: emailRecord.id },
        data: {
            status: client_1.EmailStatus.FAILED,
            errorMessage: reason,
        },
    });
    // If permanent failure, disable automation
    if (eventData?.event === "permanent_fail") {
        await prisma_1.default.influencer.update({
            where: { id: emailRecord.influencer.id },
            data: {
                autoFollowUpEnabled: false,
                nextFollowUpDate: null,
                notes: emailRecord.influencer.notes
                    ? `${emailRecord.influencer.notes}\n\n[EMAIL FAILED: ${reason}]`
                    : `[EMAIL FAILED: ${reason}]`,
            },
        });
    }
}
