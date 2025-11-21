// routes/webhooks.ts
import express from "express";
import { getPrisma } from "../config/prisma";

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

    // If we have CRM email id, update that email row with event info
    if (crmEmailId) {
      try {
        const fullJson = JSON.stringify(payload);
        await prisma.email.update({
          where: { id: String(crmEmailId) },
          data: {
            errorMessage: fullJson.slice(0, 20000),
            status:
              event === "delivered"
                ? "SENT"
                : event === "opened"
                ? "OPENED"
                : "FAILED",
            ...(event === "delivered" ? { sentAt: new Date() } : {}),
          },
        });
      } catch (uErr: any) {
        // Prisma not found returns P2025; only log other errors
        if (uErr?.code !== "P2025") {
          console.warn("webhook email update error", uErr);
        }
      }
    }

    // examine delivery reasons to decide permanent vs temporary
    const severity = payload?.severity || delivery?.severity || null;
    const bounceType =
      delivery?.["bounce-type"] || delivery?.bounce_type || null;
    const code = delivery?.code || null;
    const reason = payload?.reason || delivery?.message || null;

    const isPermanent =
      severity === "permanent" ||
      bounceType === "hard" ||
      (typeof code === "number" && code >= 500 && code < 600) ||
      String(reason || "")
        .toLowerCase()
        .includes("not delivering") ||
      String(reason || "")
        .toLowerCase()
        .includes("mailbox unavailable");

    if (isPermanent && recipient) {
      try {
        // Find influencers that have this recipient email
        const infls = await prisma.influencer.findMany({
          where: { email: recipient },
          select: { id: true },
        });
        const influencerIds = infls.map((i) => i.id);

        if (influencerIds.length > 0) {
          // mark influencer(s) rejected
          await prisma.influencer.updateMany({
            where: { id: { in: influencerIds } },
            data: { status: "REJECTED" }, // ensure this matches your enum name
          });

          // mark any email records for those influencers FAILED and persist the event
          await prisma.email.updateMany({
            where: { influencerId: { in: influencerIds } },
            data: {
              status: "FAILED",
              errorMessage: JSON.stringify({ mailgunEvent: payload }).slice(
                0,
                20000
              ),
            },
          });
        } else {
          // no influencer found — optionally try to update by recipient in a "to" field if you have one
          // but avoid using unknown fields that Prisma doesn't expose.
        }
      } catch (e) {
        console.warn("webhook permanent failure DB updates failed:", e);
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
              errorMessage: JSON.stringify({ mailgunEvent: payload }).slice(
                0,
                20000
              ),
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
