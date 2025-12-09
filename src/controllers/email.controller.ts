// src/controllers/email.controller.ts
import { Response } from "express";
import { getPrisma } from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { google } from "googleapis";
import { EmailStatus, InfluencerStatus } from "@prisma/client";
import redisQueue, { EmailJobData } from "../lib/redis-queue";
import { buildEmailHtml } from "../lib/email-wrap-body";
import { isSuppressedByMailgun, domainHasMX } from "../lib/mailgun-helpers";
import { canSendMore } from "../lib/warmup-tracker";

const prisma = getPrisma();
const OAuth2 = google.auth.OAuth2;

/**
 * Utility: sanitize local part + produce plus-addressing sender at MAILGUN_DOMAIN.
 * Example: "Anna Smith" and userId "abc" => anna.smith+abc@mail.imx.agency
 */
function sanitizeLocal(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+._-]/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 64);
}

/**
 * Build envelope sender email for manager.
 *
 * Default behaviour: return the stable team address (MAILGUN_FROM_EMAIL).
 * Optional: enable plus-addressing per-manager by setting USE_PLUS_ADDRESSING=true
 * (useful if you want per-user envelope addresses for tracking).
 */
function makeSenderEmailForManager(userId: string, fallbackEmail?: string) {
  const envFrom = process.env.MAILGUN_FROM_EMAIL || "";
  const domainFromEnv =
    process.env.MAILGUN_DOMAIN || envFrom.split("@").pop() || null;

  // If env toggle is set, create plus-addressed sender (e.g. nariman+<id>@domain)
  const usePlus =
    String(process.env.USE_PLUS_ADDRESSING || "").toLowerCase() === "true";

  if (usePlus && domainFromEnv) {
    const localSource = fallbackEmail
      ? String(fallbackEmail.split("@")[0] || `user-${userId}`)
      : `user-${userId}`;
    const local = sanitizeLocal(localSource || `user-${userId}`);
    return `${local}+${userId}@${domainFromEnv}`;
  }

  // Default: return the stable from email (team@mail.imx.agency) if valid,
  // otherwise try to fall back to a sensible plus-address as a last resort.
  if (envFrom && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envFrom)) {
    return envFrom;
  }

  // Fallback: attempt plus-addressing if domain known
  if (domainFromEnv) {
    return `team+${userId}@${domainFromEnv}`;
  }

  return `team+${userId}@example.invalid`;
}

export class EmailService {
  /**
   * Validate Gmail access tokens for the user.
   */
  public static async validateGmailAccess(userId: string): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          googleAccessToken: true,
          googleRefreshToken: true,
          googleEmail: true,
          name: true,
        },
      });

      if (
        !user?.googleAccessToken ||
        !user?.googleRefreshToken ||
        !user?.googleEmail
      ) {
        throw new Error(`No Gmail account connected for user ${userId}`);
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
        const tokenInfo = await oauth2Client.getTokenInfo(
          user.googleAccessToken
        );
        console.log(
          "Token valid, expires at:",
          new Date(tokenInfo.expiry_date!)
        );
      } catch {
        console.log("Refreshing token...");
        const { credentials } = await oauth2Client.refreshAccessToken();
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
          oauth2Client.setCredentials(credentials);
        }
      }

      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      await gmail.users.getProfile({ userId: "me" });
      return true;
    } catch (error) {
      console.error("Gmail access validation failed:", error);
      throw new Error(
        `Failed to validate Gmail access: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Explicit Gmail API send helper (renamed to avoid collision with the controller function).
   * Returns messageId + sentAt if successful.
   */
  static async sendViaGmail(
    userId: string,
    to: string,
    subject: string,
    body: string,
    influencerName: string
  ): Promise<{ messageId: string; sentAt: Date }> {
    console.log(`Starting Gmail API send process to: ${to}`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Attempt ${attempt} to send email via Gmail API`);

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            googleAccessToken: true,
            googleRefreshToken: true,
            googleEmail: true,
            name: true,
            email: true,
          },
        });

        if (
          !user?.googleAccessToken ||
          !user?.googleRefreshToken ||
          !user?.googleEmail
        ) {
          throw new Error("No Google account connected");
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
          console.log("Access token is valid");
        } catch (tokenError) {
          console.log("Refreshing access token...");
          const { credentials } = await oauth2Client.refreshAccessToken();
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
            oauth2Client.setCredentials(credentials);
          }
        }

        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        const senderAddress =
          user.googleEmail ||
          user.email ||
          process.env.MAILGUN_FROM_EMAIL ||
          "team@mail.imx.agency";

        // Build wrapped HTML using senderAddress as the visible reply/sender
        const wrappedHtml = buildEmailHtml(
          body,
          influencerName,
          senderAddress,
          user.name || undefined,
          to // recipientEmail parameter
        );

        const emailLines = [
          `From: "${user.name || "IMX Agency"}" <${senderAddress}>`,
          `To: ${to}`,
          `Subject: ${subject}`,
          "Content-Type: text/html; charset=utf-8",
          "MIME-Version: 1.0",
          "",
          wrappedHtml,
        ];

        const email = emailLines.join("\r\n").trim();

        const base64Email = Buffer.from(email)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        console.log("Sending email via Gmail API...", {
          from: senderAddress,
          to,
          subject: subject.substring(0, 50) + "...",
        });

        const response = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: base64Email,
          },
        });

        console.log("Email sent successfully via Gmail API:", {
          messageId: response.data.id,
          threadId: response.data.threadId,
        });

        return {
          messageId: response.data.id!,
          sentAt: new Date(),
        };
      } catch (error) {
        lastError = error as Error;
        console.error(`Gmail API attempt ${attempt} failed:`, error);
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    const errorMessage = `Failed to send email after 2 attempts via Gmail API: ${
      lastError?.message || "Unknown error"
    }`;
    console.error("FINAL GMAIL API SEND FAILURE:", errorMessage);
    throw new Error(errorMessage);
  }
}

/* -------------------------
   Controller: validateEmailConfig
   ------------------------- */
export const validateEmailConfig = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        googleAccessToken: true,
        googleRefreshToken: true,
        googleEmail: true,
        email: true,
        name: true,
      },
    });

    if (
      !user?.googleAccessToken ||
      !user?.googleRefreshToken ||
      !user?.googleEmail
    ) {
      res.json({
        isValid: false,
        message: "No Google account connected",
        hasTokens: false,
        gmailAddress: null,
      });
      return;
    }

    try {
      await EmailService.validateGmailAccess(req.user.id);

      res.json({
        isValid: true,
        message: "Gmail API configuration is valid and ready to send emails",
        hasTokens: true,
        gmailAddress: user.googleEmail,
        userName: user.name,
      });
    } catch (error) {
      res.json({
        isValid: false,
        message: `Gmail API configuration test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        hasTokens: true,
        gmailAddress: user.googleEmail,
        userName: user.name,
      });
    }
  } catch (error) {
    console.error("Email configuration validation error:", error);
    throw new AppError("Failed to validate email configuration", 500);
  }
};

/* -------------------------
   Helpers
   ------------------------- */
const replaceVariables = (
  text: string,
  variables: Record<string, string>
): string => {
  let result = text;
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, "g");
    result = result.replace(regex, value);
  });
  return result;
};

/* -------------------------
   Controller: sendEmail (queueing single email)
   ------------------------- */
export const sendEmail = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  console.log(" ========== QUEUEING EMAIL REQUEST ==========");
  try {
    if (!req.user) throw new AppError("Not authenticated", 401);

    const {
      influencerId,
      templateId,
      variables,
      subject: customSubject,
      body: customBody,
    } = req.body;

    if (!influencerId) throw new AppError("Influencer ID is required", 400);

    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        googleAccessToken: true,
        googleRefreshToken: true,
        email: true,
        googleEmail: true,
      },
    });

    if (!currentUser?.googleAccessToken || !currentUser?.googleRefreshToken) {
      throw new AppError(
        "No Google account connected. Please connect your Gmail account first.",
        400
      );
    }

    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
    });

    if (!influencer) throw new AppError("Influencer not found", 404);
    if (!influencer.email)
      throw new AppError("Influencer has no email address", 404);

    let subject = "";
    let body = "";

    if (templateId) {
      const template = await prisma.emailTemplate.findUnique({
        where: { id: templateId },
      });
      if (!template) throw new AppError("Email template not found", 404);

      const personalizedVars = {
        ...variables,
        name: influencer.name,
        email: influencer.email,
        instagramHandle: influencer.instagramHandle || "",
      };

      subject = replaceVariables(template.subject, personalizedVars);
      body = replaceVariables(template.body, personalizedVars);
    } else {
      if (!customSubject || !customBody) {
        throw new AppError(
          "Subject and body are required when no template is provided",
          400
        );
      }
      subject = customSubject;
      body = customBody;
    }

    const senderUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, googleEmail: true, name: true },
    });

    // Visible display name (friendly)
    const visibleSenderName =
      senderUser?.name && String(senderUser.name).trim().length > 0
        ? `${senderUser.name}`
        : process.env.MAILGUN_FROM_NAME || "IMX Agency";

    // Reply-To should be manager's Gmail when available
    const replyToAddress =
      senderUser?.googleEmail ||
      senderUser?.email ||
      process.env.MAILGUN_FROM_EMAIL ||
      "";

    // Build wrapped HTML: signature shows manager name/email but underlying From for deliverability is stable
    const wrappedBody = buildEmailHtml(
      body,
      influencer.name || "",
      replyToAddress,
      senderUser?.name || undefined,
      influencer.email || undefined
    );

    const email = await prisma.email.create({
      data: {
        influencerId,
        templateId: templateId || null,
        sentById: req.user.id,
        subject,
        body: wrappedBody,
        status: EmailStatus.PENDING,
      },
    });

    // Build envelope sender (per-manager plus-addressing) for deliverability
    const envelopeSenderEmail = makeSenderEmailForManager(
      req.user.id,
      senderUser?.email || undefined
    );

    // Queue job: pass visible name + envelope email + replyTo
    await redisQueue.addEmailJob({
      userId: req.user.id,
      to: influencer.email!,
      subject,
      body: wrappedBody,
      influencerName: influencer.name,
      senderName: visibleSenderName, // readable display name
      senderEmail: envelopeSenderEmail, // valid envelope From address
      emailRecordId: email.id,
      influencerId: influencer.id,
      replyTo: replyToAddress, // manager Gmail
    });

    const queuedEmail = await prisma.email.findUnique({
      where: { id: email.id },
      include: {
        influencer: true,
        template: true,
        sentBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json(queuedEmail);
  } catch (error) {
    console.error("Queue email controller error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to queue email", 500);
  }
};

/* -------------------------
   Controller: bulkSendEmails
   ------------------------- */
export const bulkSendEmails = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) throw new AppError("Not authenticated", 401);

    const {
      influencerIds,
      templateId,
      variables,
      startAutomation = false,
      automationTemplates = [],
    } = req.body;

    if (!Array.isArray(influencerIds) || influencerIds.length === 0) {
      throw new AppError("Invalid influencer IDs", 400);
    }

    // WARM-UP CHECK
    const volumeCheck = await canSendMore(influencerIds.length);
    if (!volumeCheck.allowed) {
      throw new AppError(volumeCheck.message || "Daily limit reached", 429);
    }

    if (!templateId)
      throw new AppError("Template ID is required for bulk sending", 400);

    const template = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new AppError("Email template not found", 404);

    const jobsData: EmailJobData[] = [];
    const emailRecords: any[] = [];

    const automationMetaString =
      startAutomation && Array.isArray(automationTemplates)
        ? JSON.stringify({
            templates: automationTemplates,
            startedAt: new Date().toISOString(),
          })
        : null;

    const senderUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, googleEmail: true, name: true },
    });

    // Visible from (friendly) and reply-to (manager Gmail)
    const visibleSenderName =
      senderUser?.name && String(senderUser.name).trim().length > 0
        ? `${senderUser.name}`
        : process.env.MAILGUN_FROM_NAME || "IMX Agency";
    const replyToAddress =
      senderUser?.googleEmail ||
      senderUser?.email ||
      process.env.MAILGUN_FROM_EMAIL ||
      "";

    for (const influencerId of influencerIds) {
      try {
        const influencer = await prisma.influencer.findUnique({
          where: { id: influencerId },
        });
        if (!influencer || !influencer.email) continue;

        const to = influencer.email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          const failed = await prisma.email.create({
            data: {
              influencerId,
              templateId,
              sentById: req.user.id,
              subject: template.subject,
              body: "Invalid recipient email format",
              status: EmailStatus.FAILED,
              errorMessage: "Invalid recipient format",
            },
          });
          emailRecords.push(failed);
          continue;
        }

        // MX check
        const domain = to.split("@").pop() || "";
        const hasMx = await domainHasMX(domain);
        if (!hasMx) {
          const failed = await prisma.email.create({
            data: {
              influencerId,
              templateId,
              sentById: req.user.id,
              subject: template.subject,
              body: buildEmailHtml(
                replaceVariables(template.body, {
                  ...variables,
                  name: influencer.name,
                  email: influencer.email,
                }),
                influencer.name || "",
                replyToAddress,
                senderUser?.name || undefined,
                influencer.email || undefined
              ),
              status: EmailStatus.FAILED,
              errorMessage: `No MX records for domain: ${domain}`,
            },
          });
          emailRecords.push(failed);
          continue;
        }

        // Mailgun suppression check
        let suppressed = false;
        try {
          suppressed = await isSuppressedByMailgun(to);
        } catch (e) {
          console.warn("[bulkSendEmails] mailgun suppression check failed:", e);
        }
        if (suppressed) {
          const failed = await prisma.email.create({
            data: {
              influencerId,
              templateId,
              sentById: req.user.id,
              subject: template.subject,
              body: buildEmailHtml(
                replaceVariables(template.body, {
                  ...variables,
                  name: influencer.name,
                  email: influencer.email,
                }),
                influencer.name || "",
                replyToAddress,
                senderUser?.name || undefined,
                influencer.email || undefined
              ),
              status: EmailStatus.FAILED,
              errorMessage:
                "Recipient suppressed by Mailgun (bounced/complaint/unsubscribed)",
            },
          });
          emailRecords.push(failed);
          continue;
        }

        // Personalized content
        const personalizedVars = {
          ...variables,
          name: influencer.name,
          email: influencer.email,
          instagramHandle: influencer.instagramHandle || "",
        };

        const subject = replaceVariables(template.subject, personalizedVars);
        const body = replaceVariables(template.body, personalizedVars);

        const wrappedBody = buildEmailHtml(
          body,
          influencer.name || "",
          replyToAddress, // signature shows manager reply email
          senderUser?.name || undefined,
          influencer.email || undefined
        );

        const email = await prisma.email.create({
          data: {
            influencerId,
            templateId,
            sentById: req.user.id,
            subject,
            body: wrappedBody,
            status: EmailStatus.PENDING,
            ...(startAutomation ? { isAutomation: true } : {}),
            ...(startAutomation && automationMetaString
              ? { automationStepId: automationMetaString }
              : {}),
          },
        });

        // Build envelope sender (per-manager plus-addressing)
        const envelopeSenderEmail = makeSenderEmailForManager(
          req.user.id,
          senderUser?.email || undefined
        );

        const jobPayload: EmailJobData = {
          userId: req.user.id,
          to,
          subject,
          body: wrappedBody,
          influencerName: influencer.name,
          senderName: visibleSenderName, // human-friendly display name
          senderEmail: envelopeSenderEmail, // valid email: nariman+id@mail.imx.agency
          emailRecordId: email.id,
          influencerId: influencer.id,
          replyTo: replyToAddress, // manager gmail
        };

        if (startAutomation) {
          jobPayload.automation = {
            start: true,
            templates: Array.isArray(automationTemplates)
              ? automationTemplates
              : [],
          };
        }

        jobsData.push(jobPayload);
        emailRecords.push(email);
      } catch (error) {
        console.error(
          `Failed to prepare email for influencer ${influencerId}:`,
          error
        );
      }
    }

    const jobIds = await redisQueue.addBulkEmailJobs(jobsData, {
      intervalSec: Number(process.env.BULK_SEND_INTERVAL_SEC) || undefined,
      jitterMs: Number(process.env.BULK_SEND_JITTER_MS) || undefined,
    });

    // Update influencer statuses (unchanged)
    if (startAutomation) {
      try {
        const queuedInfluencerIds = jobsData
          .map((j) => j.influencerId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0
          );

        if (queuedInfluencerIds.length > 0) {
          await prisma.influencer.updateMany({
            where: { id: { in: queuedInfluencerIds } },
            data: {
              status: InfluencerStatus.PING_1,
              lastContactDate: new Date(),
            },
          });
        }
      } catch (e) {
        console.warn("Failed to set influencers to PING_1 en masse:", e);
      }
    }

    res.json({
      success: jobIds.length,
      failed: influencerIds.length - jobIds.length,
      total: influencerIds.length,
      queued: jobIds.length,
      queuedIds: jobIds,
      message: `Queued ${jobIds.length} emails for processing`,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to bulk queue emails", 500);
  }
};

/* -------------------------
   Remaining endpoints (unchanged)
   ------------------------- */
export const getEmails = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const influencerId = req.query.influencerId as string | undefined;
    const status = req.query.status as EmailStatus | undefined;

    const skip = (page - 1) * limit;

    const where: any = {
      ...(influencerId && { influencerId }),
    };

    if (status && Object.values(EmailStatus).includes(status)) {
      where.status = status;
    }

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          influencer: {
            select: {
              id: true,
              name: true,
              email: true,
              instagramHandle: true,
            },
          },
          template: {
            select: {
              id: true,
              name: true,
            },
          },
          sentBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      prisma.email.count({ where }),
    ]);

    const response: PaginatedResponse<(typeof emails)[0]> = {
      data: emails,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    res.json(response);
  } catch (error) {
    throw new AppError("Failed to fetch emails", 500);
  }
};

export const getEmailStats = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const totalEmails = await prisma.email.count();
    const sentEmails = await prisma.email.count({ where: { status: "SENT" } });
    const failedEmails = await prisma.email.count({
      where: { status: "FAILED" },
    });
    const openedEmails = await prisma.email.count({
      where: { status: "OPENED" },
    });
    const repliedEmails = await prisma.email.count({
      where: { status: "REPLIED" },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const emailsToday = await prisma.email.count({
      where: {
        sentAt: {
          gte: today,
        },
        status: "SENT",
      },
    });

    res.json({
      total: totalEmails,
      sent: sentEmails,
      failed: failedEmails,
      opened: openedEmails,
      replied: repliedEmails,
      sentToday: emailsToday,
    });
  } catch (error) {
    throw new AppError("Failed to fetch email statistics", 500);
  }
};
