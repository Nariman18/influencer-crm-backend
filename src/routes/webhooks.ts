// routes/webhooks.ts - ENHANCED VERSION
import express from "express";
import { getPrisma } from "../config/prisma";
import {
  isPermanentBounce,
  addToBounceList,
  categorizeBounceError,
} from "../lib/mailgun-helpers";

const router = express.Router();
const prisma = getPrisma();

router.post("/mailgun", express.json(), async (req, res) => {
  try {
    // Accept both { "event-data": {...} } and raw event
    const payload =
      req.body && req.body["event-data"] ? req.body["event-data"] : req.body;

    const msg = payload?.message || {};
    const headers = msg.headers || {};
    const crmEmailId =
      headers["X-CRM-EMAIL-ID"] ||
      headers["x-crm-email-id"] ||
      payload?.user_variables?.crmEmailId ||
      payload?.user_variables?.email_id ||
      payload?.user_variables?.crm_email_id ||
      null;

    const event = payload?.event || payload?.event_type || "unknown";
    const recipient =
      payload?.recipient ||
      payload?.recipient_email ||
      msg?.headers?.to ||
      null;
    const delivery =
      payload?.["delivery-status"] || payload?.delivery_status || null;

    // ✅ ENHANCED: Extract comprehensive error information
    const errorMessage =
      delivery?.message ||
      delivery?.description ||
      payload?.reason ||
      payload?.error ||
      msg?.["delivery-status"]?.message ||
      "";

    const severity = payload?.severity || delivery?.severity || null;
    const code = delivery?.code || payload?.code || null;

    // Log webhook for debugging
    console.log("[webhook] Mailgun event received:", {
      event,
      recipient,
      crmEmailId,
      code,
      severity,
      errorPreview: errorMessage.substring(0, 100),
    });

    // ✅ CRITICAL: Enhanced permanent bounce detection
    const isPermanent =
      severity === "permanent" ||
      delivery?.["bounce-type"] === "hard" ||
      payload?.["bounce-type"] === "hard" ||
      // Explicit 5.x.x SMTP code detection
      (typeof code === "number" && code >= 500 && code < 600) ||
      (typeof code === "string" && /^5\d{2}$/.test(code)) ||
      // Text-based detection
      isPermanentBounce(errorMessage) ||
      // ✅ EXPLICIT 5.1.1 detection (user does not exist)
      errorMessage.includes("5.1.1") ||
      errorMessage.toLowerCase().includes("does not exist") ||
      errorMessage.toLowerCase().includes("user unknown") ||
      errorMessage.toLowerCase().includes("no such user");

    // ✅ Get detailed error category
    const errorCategory = categorizeBounceError(errorMessage, code, severity);

    console.log("[webhook] Error analysis:", {
      isPermanent,
      errorCategory,
      code,
      severity,
      recipient,
    });

    // If we have CRM email ID, update that email row with event info
    if (crmEmailId) {
      try {
        const updateData: any = {
          errorMessage: JSON.stringify({
            event,
            code,
            severity,
            message: errorMessage,
            category: errorCategory,
            timestamp: new Date().toISOString(),
          }).slice(0, 20000),
        };

        // Set status based on event
        if (event === "delivered") {
          updateData.status = "SENT";
          updateData.sentAt = new Date();
          console.log("[webhook] ✓ Email delivered successfully:", crmEmailId);
        } else if (event === "opened") {
          updateData.status = "OPENED";
          updateData.openedAt = new Date();
          console.log("[webhook] ✓ Email opened:", crmEmailId);
        } else if (event === "failed" || event === "bounced") {
          updateData.status = "FAILED";
          console.log(`[webhook] ✗ Email ${event}:`, crmEmailId, errorCategory);
        } else if (event === "complained") {
          updateData.status = "FAILED";
          console.log("[webhook] ✗ Email spam complaint:", crmEmailId);
        }

        await prisma.email.update({
          where: { id: String(crmEmailId) },
          data: updateData,
        });

        console.log("[webhook] ✓ Email record updated:", crmEmailId);
      } catch (uErr: any) {
        if (uErr?.code === "P2025") {
          console.warn(
            "[webhook] Email record not found:",
            crmEmailId,
            "- might have been deleted"
          );
        } else {
          console.error("[webhook] Failed to update email record:", uErr);
        }
      }
    } else {
      console.warn(
        "[webhook] No CRM email ID found in webhook - cannot update email record:",
        { event, recipient }
      );
    }

    // ✅ CRITICAL: Handle permanent bounces (including 5.1.1)
    if (isPermanent && recipient) {
      console.warn(`[webhook] ⚠️ PERMANENT BOUNCE detected for ${recipient}:`, {
        code,
        severity,
        errorCategory,
        errorPreview: errorMessage.substring(0, 200),
      });

      try {
        // Add to Mailgun bounce list to prevent future sends
        await addToBounceList(
          recipient,
          errorMessage || "Webhook-detected permanent bounce"
        );

        // Find ALL influencers with this email address
        const influencers = await prisma.influencer.findMany({
          where: {
            email: {
              equals: recipient,
              mode: "insensitive",
            },
          },
          select: { id: true, name: true, status: true },
        });

        const influencerIds = influencers.map((i) => i.id);

        if (influencerIds.length > 0) {
          console.log(
            `[webhook] Found ${influencerIds.length} influencer(s) with bounced email:`,
            recipient
          );

          // ✅ Mark influencer(s) as REJECTED
          const updateResult = await prisma.influencer.updateMany({
            where: { id: { in: influencerIds } },
            data: {
              status: "REJECTED",
              notes: {
                set: `Email bounced (${errorCategory}): ${errorMessage.substring(
                  0,
                  200
                )}`,
              },
            },
          });

          console.log(
            `[webhook] ✓ Marked ${updateResult.count} influencer(s) as REJECTED:`,
            recipient
          );

          // ✅ Mark ALL pending/queued emails for these influencers as FAILED
          const emailUpdateResult = await prisma.email.updateMany({
            where: {
              influencerId: { in: influencerIds },
              status: { in: ["PENDING", "QUEUED", "PROCESSING"] },
            },
            data: {
              status: "FAILED",
              errorMessage: JSON.stringify({
                reason: "Influencer email permanently bounced",
                originalBounce: {
                  code,
                  severity,
                  message: errorMessage.substring(0, 500),
                  category: errorCategory,
                },
                timestamp: new Date().toISOString(),
              }).slice(0, 20000),
            },
          });

          console.log(
            `[webhook] ✓ Cancelled ${emailUpdateResult.count} pending email(s) for bounced recipient`
          );

          // ✅ Also update the specific email that bounced
          if (crmEmailId) {
            try {
              await prisma.email.update({
                where: { id: String(crmEmailId) },
                data: {
                  status: "FAILED",
                  errorMessage: JSON.stringify({
                    event,
                    code,
                    severity,
                    message: errorMessage,
                    category: errorCategory,
                    permanentBounce: true,
                    timestamp: new Date().toISOString(),
                  }).slice(0, 20000),
                },
              });
            } catch (e) {
              console.warn(
                "[webhook] Failed to update bounced email record:",
                e
              );
            }
          }
        } else {
          console.warn(
            "[webhook] No influencers found with bounced email:",
            recipient
          );
        }
      } catch (e) {
        console.error(
          "[webhook] Failed to process permanent bounce:",
          e,
          recipient
        );
      }
    }

    // ✅ Handle temporary failures (log but don't reject influencer)
    if (
      (event === "failed" || event === "bounced") &&
      !isPermanent &&
      severity === "temporary"
    ) {
      console.log(
        `[webhook] Temporary failure for ${recipient} - will retry:`,
        {
          code,
          retrySeconds: delivery?.retry_seconds,
          errorPreview: errorMessage.substring(0, 100),
        }
      );

      if (crmEmailId) {
        try {
          await prisma.email.update({
            where: { id: String(crmEmailId) },
            data: {
              errorMessage: JSON.stringify({
                event,
                code,
                severity: "temporary",
                message: errorMessage,
                retrySeconds: delivery?.retry_seconds,
                timestamp: new Date().toISOString(),
              }).slice(0, 20000),
            },
          });
        } catch (e) {
          console.warn("[webhook] Failed to log temporary failure:", e);
        }
      }
    }

    // ✅ Handle spam complaints
    if (event === "complained") {
      console.warn(`[webhook] ⚠️ SPAM COMPLAINT from ${recipient}`);

      try {
        const influencers = await prisma.influencer.findMany({
          where: { email: { equals: recipient, mode: "insensitive" } },
          select: { id: true },
        });

        if (influencers.length > 0) {
          const influencerIds = influencers.map((i) => i.id);

          await prisma.influencer.updateMany({
            where: { id: { in: influencerIds } },
            data: {
              status: "REJECTED",
              notes: { set: "Marked email as spam - do not contact again" },
            },
          });

          console.log(
            `[webhook] ✓ Marked ${influencers.length} influencer(s) as REJECTED due to spam complaint`
          );
        }
      } catch (e) {
        console.error("[webhook] Failed to process spam complaint:", e);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("[webhook] Mailgun webhook processing error:", err);
    res.status(500).send("internal");
  }
});

export default router;
