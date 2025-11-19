// src/controllers/email.controller.ts
import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { google } from "googleapis";
import { EmailStatus, InfluencerStatus } from "@prisma/client";
import redisQueue, { EmailJobData } from "../lib/redis-queue";
import { buildEmailHtml } from "../lib/email-wrap-body";

const OAuth2 = google.auth.OAuth2;

export class EmailService {
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

  static async sendEmail(
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
          "";

        // Wrap body with shared wrapper
        const wrappedHtml = buildEmailHtml(body, influencerName, senderAddress);

        const emailLines = [
          `From: "${
            user.name || "Influencer CRM Auto Mail"
          }" <${senderAddress}>`,
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

/* Controller functions (sendEmail, bulkSendEmails, etc.) */

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
    const senderAddress =
      senderUser?.googleEmail ||
      senderUser?.email ||
      process.env.MAILGUN_FROM_EMAIL ||
      "";

    // wrap HTML before saving & queuing
    const wrappedBody = buildEmailHtml(
      body,
      influencer.name || "",
      senderAddress
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

    await redisQueue.addEmailJob({
      userId: req.user.id,
      to: influencer.email!,
      subject,
      body: wrappedBody,
      influencerName: influencer.name,
      emailRecordId: email.id,
      influencerId: influencer.id,
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
    const senderAddress =
      senderUser?.googleEmail ||
      senderUser?.email ||
      process.env.MAILGUN_FROM_EMAIL ||
      "";

    for (const influencerId of influencerIds) {
      try {
        const influencer = await prisma.influencer.findUnique({
          where: { id: influencerId },
        });

        if (!influencer || !influencer.email) {
          continue;
        }

        const personalizedVars = {
          ...variables,
          name: influencer.name,
          email: influencer.email,
          instagramHandle: influencer.instagramHandle || "",
        };

        const subject = replaceVariables(template.subject, personalizedVars);
        const body = replaceVariables(template.body, personalizedVars);

        // wrap body HTML
        const wrappedBody = buildEmailHtml(
          body,
          influencer.name || "",
          senderAddress
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

        const jobPayload: any = {
          userId: req.user.id,
          to: influencer.email!,
          subject,
          body: wrappedBody,
          influencerName: influencer.name,
          emailRecordId: email.id,
          influencerId: influencer.id,
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
      intervalSec: Number(process.env.BULK_SEND_INTERVAL_SEC) || 5,
      jitterMs: Number(process.env.BULK_SEND_JITTER_MS) || 1500,
    });

    if (startAutomation) {
      try {
        await prisma.influencer.updateMany({
          where: { id: { in: influencerIds } },
          data: {
            status: InfluencerStatus.PING_1,
            lastContactDate: new Date(),
          },
        });
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
