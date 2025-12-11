// src/lib/gmail-sent-copy.ts (updated)
import { google } from "googleapis";
import { getPrisma } from "../config/prisma";

const prisma = getPrisma();
const OAuth2 = google.auth.OAuth2;

export interface GmailCopyOptions {
  userId: string;
  to: string;
  subject: string;
  htmlBody: string;
  replyTo?: string;
}

export const copyToGmailSent = async (
  opts: GmailCopyOptions
): Promise<{ success: boolean; messageId?: string; error?: string }> => {
  try {
    // Quick guard: disable sending to Gmail while auditing if env var set
    if (process.env.DISABLE_GMAIL_SENT_COPY === "true") {
      console.log(
        "[gmail-sent-copy] Disabled via DISABLE_GMAIL_SENT_COPY=true"
      );
      return { success: false, error: "gmail-sent-copy disabled for audit" };
    }

    // Get user's Google tokens
    const user = await prisma.user.findUnique({
      where: { id: opts.userId },
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
      return {
        success: false,
        error: "No Gmail account connected for user",
      };
    }

    // Logging to help audit which user/email/ip used at runtime (do NOT log tokens)
    console.log("[gmail-sent-copy] copying sent email for user:", {
      userId: opts.userId,
      googleEmail: user.googleEmail,
      appEmail: user.email,
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

    // Refresh token if needed
    try {
      await oauth2Client.getTokenInfo(user.googleAccessToken);
    } catch {
      console.log("[gmail-sent-copy] Refreshing access token...");
      const { credentials } = await oauth2Client.refreshAccessToken();
      if (credentials.access_token) {
        await prisma.user.update({
          where: { id: opts.userId },
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

    const senderAddress = user.googleEmail || user.email || "";
    const senderName = user.name || "Influencer CRM";

    // Build RFC 2822 email format
    const emailLines = [
      `From: "${senderName}" <${senderAddress}>`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      "Content-Type: text/html; charset=utf-8",
      "MIME-Version: 1.0",
      ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
      "",
      opts.htmlBody,
    ];

    const rawEmail = emailLines.join("\r\n");

    // Base64 URL-safe encode
    const base64Email = Buffer.from(rawEmail)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // Insert message into Sent folder (not send, just insert)
    const response = await gmail.users.messages.insert({
      userId: "me",
      requestBody: {
        raw: base64Email,
        labelIds: ["SENT"],
      },
    });

    console.log("[gmail-sent-copy] Email copied to Sent folder:", {
      messageId: response.data.id,
      to: opts.to,
    });

    return {
      success: true,
      messageId: response.data.id || undefined,
    };
  } catch (error: any) {
    console.error(
      "[gmail-sent-copy] Failed to copy email to Sent folder:",
      error?.message || error
    );
    return {
      success: false,
      error: error?.message || "Unknown error",
    };
  }
};
