// routes/webhooks.ts
import express from "express";
import { getPrisma } from "../config/prisma";
import { isPermanentBounce, addToBounceList } from "../lib/mailgun-helpers";

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

    // ✅ Extract error message for categorization
    const errorMessage =
      delivery?.message || payload?.reason || delivery?.description || "";

    // If we have CRM email id, update that email row with event info
    if (crmEmailId) {
      try {
        const updateData: any = {
          errorMessage: JSON.stringify(payload).slice(0, 20000),
        };

        // Set status based on event
        if (event === "delivered") {
          updateData.status = "SENT";
          updateData.sentAt = new Date();
        } else if (event === "opened") {
          updateData.status = "OPENED";
        } else if (event === "failed" || event === "bounced") {
          updateData.status = "FAILED";
        }

        await prisma.email.update({
          where: { id: String(crmEmailId) },
          data: updateData,
        });
      } catch (uErr: any) {
        if (uErr?.code !== "P2025") {
          console.warn("[webhook] email update error", uErr);
        }
      }
    }

    // ✅ Enhanced permanent bounce detection
    const severity = payload?.severity || delivery?.severity || null;
    const bounceType =
      delivery?.["bounce-type"] || delivery?.bounce_type || null;
    const code = delivery?.code || null;

    const isPermanent =
      severity === "permanent" ||
      bounceType === "hard" ||
      (typeof code === "number" && code >= 500 && code < 600) ||
      isPermanentBounce(errorMessage);

    if (isPermanent && recipient) {
      console.warn(
        `[webhook] PERMANENT BOUNCE detected for ${recipient}:`,
        errorMessage
      );

      try {
        // Add to Mailgun bounce list
        await addToBounceList(
          recipient,
          errorMessage || "Webhook-detected permanent bounce"
        );

        // Find influencers with this recipient email
        const infls = await prisma.influencer.findMany({
          where: {
            email: recipient,
          },
          select: { id: true },
        });
        const influencerIds = infls.map((i) => i.id);

        if (influencerIds.length > 0) {
          // Mark influencer(s) rejected
          await prisma.influencer.updateMany({
            where: { id: { in: influencerIds } },
            data: { status: "REJECTED" },
          });

          console.log(
            `[webhook] Marked ${influencerIds.length} influencers as REJECTED: ${recipient}`
          );

          // Mark any email records for those influencers FAILED
          await prisma.email.updateMany({
            where: { influencerId: { in: influencerIds } },
            data: {
              status: "FAILED",
              errorMessage: JSON.stringify({
                mailgunEvent: payload,
                reason: "Permanent bounce detected via webhook",
              }).slice(0, 20000),
            },
          });
        }
      } catch (e) {
        console.warn("[webhook] permanent failure DB updates failed:", e);
      }
    }

    // Temporary failures: record details but don't mark influencer rejected
    if (
      payload?.event === "failed" &&
      severity === "temporary" &&
      delivery?.retry_seconds
    ) {
      if (crmEmailId) {
        try {
          await prisma.email.update({
            where: { id: String(crmEmailId) },
            data: {
              errorMessage: JSON.stringify({
                mailgunEvent: payload,
                reason: "Temporary failure - will retry",
              }).slice(0, 20000),
            },
          });
        } catch (e) {
          // ignore update failure for telemetry
        }
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Mailgun webhook error:", err);
    res.status(500).send("internal");
  }
});

export default router;
