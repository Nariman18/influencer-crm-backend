// routes/webhooks.ts
import express from "express";
import { getPrisma } from "../config/prisma";
const router = express.Router();

const prisma = getPrisma();

router.post("/mailgun", express.json(), async (req, res) => {
  try {
    // Mailgun may send different payload shapes; typical: event-data object
    const eventData = req.body["event-data"] || req.body;

    const messageHeaders = eventData && eventData["message"]?.headers;
    const crmEmailId =
      eventData["message"]?.headers?.["X-CRM-EMAIL-ID"] ||
      eventData["message"]?.headers?.["X-CRM-EMAIL-ID"];

    // fallback attempt to parse X-CRM-EMAIL-ID from custom-variables (Mailgun has "user-variables")
    const userVars = eventData["user-variables"] || eventData["user_variables"];
    const emailId = crmEmailId || userVars?.crmEmailId || userVars?.email_id;

    // event type
    const event = eventData.event || eventData["event"];

    if (!emailId) {
      // Could try to match by recipient + timestamp; skip if not found
      console.warn("Mailgun webhook received without CRM email id", eventData);
      return res.status(200).send("ok");
    }

    // map events
    if (event === "delivered") {
      await prisma.email.update({
        where: { id: emailId },
        data: { status: "SENT" },
      });
    } else if (event === "failed" || event === "bounced") {
      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: "FAILED",
          errorMessage:
            eventData["delivery-status"] || JSON.stringify(eventData),
        },
      });
    } else if (event === "opened") {
      await prisma.email.update({
        where: { id: emailId },
        data: { openedAt: new Date(), status: "OPENED" },
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Mailgun webhook error:", err);
    res.status(500).json({ error: "internal" });
  }
});

export default router;
