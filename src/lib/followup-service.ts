// src/lib/followup-service.ts
import { getPrisma } from "../config/prisma";
import { google } from "googleapis";
import { emailSendQueue, followUpQueue } from "./redis-queue";
import { EmailStatus, InfluencerStatus } from "@prisma/client";
import { buildEmailHtml } from "./email-wrap-body";

const prisma = getPrisma();
const OAuth2 = google.auth.OAuth2;

const TEMPLATE_24H = process.env.FOLLOWUP_TEMPLATE_24H || "24-Hour Reminder";
const TEMPLATE_48H = process.env.FOLLOWUP_TEMPLATE_48H || "48-Hour Reminder";

/**
 * Helper: ensure OAuth2 client tokens are valid (refresh when needed).
 * Accepts both older and some newer googleapis method names (defensive).
 */
const ensureValidGoogleClient = async (
  user: {
    googleAccessToken?: string | null;
    googleRefreshToken?: string | null;
  },
  oauth2Client: any
) => {
  oauth2Client.setCredentials({
    access_token: user.googleAccessToken as string | undefined,
    refresh_token: user.googleRefreshToken as string | undefined,
  });

  try {
    if (user.googleAccessToken) {
      // tokenInfo will throw if token invalid/expired
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await oauth2Client.getTokenInfo(user.googleAccessToken);
      return;
    }
  } catch (err) {
    // trying both older and newer API forms
    try {
      // older googleapis had refreshAccessToken()
      if (typeof oauth2Client.refreshAccessToken === "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
        return credentials;
      } else if (typeof oauth2Client.refreshToken === "function") {
        // some environments / versions expose refreshToken()
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const credentials = await oauth2Client.refreshToken(
          oauth2Client.credentials.refresh_token
        );
        oauth2Client.setCredentials(credentials);
        return credentials;
      } else if (typeof oauth2Client.getAccessToken === "function") {
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
    } catch (refreshErr) {
      throw refreshErr;
    }
  }
};

/**
 * Normalize Message-ID value: remove angle brackets and whitespace
 */
const normalizeMessageId = (v?: string | null): string | null => {
  if (!v || typeof v !== "string") return null;
  return v.replace(/[<>\s]/g, "").trim() || null;
};

/**
 * ✅ FIXED: Check candidate Gmail message headers with STRICT validation
 * to prevent false "REPLIED" statuses
 */
const isReplyToOriginal = (
  candidateHeaders: { [k: string]: string | undefined },
  originalMidNoAngle: string | null,
  influencerEmail: string | null,
  userGmailAddress: string | null,
  sentAt?: Date | null,
  originalSubject?: string | null
): boolean => {
  const hdr = (key: string) =>
    candidateHeaders[key.toLowerCase()] || candidateHeaders[key] || undefined;

  const from = (hdr("From") || "").toLowerCase();
  const to = (hdr("To") || hdr("Delivered-To") || "").toLowerCase();
  const subject = (hdr("Subject") || "").toLowerCase();
  const inReplyTo = (hdr("In-Reply-To") || "").trim();
  const references = (hdr("References") || "").trim();
  const msgid = normalizeMessageId(hdr("Message-ID") || hdr("Message-Id"));

  // ✅ STRICT CHECK 1: Message-ID matching (most reliable)
  if (originalMidNoAngle) {
    const inReplyNorm = normalizeMessageId(inReplyTo) || null;
    if (inReplyTo && inReplyNorm && inReplyNorm.includes(originalMidNoAngle)) {
      console.log("[followup] ✓ Valid reply detected via In-Reply-To:", {
        originalMid: originalMidNoAngle,
        inReplyTo: inReplyNorm,
      });
      return true;
    }

    if (references) {
      const parts = references.split(/\s+/).map((r) => normalizeMessageId(r));
      if (parts.some((r) => r && r === originalMidNoAngle)) {
        console.log("[followup] ✓ Valid reply detected via References:", {
          originalMid: originalMidNoAngle,
          references: parts,
        });
        return true;
      }
    }
  }

  // ✅ STRICT CHECK 2: Must have proper reply headers OR subject match
  const hasReplyHeaders = !!(inReplyTo || references);
  const hasReplySubject = originalSubject
    ? subject.includes(originalSubject.toLowerCase()) ||
      subject.startsWith("re:")
    : false;

  // ✅ STRICT CHECK 3: Basic from/to validation
  const validFrom =
    influencerEmail && from.includes(influencerEmail.toLowerCase());
  const validTo =
    userGmailAddress && to.includes(userGmailAddress.toLowerCase());

  // ❌ REJECT if doesn't have reply indicators
  if (!hasReplyHeaders && !hasReplySubject) {
    console.debug("[followup] ✗ Candidate REJECTED - lacks reply indicators:", {
      hasInReplyTo: !!inReplyTo,
      hasReferences: !!references,
      hasReplySubject,
      subject: subject.substring(0, 50),
      from: from.substring(0, 50),
    });
    return false;
  }

  // ✅ Accept only if has reply indicators + valid from/to
  const isValid = !!(
    validFrom &&
    validTo &&
    (hasReplyHeaders || hasReplySubject)
  );

  if (isValid) {
    console.log("[followup] ✓ Valid reply detected via headers/subject:", {
      hasReplyHeaders,
      hasReplySubject,
      from: from.substring(0, 50),
      subject: subject.substring(0, 50),
    });
  } else {
    console.debug("[followup] ✗ Candidate REJECTED - failed validation:", {
      validFrom,
      validTo,
      hasReplyHeaders,
      hasReplySubject,
    });
  }

  return isValid;
};

const extractHeaders = (msg: any) => {
  const headers: Record<string, string | undefined> = {};
  const parts = msg?.payload?.headers || [];
  for (const h of parts) {
    if (!h || !h.name) continue;
    headers[h.name.toLowerCase()] = h.value;
  }
  return headers;
};

export const checkForReplyAndHandle = async (jobData: any) => {
  const { influencerId, emailRecordId, step = 1, userId } = jobData;

  console.log("[followup] Starting reply check:", {
    influencerId,
    emailRecordId,
    step,
    userId,
  });

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

  if (emailRecord.status === EmailStatus.REPLIED) {
    console.log(
      "[followup] email already marked REPLIED; skipping",
      emailRecordId
    );
    return;
  }

  const mailgunMessageIdNormalized =
    emailRecord.mailgunMessageIdNormalized ||
    normalizeMessageId(emailRecord.mailgunMessageId) ||
    normalizeMessageId(emailRecord.mailgunId) ||
    null;

  const influencerEmail = emailRecord.influencer?.email || null;
  const userGmailAddress = user.googleEmail || user.email || null;

  console.log("[followup] Search parameters:", {
    mailgunMessageIdNormalized,
    influencerEmail,
    userGmailAddress,
    originalSubject: emailRecord.subject?.substring(0, 50),
    sentAt: emailRecord.sentAt?.toISOString(),
  });

  const afterEpochBufferSec = 30;
  let afterEpoch: number | null = null;
  if (emailRecord.sentAt) {
    afterEpoch =
      Math.floor(emailRecord.sentAt.getTime() / 1000) - afterEpochBufferSec;
  }

  if (!user.googleAccessToken || !user.googleRefreshToken) {
    console.warn(
      "[followup] user has no google tokens; cannot check replies for user",
      userId
    );
    return await handleNoReplyFallback(jobData);
  }

  const oauth2Client = new OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );

  try {
    oauth2Client.setCredentials({
      access_token: user.googleAccessToken as string,
      refresh_token: user.googleRefreshToken as string,
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await oauth2Client.getTokenInfo(user.googleAccessToken as string);
    } catch (tokenErr) {
      try {
        await ensureValidGoogleClient(user as any, oauth2Client);
        const newCreds = oauth2Client.credentials as any;
        if (newCreds?.access_token) {
          const updateData: any = { googleAccessToken: newCreds.access_token };
          if (newCreds.refresh_token)
            updateData.googleRefreshToken = newCreds.refresh_token;
          try {
            await prisma.user.update({
              where: { id: userId },
              data: updateData,
            });
            console.log(
              "[followup] persisted refreshed google tokens for user:",
              userId
            );
          } catch (uErr) {
            console.warn(
              "[followup] failed to persist refreshed google tokens:",
              uErr
            );
          }
        }
      } catch (refreshErr) {
        console.error("[followup] failed to refresh google token:", refreshErr);
        return await handleNoReplyFallback(jobData);
      }
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    let queriesTried: string[] = [];

    // First attempt: Search by Message-ID (most accurate)
    if (mailgunMessageIdNormalized) {
      const q =
        `rfc822msgid:${mailgunMessageIdNormalized}` +
        (afterEpoch ? ` after:${afterEpoch}` : "");
      queriesTried.push(q);
      console.log("[followup] Trying Gmail query (rfc822msgid):", q);

      try {
        const listResp = await gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: 50,
        });
        const candidates = listResp.data.messages || [];
        console.log(
          "[followup] Gmail.list (rfc822msgid) found:",
          candidates.length,
          "candidates"
        );

        if (candidates.length > 0) {
          for (const c of candidates) {
            try {
              const getResp = await gmail.users.messages.get({
                userId: "me",
                id: c.id!,
                format: "metadata",
              });
              const headersMap = extractHeaders(getResp.data);

              const valid = isReplyToOriginal(
                headersMap,
                mailgunMessageIdNormalized,
                influencerEmail,
                userGmailAddress,
                emailRecord.sentAt || null,
                emailRecord.subject || null
              );

              if (valid) {
                console.log("[followup] ✓ VALID REPLY FOUND via rfc822msgid");
                await markEmailReplied(
                  emailRecordId,
                  influencerId,
                  followUpQueue,
                  emailRecord
                );
                return;
              }
            } catch (gErr) {
              console.warn(
                "[followup] failed to fetch message metadata for candidate",
                c.id,
                gErr
              );
            }
          }
        }
      } catch (listErr) {
        console.error("[followup] gmail.list (rfc822msgid) failed:", listErr);
      }
    }

    // Second attempt: Fallback search by sender/subject
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
    if (afterEpoch) parts.push(`after:${afterEpoch}`);
    const fallbackQuery = parts.join(" ");
    queriesTried.push(fallbackQuery);
    console.log("[followup] Trying fallback Gmail query:", fallbackQuery);

    try {
      const listResp = await gmail.users.messages.list({
        userId: "me",
        q: fallbackQuery,
        maxResults: 50,
      });
      console.log(
        "[followup] Gmail.list (fallback) found:",
        (listResp.data.messages || []).length,
        "candidates"
      );

      const candidates = listResp.data.messages || [];
      if (!candidates.length) {
        console.log(
          "[followup] ✗ No reply found after checking all queries:",
          queriesTried
        );
        return await handleNoReplyFallback(jobData);
      }

      for (const c of candidates) {
        if (!c?.id) continue;
        try {
          const meta = await gmail.users.messages.get({
            userId: "me",
            id: c.id,
            format: "metadata",
          });
          const headersMap = extractHeaders(meta.data);

          let internalDate = Number(meta.data.internalDate || 0);

          // ✅ CRITICAL: Always check time - skip if no date or too old
          if (!internalDate || !emailRecord.sentAt) {
            console.debug(
              "[followup] ✗ Skipping candidate - missing date info:",
              c.id
            );
            continue;
          }

          const msgDate = new Date(internalDate);
          const sentAtWithBuffer =
            emailRecord.sentAt.getTime() - afterEpochBufferSec * 1000;

          if (msgDate.getTime() < sentAtWithBuffer) {
            console.debug(
              "[followup] ✗ Skipping candidate - older than sentAt:",
              c.id,
              {
                msgDate: msgDate.toISOString(),
                sentAt: emailRecord.sentAt.toISOString(),
              }
            );
            continue;
          }

          // ✅ Pass original subject for matching
          const valid = isReplyToOriginal(
            headersMap,
            mailgunMessageIdNormalized,
            influencerEmail,
            userGmailAddress,
            emailRecord.sentAt || null,
            emailRecord.subject || null
          );

          if (valid) {
            console.log("[followup] ✓ VALID REPLY FOUND via fallback search");
            await markEmailReplied(
              emailRecordId,
              influencerId,
              followUpQueue,
              emailRecord
            );
            return;
          }
        } catch (cErr) {
          console.warn("[followup] failed to inspect candidate:", c.id, cErr);
        }
      }

      console.log(
        "[followup] ✗ No valid replies found after examining all candidates"
      );
      return await handleNoReplyFallback(jobData);
    } catch (fallbackErr) {
      console.error("[followup] gmail.list (fallback) failed:", fallbackErr);
      return await handleNoReplyFallback(jobData);
    }
  } catch (err) {
    console.error("[followup] unexpected error in reply checking:", err);
    return await handleNoReplyFallback(jobData);
  }
};

const markEmailReplied = async (
  emailRecordId: string,
  influencerId: string,
  followUpQueueRef: any,
  emailRecord: any
) => {
  console.log("[followup] ✓ Marking email as REPLIED:", emailRecordId);

  try {
    await prisma.email.update({
      where: { id: emailRecordId },
      data: { status: EmailStatus.REPLIED, repliedAt: new Date() },
    });
    console.log("[followup] ✓ Email marked as REPLIED");
  } catch (e) {
    console.warn(
      "[followup] failed to update email record to REPLIED:",
      emailRecordId,
      e
    );
  }

  try {
    await prisma.influencer.update({
      where: { id: influencerId },
      data: { status: InfluencerStatus.NOT_SENT },
    });
    console.log(
      "[followup] ✓ Influencer status reset to NOT_SENT:",
      influencerId
    );
  } catch (e) {
    console.warn("[followup] failed to reset influencer status:", e);
  }

  if (emailRecord?.scheduledJobId) {
    try {
      await followUpQueueRef.remove(emailRecord.scheduledJobId);
      console.log(
        "[followup] ✓ Cancelled scheduled follow-up job:",
        emailRecord.scheduledJobId
      );
    } catch (e) {
      console.warn(
        "[followup] failed to remove scheduled follow-up job:",
        emailRecord.scheduledJobId,
        e
      );
    }
  }
};

const handleNoReplyFallback = async (jobData: any) => {
  const { influencerId, emailRecordId, step = 1, userId } = jobData;

  console.log("[followup] No reply detected, handling fallback:", {
    step,
    influencerId,
  });

  if (step > 3) {
    console.warn("[followup] step beyond expected range, aborting:", step);
    return;
  }

  if (step === 3) {
    console.log(
      "[followup] Final check complete, marking influencer as REJECTED"
    );
    try {
      await prisma.influencer.update({
        where: { id: influencerId },
        data: { status: InfluencerStatus.REJECTED },
      });
      console.log("[followup] ✓ Influencer marked as REJECTED");
    } catch (e) {
      console.warn("[followup] failed to set influencer to REJECTED:", e);
    }
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
    console.warn("[followup] Follow-up template not found:", templateName);

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

  console.log("[followup] Sending follow-up email:", {
    templateName,
    step,
    influencerEmail: influencer.email,
  });

  const personalizedSubject = nextTemplate.subject
    .replace(/{{name}}/g, influencer.name || "")
    .replace(/{{email}}/g, influencer.email || "");
  const personalizedBody = nextTemplate.body
    .replace(/{{name}}/g, influencer.name || "")
    .replace(/{{email}}/g, influencer.email || "");

  const senderAddress =
    user?.googleEmail || user?.email || process.env.MAILGUN_FROM_EMAIL || "";
  const wrappedBody = buildEmailHtml(
    personalizedBody,
    influencer.name || "",
    senderAddress,
    user?.name || undefined
  );

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
    console.log("[followup] ✓ Follow-up email record created:", newEmail.id);
  } catch (e) {
    console.error("[followup] failed to create follow-up email record:", e);
    return;
  }

  try {
    await emailSendQueue.add("send-email", {
      userId,
      to: influencer.email,
      subject: personalizedSubject,
      body: wrappedBody,
      influencerName: influencer.name,
      senderName: user?.name || undefined,
      emailRecordId: newEmail.id,
      influencerId,
      replyTo: user.googleEmail || process.env.MAILGUN_FROM_EMAIL,
    });
    console.log("[followup] ✓ Follow-up email queued for sending");
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
    console.log("[followup] ✓ Influencer status updated to:", nextStatus);
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
      console.log("[followup] ✓ Next follow-up check scheduled for step 2");
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
      console.log("[followup] ✓ Final follow-up check scheduled for step 3");
    }
  } catch (e) {
    console.warn("[followup] failed to schedule next follow-up check:", e);
  }
};

export default {
  checkForReplyAndHandle,
};
