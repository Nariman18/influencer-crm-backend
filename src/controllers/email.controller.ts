import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { google } from "googleapis";
import { EmailStatus } from "@prisma/client";
import { EmailJobData, redisQueue } from "../lib/redis-queue";

const OAuth2 = google.auth.OAuth2;

// Email service with Gmail API implementation
export class EmailService {
  /**
   * Validate Gmail access and refresh tokens if needed
   */
  public static async validateGmailAccess(userId: string): Promise<boolean> {
    try {
      console.log("🔧 Validating Gmail access for user:", userId);

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

      console.log("📧 Using Gmail address:", user.googleEmail);

      const oauth2Client = new OAuth2(
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_CLIENT_SECRET!,
        process.env.GOOGLE_REDIRECT_URI!
      );

      oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
      });

      // Try to refresh token if expired
      try {
        const tokenInfo = await oauth2Client.getTokenInfo(
          user.googleAccessToken
        );
        console.log(
          "Token is valid, expires at:",
          new Date(tokenInfo.expiry_date!)
        );
      } catch (tokenError) {
        console.log("🔄 Token expired, refreshing...");
        const { credentials } = await oauth2Client.refreshAccessToken();

        if (credentials.access_token) {
          // Update user with new tokens
          await prisma.user.update({
            where: { id: userId },
            data: {
              googleAccessToken: credentials.access_token,
              ...(credentials.refresh_token && {
                googleRefreshToken: credentials.refresh_token,
              }),
            },
          });
          console.log("Token refreshed successfully");

          // Update OAuth client with new tokens
          oauth2Client.setCredentials(credentials);
        }
      }

      // Test Gmail API access
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      await gmail.users.getProfile({ userId: "me" });
      console.log("Gmail API access confirmed");

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
   * Send email using Gmail API
   */
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

        // Get user with Google tokens
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
          throw new Error("No Google account connected");
        }

        console.log("Using Gmail account:", user.googleEmail);

        // Create OAuth2 client
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
          console.log("Access token is valid");
        } catch (tokenError) {
          console.log("Refreshing access token...");
          const { credentials } = await oauth2Client.refreshAccessToken();
          if (credentials.access_token) {
            // Update user with new tokens
            await prisma.user.update({
              where: { id: userId },
              data: {
                googleAccessToken: credentials.access_token,
                ...(credentials.refresh_token && {
                  googleRefreshToken: credentials.refresh_token,
                }),
              },
            });
            console.log("Token refreshed successfully");

            // Update OAuth client with new tokens
            oauth2Client.setCredentials(credentials);
          }
        }

        // Create Gmail API client
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // Create email message in RFC 5322 format
        const emailLines = [
          `From: "${user.name || "Influencer CRM"}" <${user.googleEmail}>`,
          `To: ${to}`,
          `Subject: ${subject}`,
          "Content-Type: text/html; charset=utf-8",
          "MIME-Version: 1.0",
          "",
          this.wrapEmailBody(body, influencerName),
        ];

        const email = emailLines.join("\r\n").trim();

        // Encoding the email in base64 URL-safe format (required by Gmail API)
        const base64Email = Buffer.from(email)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        console.log("Sending email via Gmail API...", {
          from: user.googleEmail,
          to: to,
          subject: subject.substring(0, 50) + "...",
          bodyLength: body.length,
        });

        // Send the email using Gmail API
        const response = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: base64Email,
          },
        });

        console.log("Email sent successfully via Gmail API:", {
          messageId: response.data.id,
          threadId: response.data.threadId,
          labelIds: response.data.labelIds,
        });

        return {
          messageId: response.data.id!,
          sentAt: new Date(),
        };
      } catch (error) {
        lastError = error as Error;
        console.error(`Gmail API attempt ${attempt} failed:`, error);

        // Log detailed error information
        if (error instanceof Error) {
          console.error("Error details:", {
            name: error.name,
            message: error.message,
            stack: error.stack,
          });
        }

        if (attempt < 2) {
          console.log("Waiting 2 seconds before retry...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // If all attempts failed
    const errorMessage = `Failed to send email after 2 attempts via Gmail API: ${
      lastError?.message || "Unknown error"
    }`;
    console.error("FINAL GMAIL API SEND FAILURE:", errorMessage);
    throw new Error(errorMessage);
  }

  /**
   * Wrap email body with HTML template
   */
  private static wrapEmailBody(body: string, influencerName: string): string {
    return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { 
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
          line-height: 1.6; 
          color: #333; 
          max-width: 600px; 
          margin: 0 auto; 
          padding: 0;
          background-color: #f9fafb;
        }
        .container {
          background: white;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          margin: 20px;
        }
        .header { 
          background: #dc2626; 
          color: white; 
          padding: 24px 20px; 
          text-align: center; 
        }
        .header h2 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
        }
        .content { 
          padding: 32px 24px; 
          background: white;
        }
        .content-body {
          font-size: 16px;
          line-height: 1.7;
          color: #4b5563;
        }
        .footer { 
          background: #1f2937; 
          color: white; 
          padding: 20px; 
          text-align: center; 
          font-size: 12px; 
        }
        .signature { 
          margin-top: 24px; 
          padding-top: 24px; 
          border-top: 1px solid #e5e7eb; 
          color: #6b7280;
        }
        .influencer-name {
          color: #dc2626;
          font-weight: 600;
        }
        @media only screen and (max-width: 600px) {
          body {
            padding: 10px;
          }
          .container {
            margin: 10px;
          }
          .content {
            padding: 24px 20px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Influencer Collaboration</h2>
        </div>
        <div class="content">
          <div class="content-body">
            ${body.replace(/\n/g, "<br>")}
          </div>
          <div class="signature">
            <p>Best regards,<br><strong>Influencer CRM Team</strong></p>
          </div>
        </div>
        <div class="footer">
          <p>This email was sent to <span class="influencer-name">${influencerName}</span> via Influencer CRM Platform</p>
          <p>© ${new Date().getFullYear()} Influencer CRM. All rights reserved.</p>
        </div>
      </div>
    </body>
  </html>`;
  }
}

// Export the controller functions (keep your existing functions, they'll now use the Gmail API version)
/**
 * Validate email configuration for authenticated user
 */
export const validateEmailConfig = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    console.log("Validating email configuration for user:", req.user.id);

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

    console.log("Testing Gmail API configuration...");

    try {
      // Test the configuration by validating Gmail access
      await EmailService.validateGmailAccess(req.user.id);

      console.log("Gmail API configuration is valid");

      res.json({
        isValid: true,
        message: "Gmail API configuration is valid and ready to send emails",
        hasTokens: true,
        gmailAddress: user.googleEmail,
        userName: user.name,
      });
    } catch (error) {
      console.error("Gmail API configuration test failed:", error);

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
    console.log("🔧 Send email request received from user:", req.user?.id);

    if (!req.user) {
      console.error("No user in request");
      throw new AppError("Not authenticated", 401);
    }

    const {
      influencerId,
      templateId,
      variables,
      subject: customSubject,
      body: customBody,
    } = req.body;

    console.log("Request data:", {
      influencerId,
      templateId,
      hasVariables: !!variables,
      hasCustomSubject: !!customSubject,
      hasCustomBody: !!customBody,
    });

    // Validate required fields
    if (!influencerId) {
      console.error("Missing influencerId");
      throw new AppError("Influencer ID is required", 400);
    }

    // Check if user has Google auth configured
    console.log("Checking user Google auth configuration...");
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        googleAccessToken: true,
        googleRefreshToken: true,
        email: true,
      },
    });

    console.log("User Google auth status:", {
      email: currentUser?.email,
      hasAccessToken: !!currentUser?.googleAccessToken,
      hasRefreshToken: !!currentUser?.googleRefreshToken,
      accessTokenLength: currentUser?.googleAccessToken?.length,
      refreshTokenLength: currentUser?.googleRefreshToken?.length,
    });

    if (!currentUser?.googleAccessToken || !currentUser?.googleRefreshToken) {
      console.error("User missing Google tokens");
      throw new AppError(
        "No Google account connected. Please connect your Gmail account first.",
        400
      );
    }

    console.log("User has Google auth configured");

    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
    });

    if (!influencer) {
      console.error("Influencer not found:", influencerId);
      throw new AppError("Influencer not found", 404);
    }

    if (!influencer.email) {
      console.error("Influencer has no email:", influencerId);
      throw new AppError("Influencer has no email address", 404);
    }

    console.log("Processing email for influencer:", {
      id: influencer.id,
      name: influencer.name,
      email: influencer.email,
      status: influencer.status,
    });

    let subject = "";
    let body = "";

    if (templateId) {
      console.log("📝 Using template:", templateId);
      const template = await prisma.emailTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        console.error("Template not found:", templateId);
        throw new AppError("Email template not found", 404);
      }

      const personalizedVars = {
        ...variables,
        name: influencer.name,
        email: influencer.email,
        instagramHandle: influencer.instagramHandle || "",
      };

      subject = replaceVariables(template.subject, personalizedVars);
      body = replaceVariables(template.body, personalizedVars);
      console.log("Template applied successfully");
    } else {
      console.log("Using custom subject/body");
      if (!customSubject || !customBody) {
        console.error("Missing custom subject/body");
        throw new AppError(
          "Subject and body are required when no template is provided",
          400
        );
      }
      subject = customSubject;
      body = customBody;
      console.log("Custom content prepared");
    }

    console.log("Email content prepared:", {
      subject: subject.substring(0, 50) + "...",
      bodyLength: body.length,
    });

    // Create email record with PENDING status
    console.log("Creating email record in database...");
    const email = await prisma.email.create({
      data: {
        influencerId,
        templateId: templateId || null,
        sentById: req.user.id,
        subject,
        body,
        status: EmailStatus.PENDING,
      },
    });

    console.log("Email record created with ID:", email.id);

    // ADD TO REDIS QUEUE INSTEAD OF SENDING IMMEDIATELY
    await redisQueue.addEmailJob({
      userId: req.user.id,
      to: influencer.email!,
      subject,
      body,
      influencerName: influencer.name,
      emailRecordId: email.id,
      influencerId: influencer.id,
    });

    console.log("Email queued successfully!");

    // Return the email record immediately
    const queuedEmail = await prisma.email.findUnique({
      where: { id: email.id },
      include: {
        influencer: true,
        template: true,
        sentBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
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
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const { influencerIds, templateId, variables } = req.body;

    if (!Array.isArray(influencerIds) || influencerIds.length === 0) {
      throw new AppError("Invalid influencer IDs", 400);
    }

    if (!templateId) {
      throw new AppError("Template ID is required for bulk sending", 400);
    }

    const template = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new AppError("Email template not found", 404);
    }

    // Prepare all jobs first
    const jobsData: EmailJobData[] = [];
    const emailRecords: any[] = [];

    for (const influencerId of influencerIds) {
      try {
        const influencer = await prisma.influencer.findUnique({
          where: { id: influencerId },
        });

        if (!influencer || !influencer.email) {
          continue; // Skip influencers without email
        }

        const personalizedVars = {
          ...variables,
          name: influencer.name,
          email: influencer.email,
          instagramHandle: influencer.instagramHandle || "",
        };

        const subject = replaceVariables(template.subject, personalizedVars);
        const body = replaceVariables(template.body, personalizedVars);

        // Create email record
        const email = await prisma.email.create({
          data: {
            influencerId,
            templateId,
            sentById: req.user.id,
            subject,
            body,
            status: EmailStatus.PENDING,
          },
        });

        jobsData.push({
          userId: req.user.id,
          to: influencer.email!,
          subject,
          body,
          influencerName: influencer.name,
          emailRecordId: email.id,
          influencerId: influencer.id,
        });

        emailRecords.push(email);
      } catch (error) {
        console.error(
          `Failed to prepare email for influencer ${influencerId}:`,
          error
        );
      }
    }

    // Use bulk processing for better performance
    const jobIds = await redisQueue.addBulkEmailJobs(jobsData);

    res.json({
      success: jobIds.length,
      failed: influencerIds.length - jobIds.length,
      total: influencerIds.length,
      queued: jobIds.length,
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

    // Properly type the where clause with EmailStatus enum
    const where: any = {
      ...(influencerId && { influencerId }),
    };

    // Only add status filter if it's a valid EmailStatus
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

    // Emails sent today
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
