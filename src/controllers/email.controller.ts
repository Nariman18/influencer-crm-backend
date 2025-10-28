import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import { EmailStatus } from "@prisma/client";

const OAuth2 = google.auth.OAuth2;

// Email service with proper Gmail OAuth2 implementation
class EmailService {
  public static async createTransporter(userId: string) {
    try {
      console.log("🔧 Creating email transporter for user:", userId);

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
        throw new Error(`No Gmail account connected for user ${userId}`);
      }

      console.log("📧 Using Gmail address:", user.googleEmail);
      console.log("🔑 Token status:", {
        accessTokenLength: user.googleAccessToken.length,
        refreshTokenLength: user.googleRefreshToken.length,
      });

      const oauth2Client = new OAuth2(
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_CLIENT_SECRET!,
        process.env.GOOGLE_REDIRECT_URI!
      );

      oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
      });

      let validAccessToken = user.googleAccessToken;

      // Force token refresh and validate with Gmail API
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (credentials.access_token) {
          validAccessToken = credentials.access_token;
          await prisma.user.update({
            where: { id: userId },
            data: {
              googleAccessToken: credentials.access_token,
              ...(credentials.refresh_token && {
                googleRefreshToken: credentials.refresh_token,
              }),
            },
          });
          console.log("✅ Token refreshed successfully");
        }
      } catch (refreshError: any) {
        console.error("❌ Token refresh failed:", refreshError);
        if (refreshError.response?.data?.error === "invalid_grant") {
          throw new Error(
            "Google authentication revoked. Please reconnect your account."
          );
        }
        throw new Error(`Token refresh failed: ${refreshError.message}`);
      }

      // Validate token with Gmail API
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      await gmail.users.labels.list({ userId: "me" }); // Test API access
      console.log("✅ Gmail API access confirmed with token");

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: user.googleEmail,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          refreshToken: user.googleRefreshToken,
          accessToken: validAccessToken,
        },
        debug: true, // Enable for detailed logs
        logger: true,
      });

      await transporter.verify();
      console.log("✅ Email transporter verified successfully");

      return transporter;
    } catch (error) {
      console.error("❌ Failed to create email transporter:", error);
      throw new Error(
        `Failed to initialize email service: ${
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
    console.log(`📧 Starting email send process to: ${to}`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt} to send email`);

        const transporter = await this.createTransporter(userId);

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, googleEmail: true },
        });

        const mailOptions = {
          from: {
            name: user?.name || "Influencer CRM",
            address: user?.googleEmail || "",
          },
          to,
          subject,
          html: this.wrapEmailBody(body, influencerName),
          text: body.replace(/<[^>]*>/g, ""),
          headers: {
            "X-Priority": "1",
            "X-Mailer": "InfluencerCRM",
            "Reply-To": user?.googleEmail || "",
          },
        };

        console.log("📤 Sending email...", {
          from: mailOptions.from.address,
          to: mailOptions.to,
          subject: mailOptions.subject.substring(0, 50) + "...",
        });

        const result = await transporter.sendMail(mailOptions);

        console.log("✅ Email sent successfully:", {
          messageId: result.messageId,
          response: result.response,
        });

        return {
          messageId: result.messageId,
          sentAt: new Date(),
        };
      } catch (error) {
        lastError = error as Error;
        console.error(`❌ Attempt ${attempt} failed:`, error);

        if (attempt < 2) {
          console.log("⏳ Waiting 2 seconds before retry...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // If all attempts failed
    const errorMessage = `Failed to send email after 2 attempts: ${
      lastError?.message || "Unknown error"
    }`;
    console.error("🔥", errorMessage);
    throw new Error(errorMessage);
  }

  private static wrapEmailBody(body: string, _influencerName: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #dc2626; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .footer { background: #1f2937; color: white; padding: 20px; text-align: center; font-size: 12px; border-radius: 8px; margin-top: 20px; }
            .signature { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
          </style>
        </head>
        <body>
          <div class="header">
            <h2>Influencer Collaboration</h2>
          </div>
          <div class="content">
            ${body.replace(/\n/g, "<br>")}
            <div class="signature">
              <p>Best regards,<br>Influencer CRM Team</p>
            </div>
          </div>
          <div class="footer">
            <p>This email was sent via Influencer CRM Platform</p>
          </div>
        </body>
      </html>
    `;
  }
} // END OF EmailService CLASS

// MOVE validateEmailConfig OUTSIDE the class
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

    console.log("🔧 Validating email configuration for user:", req.user.id);

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
      return; // ADD RETURN STATEMENT
    }

    console.log("🔧 Testing email configuration...");

    try {
      // Test the configuration by creating a transporter
      const transporter = await EmailService.createTransporter(req.user.id);

      // Test with a simple verification
      await transporter.verify();

      console.log("✅ Email configuration is valid");

      res.json({
        isValid: true,
        message: "Email configuration is valid and ready to send emails",
        hasTokens: true,
        gmailAddress: user.googleEmail,
        userName: user.name,
      });
    } catch (error) {
      console.error("❌ Email configuration test failed:", error);

      res.json({
        isValid: false,
        message: `Email configuration test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        hasTokens: true,
        gmailAddress: user.googleEmail,
        userName: user.name,
      });
    }
  } catch (error) {
    console.error("❌ Email configuration validation error:", error);
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

export const getEmails = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
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

export const sendEmail = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  console.log(" ========== SEND EMAIL REQUEST STARTED ==========");

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
        status: "PENDING",
      },
    });

    console.log("Email record created with ID:", email.id);

    try {
      console.log("Attempting to send email via Gmail API...");
      const sendResult = await EmailService.sendEmail(
        req.user.id,
        influencer.email,
        subject,
        body,
        influencer.name
      );

      console.log("Email sent successfully:", sendResult.messageId);

      // Update email record with success
      const updatedEmail = await prisma.email.update({
        where: { id: email.id },
        data: {
          status: "SENT",
          sentAt: sendResult.sentAt,
        },
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

      // Update influencer last contact date and advance pipeline status
      await prisma.influencer.update({
        where: { id: influencerId },
        data: {
          lastContactDate: new Date(),
          ...(influencer.status === "PING_1" && { status: "PING_2" }),
          ...(influencer.status === "PING_2" && { status: "PING_3" }),
        },
      });

      console.log("Email process completed successfully!");
      console.log("========== SEND EMAIL REQUEST COMPLETED ==========");
      res.json(updatedEmail);
    } catch (sendError) {
      console.error("Email sending failed:", sendError);

      // Update email record with failure
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: "FAILED",
          errorMessage:
            sendError instanceof Error ? sendError.message : "Unknown error",
        },
      });

      console.error("Email sending error details:", {
        error: sendError instanceof Error ? sendError.message : "Unknown",
        stack: sendError instanceof Error ? sendError.stack : undefined,
      });

      throw new AppError(
        `Failed to send email: ${
          sendError instanceof Error ? sendError.message : "Unknown error"
        }`,
        500
      );
    }
  } catch (error) {
    console.error("Send email controller error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to send email", 500);
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

    const results = {
      success: 0,
      failed: 0,
      errors: [] as Array<{ influencerId: string; error: string }>,
    };

    // Process emails sequentially to avoid rate limiting
    for (const influencerId of influencerIds) {
      try {
        const influencer = await prisma.influencer.findUnique({
          where: { id: influencerId },
        });

        if (!influencer || !influencer.email) {
          results.failed++;
          results.errors.push({
            influencerId,
            error: "Influencer not found or has no email",
          });
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

        // Create email record
        const email = await prisma.email.create({
          data: {
            influencerId,
            templateId,
            sentById: req.user.id,
            subject,
            body,
            status: "PENDING",
          },
        });

        try {
          // Send actual email
          await EmailService.sendEmail(
            req.user.id,
            influencer.email,
            subject,
            body,
            influencer.name
          );

          // Update email as sent
          await prisma.email.update({
            where: { id: email.id },
            data: {
              status: "SENT",
              sentAt: new Date(),
            },
          });

          // Update influencer
          await prisma.influencer.update({
            where: { id: influencerId },
            data: {
              lastContactDate: new Date(),
              ...(influencer.status === "PING_1" && { status: "PING_2" }),
              ...(influencer.status === "PING_2" && { status: "PING_3" }),
            },
          });

          results.success++;
        } catch (sendError) {
          await prisma.email.update({
            where: { id: email.id },
            data: {
              status: "FAILED",
              errorMessage:
                sendError instanceof Error
                  ? sendError.message
                  : "Unknown error",
            },
          });
          throw sendError;
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          influencerId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    res.json(results);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to bulk send emails", 500);
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
