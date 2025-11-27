// src/lib/reply-checker.ts
import { getPrisma } from "../config/prisma";
import { google } from "googleapis";
import { EmailStatus, InfluencerStatus } from "@prisma/client";
import IORedis from "ioredis";

const prisma = getPrisma();
const OAuth2 = google.auth.OAuth2;

// Redis publisher for Socket.IO notifications
let publisher: IORedis | null = null;

try {
  publisher = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  publisher.on("error", (err) => {
    console.warn("[reply-checker] Redis publisher error:", err);
  });
} catch (e) {
  console.warn("[reply-checker] Failed to create Redis publisher:", e);
}

/**
 * Normalize Message-ID value: remove angle brackets and whitespace
 */
const normalizeMessageId = (v?: string | null): string | null => {
  if (!v || typeof v !== "string") return null;
  return v.replace(/[<>\s]/g, "").trim() || null;
};

/**
 * Extract headers from Gmail message
 */
const extractHeaders = (msg: any) => {
  const headers: Record<string, string | undefined> = {};
  const parts = msg?.payload?.headers || [];
  for (const h of parts) {
    if (!h || !h.name) continue;
    headers[h.name.toLowerCase()] = h.value;
  }
  return headers;
};

/**
 * Check if Gmail message is a reply to our original email
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

  // CHECK 1: Message-ID matching (most reliable)
  if (originalMidNoAngle) {
    const inReplyNorm = normalizeMessageId(inReplyTo) || null;
    if (inReplyTo && inReplyNorm && inReplyNorm.includes(originalMidNoAngle)) {
      return true;
    }

    if (references) {
      const parts = references.split(/\s+/).map((r) => normalizeMessageId(r));
      if (parts.some((r) => r && r === originalMidNoAngle)) {
        return true;
      }
    }
  }

  // CHECK 2: Must have reply indicators
  const hasReplyHeaders = !!(inReplyTo || references);
  const hasReplySubject = originalSubject
    ? subject.includes(originalSubject.toLowerCase()) ||
      subject.startsWith("re:")
    : false;

  // CHECK 3: Basic from/to validation
  const validFrom =
    influencerEmail && from.includes(influencerEmail.toLowerCase());
  const validTo =
    userGmailAddress && to.includes(userGmailAddress.toLowerCase());

  if (!hasReplyHeaders && !hasReplySubject) {
    return false;
  }

  return !!(validFrom && validTo && (hasReplyHeaders || hasReplySubject));
};

/**
 * Check for reply to a specific email in Gmail
 */
async function checkEmailForReply(
  email: any,
  user: any,
  gmail: any
): Promise<boolean> {
  const mailgunMessageIdNormalized =
    email.mailgunMessageIdNormalized ||
    normalizeMessageId(email.mailgunMessageId) ||
    normalizeMessageId(email.mailgunId) ||
    null;

  const influencerEmail = email.influencer?.email || null;
  const userGmailAddress = user.googleEmail || user.email || null;

  if (!influencerEmail || !userGmailAddress) {
    return false;
  }

  const afterEpochBufferSec = 30;
  let afterEpoch: number | null = null;
  if (email.sentAt) {
    afterEpoch =
      Math.floor(email.sentAt.getTime() / 1000) - afterEpochBufferSec;
  }

  // Try searching by Message-ID first
  if (mailgunMessageIdNormalized) {
    const q =
      `rfc822msgid:${mailgunMessageIdNormalized}` +
      (afterEpoch ? ` after:${afterEpoch}` : "");

    try {
      const listResp = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 50,
      });
      const candidates = listResp.data.messages || [];

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
            email.sentAt || null,
            email.subject || null
          );

          if (valid) {
            console.log(
              `[reply-checker] ✓ Reply found for email ${email.id} via Message-ID`
            );
            return true;
          }
        } catch (gErr) {
          console.warn(
            `[reply-checker] Failed to fetch message metadata:`,
            c.id
          );
        }
      }
    } catch (listErr) {
      console.warn(`[reply-checker] Gmail Message-ID search failed:`, listErr);
    }
  }

  // Fallback: search by sender/subject
  const subjectSnippet = (email.subject || "")
    .replace(/"/g, "")
    .slice(0, 80)
    .trim();
  const subjectQuery = subjectSnippet
    ? `subject:("${subjectSnippet}" OR "Re: ${subjectSnippet}")`
    : "";
  const parts = [
    influencerEmail ? `from:${influencerEmail}` : "",
    "in:inbox",
    userGmailAddress ? `to:${userGmailAddress}` : "",
    subjectQuery,
  ].filter(Boolean);
  if (afterEpoch) parts.push(`after:${afterEpoch}`);
  const fallbackQuery = parts.join(" ");

  try {
    const listResp = await gmail.users.messages.list({
      userId: "me",
      q: fallbackQuery,
      maxResults: 50,
    });

    const candidates = listResp.data.messages || [];

    for (const c of candidates) {
      if (!c?.id) continue;
      try {
        const meta = await gmail.users.messages.get({
          userId: "me",
          id: c.id,
          format: "metadata",
        });
        const headersMap = extractHeaders(meta.data);

        const internalDate = Number(meta.data.internalDate || 0);
        if (!internalDate || !email.sentAt) continue;

        const msgDate = new Date(internalDate);
        const sentAtWithBuffer =
          email.sentAt.getTime() - afterEpochBufferSec * 1000;

        if (msgDate.getTime() < sentAtWithBuffer) continue;

        const valid = isReplyToOriginal(
          headersMap,
          mailgunMessageIdNormalized,
          influencerEmail,
          userGmailAddress,
          email.sentAt || null,
          email.subject || null
        );

        if (valid) {
          console.log(
            `[reply-checker] ✓ Reply found for email ${email.id} via fallback search`
          );
          return true;
        }
      } catch (cErr) {
        console.warn(`[reply-checker] Failed to inspect candidate:`, c.id);
      }
    }
  } catch (fallbackErr) {
    console.warn(`[reply-checker] Gmail fallback search failed:`, fallbackErr);
  }

  return false;
}

/**
 * Notify manager via Socket.IO about reply detection
 */
async function notifyManagerOfReply(
  managerId: string,
  emailId: string,
  influencerId: string,
  influencerEmail: string
) {
  if (!publisher) {
    console.warn(
      "[reply-checker] Redis publisher not available for Socket.IO notification"
    );
    return;
  }

  try {
    const payload = {
      managerId,
      emailId,
      influencerId,
      influencerEmail,
      timestamp: new Date().toISOString(),
      type: "REPLY_DETECTED",
    };

    await publisher.publish(
      `reply:detected:${managerId}`,
      JSON.stringify(payload)
    );

    console.log(
      `[reply-checker] 📨 Socket.IO notification sent to manager ${managerId}`
    );
  } catch (e) {
    console.warn("[reply-checker] Failed to send Socket.IO notification:", e);
  }
}

/**
 * ✅ Check for replies for a SPECIFIC USER (on-demand)
 * Used for manual triggers or future Gmail Push Notifications
 */
export async function checkUserReplies(userId: string): Promise<{
  checked: number;
  replied: number;
  errors: number;
}> {
  console.log(`[reply-checker] 🔍 Checking replies for user ${userId}...`);

  const stats = {
    checked: 0,
    replied: 0,
    errors: 0,
  };

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        googleAccessToken: true,
        googleRefreshToken: true,
        googleEmail: true,
        email: true,
      },
    });

    if (!user || !user.googleAccessToken || !user.googleRefreshToken) {
      console.warn(`[reply-checker] User ${userId} has no Gmail tokens`);
      return stats;
    }

    // Find recent SENT emails from last 7 days
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const sentEmails = await prisma.email.findMany({
      where: {
        sentById: userId,
        status: EmailStatus.SENT, // ✅ Only check SENT emails
        sentAt: {
          gte: cutoffDate,
        },
      },
      include: {
        influencer: {
          select: { id: true, email: true, status: true },
        },
      },
      orderBy: { sentAt: "desc" },
      take: 200, // Check last 200 emails max
    });

    if (sentEmails.length === 0) {
      console.log(`[reply-checker] No recent SENT emails for user ${userId}`);
      return stats;
    }

    // Setup Gmail OAuth
    const oauth2Client = new OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );

    oauth2Client.setCredentials({
      access_token: user.googleAccessToken,
      refresh_token: user.googleRefreshToken,
    });

    // Refresh token if needed
    try {
      await oauth2Client.getTokenInfo(user.googleAccessToken);
    } catch (tokenErr) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);

        if (credentials.access_token) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              googleAccessToken: credentials.access_token,
              ...(credentials.refresh_token && {
                googleRefreshToken: credentials.refresh_token,
              }),
            },
          });
        }
      } catch (refreshErr) {
        console.error(
          `[reply-checker] Failed to refresh token for user ${userId}:`,
          refreshErr
        );
        stats.errors = sentEmails.length;
        return stats;
      }
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Check each email for replies
    for (const email of sentEmails) {
      stats.checked++;

      try {
        const hasReply = await checkEmailForReply(email, user, gmail);

        if (hasReply) {
          // ✅ CRITICAL: Double-check status before updating (race condition protection)
          const currentEmail = await prisma.email.findUnique({
            where: { id: email.id },
            select: { status: true },
          });

          if (currentEmail?.status === EmailStatus.REPLIED) {
            console.log(
              `[reply-checker] ✓ Email ${email.id} already marked REPLIED by another process, skipping`
            );
            continue; // Skip - already marked by followup-service or another checker
          }

          // Mark email as REPLIED
          await prisma.email.update({
            where: { id: email.id },
            data: {
              status: EmailStatus.REPLIED,
              repliedAt: new Date(),
            },
          });

          // Update influencer status to NOT_SENT
          await prisma.influencer.update({
            where: { id: email.influencer.id },
            data: {
              status: InfluencerStatus.NOT_SENT,
            },
          });

          stats.replied++;

          // Send real-time notification to manager
          await notifyManagerOfReply(
            userId,
            email.id,
            email.influencer.id,
            email.influencer.email || ""
          );

          console.log(
            `[reply-checker] ✓ Marked email ${email.id} as REPLIED for influencer ${email.influencer.id}`
          );
        }
      } catch (error) {
        console.error(
          `[reply-checker] Error checking email ${email.id}:`,
          error
        );
        stats.errors++;
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(
      `[reply-checker] ✓ User ${userId} check complete: ${stats.checked} checked, ${stats.replied} replied`
    );

    return stats;
  } catch (error) {
    console.error(`[reply-checker] Error checking user ${userId}:`, error);
    throw error;
  }
}

/**
 * Main function: Check all recent SENT emails for replies
 * Runs periodically to detect replies and mark emails as REPLIED
 */
export async function checkAllRecentReplies(): Promise<{
  checked: number;
  replied: number;
  errors: number;
}> {
  console.log("[reply-checker] 🔍 Starting periodic reply check...");

  const stats = {
    checked: 0,
    replied: 0,
    errors: 0,
  };

  try {
    // Find all SENT emails from last 7 days
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const sentEmails = await prisma.email.findMany({
      where: {
        status: EmailStatus.SENT, // ✅ Only fetch SENT emails (not REPLIED)
        sentAt: {
          gte: cutoffDate,
        },
      },
      include: {
        influencer: {
          select: { id: true, email: true, status: true },
        },
        sentBy: {
          select: {
            id: true,
            googleAccessToken: true,
            googleRefreshToken: true,
            googleEmail: true,
            email: true,
          },
        },
      },
      orderBy: { sentAt: "desc" },
      take: 500, // Process max 500 emails per run to avoid timeouts
    });

    console.log(
      `[reply-checker] Found ${sentEmails.length} SENT emails to check`
    );

    // Group emails by user to reuse Gmail OAuth connections
    const emailsByUser = new Map<string, typeof sentEmails>();
    for (const email of sentEmails) {
      const userId = email.sentBy.id;
      if (!emailsByUser.has(userId)) {
        emailsByUser.set(userId, []);
      }
      emailsByUser.get(userId)!.push(email);
    }

    // Process each user's emails
    for (const [userId, userEmails] of emailsByUser.entries()) {
      const user = userEmails[0].sentBy;

      if (!user.googleAccessToken || !user.googleRefreshToken) {
        console.warn(
          `[reply-checker] User ${userId} has no Gmail tokens, skipping ${userEmails.length} emails`
        );
        stats.errors += userEmails.length;
        continue;
      }

      // Setup Gmail OAuth
      const oauth2Client = new OAuth2(
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_CLIENT_SECRET!,
        process.env.GOOGLE_REDIRECT_URI!
      );

      oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
      });

      // Refresh token if needed
      try {
        await oauth2Client.getTokenInfo(user.googleAccessToken);
      } catch (tokenErr) {
        try {
          const { credentials } = await oauth2Client.refreshAccessToken();
          oauth2Client.setCredentials(credentials);

          if (credentials.access_token) {
            await prisma.user.update({
              where: { id: userId },
              data: {
                googleAccessToken: credentials.access_token,
                ...(credentials.refresh_token && {
                  googleRefreshToken: credentials.refresh_token,
                }),
              },
            });
          }
        } catch (refreshErr) {
          console.error(
            `[reply-checker] Failed to refresh token for user ${userId}:`,
            refreshErr
          );
          stats.errors += userEmails.length;
          continue;
        }
      }

      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      // Check each email for replies
      for (const email of userEmails) {
        stats.checked++;

        try {
          const hasReply = await checkEmailForReply(email, user, gmail);

          if (hasReply) {
            // ✅ CRITICAL: Double-check status before updating (race condition protection)
            const currentEmail = await prisma.email.findUnique({
              where: { id: email.id },
              select: { status: true },
            });

            if (currentEmail?.status === EmailStatus.REPLIED) {
              console.log(
                `[reply-checker] ✓ Email ${email.id} already marked REPLIED by another process, skipping`
              );
              continue; // Skip - already marked by followup-service or another checker
            }

            // Mark email as REPLIED
            await prisma.email.update({
              where: { id: email.id },
              data: {
                status: EmailStatus.REPLIED,
                repliedAt: new Date(),
              },
            });

            // Update influencer status to NOT_SENT
            await prisma.influencer.update({
              where: { id: email.influencer.id },
              data: {
                status: InfluencerStatus.NOT_SENT,
              },
            });

            stats.replied++;

            // Send real-time notification to manager
            await notifyManagerOfReply(
              userId,
              email.id,
              email.influencer.id,
              email.influencer.email || ""
            );

            console.log(
              `[reply-checker] ✓ Marked email ${email.id} as REPLIED for influencer ${email.influencer.id}`
            );
          }
        } catch (error) {
          console.error(
            `[reply-checker] Error checking email ${email.id}:`,
            error
          );
          stats.errors++;
        }

        // Add small delay between checks to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      console.log(
        `[reply-checker] ✓ Processed ${userEmails.length} emails for user ${userId}`
      );
    }

    console.log(
      `[reply-checker] ✅ Reply check complete: ${stats.checked} checked, ${stats.replied} replied, ${stats.errors} errors`
    );

    return stats;
  } catch (error) {
    console.error("[reply-checker] Fatal error in reply checking:", error);
    throw error;
  }
}

export default {
  checkAllRecentReplies,
  checkUserReplies,
};
