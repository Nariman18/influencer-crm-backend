// src/lib/followup-service.ts
import prisma from "../config/prisma";
import { google } from "googleapis";
import { emailSendQueue, followUpQueue } from "./redis-queue";
import { EmailStatus, InfluencerStatus } from "@prisma/client";
import { buildEmailHtml } from "./email-wrap-body";

const OAuth2 = google.auth.OAuth2;

const TEMPLATE_24H = process.env.FOLLOWUP_TEMPLATE_24H || "24-Hour Reminder";
const TEMPLATE_48H = process.env.FOLLOWUP_TEMPLATE_48H || "48-Hour Reminder";

/**
 * jobData expected: { influencerId, emailRecordId, step, userId }
 */
export const checkForReplyAndHandle = async (jobData: any) => {
  const { influencerId, emailRecordId, step = 1, userId } = jobData;

  const emailRecord = await prisma.email.findUnique({
    where: { id: emailRecordId },
    include: { influencer: true, sentBy: true, template: true },
  });
  if (!emailRecord) {
    console.warn(
      "[followup] email record not found, aborting check",
      emailRecordId
    );
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.warn("[followup] user record not found, aborting check", userId);
    return;
  }

  if (emailRecord.status === EmailStatus.REPLIED) return;

  // Build Gmail query
  const gmailQueryParts: string[] = [];
  if (emailRecord.influencer?.email) {
    gmailQueryParts.push(`from:${emailRecord.influencer.email}`);
  } else {
    return await handleNoReplyFallback(jobData);
  }

  const subjectSnippet = (emailRecord.subject || "").replace(/"/g, "");
  gmailQueryParts.push(
    `subject:("${subjectSnippet}" OR "Re: ${subjectSnippet}" OR "re: ${subjectSnippet}")`
  );

  if (emailRecord.sentAt) {
    const afterEpoch = Math.floor(emailRecord.sentAt.getTime() / 1000);
    gmailQueryParts.push(`after:${afterEpoch}`);
  }

  const q = gmailQueryParts.join(" ");

  if (!user.googleAccessToken || !user.googleRefreshToken) {
    console.warn(
      "User has no Google tokens; skipping reply check for",
      user.id
    );
    return await handleNoReplyFallback(jobData);
  }

  const oauth2Client = new OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );

  oauth2Client.setCredentials({
    access_token: user.googleAccessToken,
    refresh_token: user.googleRefreshToken,
  });

  try {
    await oauth2Client.getTokenInfo(user.googleAccessToken);
  } catch (err) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      await prisma.user.update({
        where: { id: userId },
        data: {
          googleAccessToken: credentials.access_token,
          ...(credentials.refresh_token && {
            googleRefreshToken: credentials.refresh_token,
          }),
        },
      });
      oauth2Client.setCredentials(credentials);
    } catch (refreshErr) {
      console.error("Failed to refresh Google token:", refreshErr);
      return await handleNoReplyFallback(jobData);
    }
  }

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

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
        id: messages[0].id!,
      });
      const internalDate = Number(msg.data.internalDate || Date.now());
      const repliedAt = new Date(internalDate);

      try {
        await prisma.email.update({
          where: { id: emailRecordId },
          data: {
            status: EmailStatus.REPLIED,
            repliedAt,
          },
        });
      } catch (e) {
        console.warn(
          "[followup] failed to update email status to REPLIED:",
          emailRecordId,
          e
        );
      }

      try {
        await prisma.influencer.update({
          where: { id: influencerId },
          data: { status: InfluencerStatus.NOT_SENT },
        });
      } catch (e) {
        console.warn("[followup] failed to reset influencer status:", e);
      }

      // Cancel scheduled follow-up (if present)
      if (emailRecord.scheduledJobId) {
        try {
          await followUpQueue.remove(emailRecord.scheduledJobId);
        } catch (e) {
          console.warn(
            "Could not remove followup job",
            emailRecord.scheduledJobId,
            e
          );
        }
      }

      return;
    } else {
      // No replies found
      return await handleNoReplyFallback(jobData);
    }
  } catch (err) {
    console.error("Error checking Gmail for replies:", err);
    return await handleNoReplyFallback(jobData);
  }
};

const handleNoReplyFallback = async (jobData: any) => {
  const { influencerId, emailRecordId, step = 1, userId } = jobData;

  if (step > 3) {
    console.warn("[followup] step beyond expected range, aborting:", step);
    return;
  }

  if (step === 3) {
    try {
      await prisma.influencer.update({
        where: { id: influencerId },
        data: { status: InfluencerStatus.REJECTED },
      });
    } catch (e) {
      console.warn("[followup] failed to set influencer to REJECTED:", e);
    }
    // do NOT change historical email send statuses
    return;
  }

  const templateName = step === 1 ? TEMPLATE_24H : TEMPLATE_48H;

  const nextTemplate = await prisma.emailTemplate.findFirst({
    where: { name: templateName, isActive: true },
  });

  const sendDelay =
    process.env.NODE_ENV === "production"
      ? Number(process.env.PROD_FOLLOWUP_DELAY_MS)
      : Number(process.env.DEV_FOLLOWUP_DELAY_MS);

  if (!nextTemplate) {
    console.warn("Follow-up template not found:", templateName);

    const nextStep = step + 1;
    const nextDelay =
      step === 1
        ? sendDelay
        : Number(process.env.FOLLOWUP_FINAL_WAIT_MS || sendDelay);

    const nextJob = await followUpQueue.add(
      "follow-up-check",
      { influencerId, emailRecordId, step: nextStep, userId },
      {
        delay: nextDelay,
        attempts: 3,
        backoff: { type: "exponential", delay: 10000 },
      }
    );

    if (emailRecordId) {
      try {
        await prisma.email.update({
          where: { id: emailRecordId },
          data: { scheduledJobId: String(nextJob.id) },
        });
      } catch (e) {
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

  // Wrap follow-up HTML using user's email for reply links
  const senderAddress =
    user?.googleEmail || user?.email || process.env.MAILGUN_FROM_EMAIL || "";
  const wrappedBody = buildEmailHtml(
    personalizedBody,
    influencer.name || "",
    senderAddress
  );

  // Create follow-up email record
  let newEmail;
  try {
    newEmail = await prisma.email.create({
      data: {
        influencerId,
        templateId: nextTemplate.id,
        sentById: userId,
        subject: personalizedSubject,
        body: wrappedBody,
        status: EmailStatus.PENDING,
        isAutomation: true,
      },
    });
  } catch (e) {
    console.error("[followup] failed to create follow-up email record:", e);
    return;
  }

  // Enqueue send (replyTo set so replies are tracked)
  try {
    await emailSendQueue.add("send-email", {
      userId,
      to: influencer.email,
      subject: personalizedSubject,
      body: wrappedBody,
      influencerName: influencer.name,
      emailRecordId: newEmail.id,
      influencerId,
      replyTo: user.googleEmail || process.env.MAILGUN_FROM_EMAIL,
    });
  } catch (e) {
    console.error("[followup] failed to enqueue follow-up send:", e, {
      influencerId,
      emailRecordId: newEmail.id,
    });
  }

  const nextStatus =
    step === 1 ? InfluencerStatus.PING_2 : InfluencerStatus.PING_3;
  try {
    await prisma.influencer.update({
      where: { id: influencerId },
      data: { status: nextStatus, lastContactDate: new Date() },
    });
  } catch (e) {
    console.warn("[followup] failed to update influencer status:", e);
  }

  try {
    if (step === 1) {
      const nextCheckJob = await followUpQueue.add(
        "follow-up-check",
        { influencerId, emailRecordId: newEmail.id, step: 2, userId },
        {
          delay: sendDelay,
          attempts: 3,
          backoff: { type: "exponential", delay: 10000 },
        }
      );
      await prisma.email.update({
        where: { id: newEmail.id },
        data: { scheduledJobId: String(nextCheckJob.id) },
      });
    } else if (step === 2) {
      const finalWait = Number(process.env.FOLLOWUP_FINAL_WAIT_MS) || sendDelay;
      const finalCheckJob = await followUpQueue.add(
        "follow-up-check",
        { influencerId, emailRecordId: newEmail.id, step: 3, userId },
        {
          delay: finalWait,
          attempts: 3,
          backoff: { type: "exponential", delay: 10000 },
        }
      );
      await prisma.email.update({
        where: { id: newEmail.id },
        data: { scheduledJobId: String(finalCheckJob.id) },
      });
    }
  } catch (e) {
    console.warn("[followup] failed to schedule next follow-up check:", e);
  }
};

export default {
  checkForReplyAndHandle,
};
