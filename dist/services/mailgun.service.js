"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailgunService = void 0;
// services/mailgun.service.ts - Mailgun email sending service
const form_data_1 = __importDefault(require("form-data"));
const mailgun_js_1 = __importDefault(require("mailgun.js"));
class MailgunService {
    /**
     * Initialize Mailgun client
     */
    static getClient() {
        if (this.client) {
            return this.client;
        }
        const apiKey = process.env.MAILGUN_API_KEY;
        const domain = process.env.MAILGUN_DOMAIN;
        if (!apiKey || !domain) {
            throw new Error("Mailgun configuration missing. Please set MAILGUN_API_KEY and MAILGUN_DOMAIN in .env");
        }
        const mailgun = new mailgun_js_1.default(form_data_1.default);
        this.client = mailgun.client({
            username: "api",
            key: apiKey,
        });
        return this.client;
    }
    /**
     * Send email via Mailgun
     */
    static async sendEmail(params) {
        const { to, subject, body, fromName, fromEmail, replyToThreadId, messageId: originalMessageId, } = params;
        console.log(`📧 [MAILGUN] Sending email to: ${to}`);
        if (replyToThreadId) {
            console.log(`📧 [MAILGUN] Replying to thread: ${replyToThreadId}`);
        }
        try {
            const client = this.getClient();
            const domain = process.env.MAILGUN_DOMAIN;
            // Build email data
            const emailData = {
                from: `${fromName} <${fromEmail}@${domain}>`,
                to: [to],
                subject: subject,
                html: this.wrapEmailBody(body, to),
            };
            // Add reply headers for threading
            if (replyToThreadId && originalMessageId) {
                emailData.headers = {
                    "In-Reply-To": `<${originalMessageId}>`,
                    References: `<${originalMessageId}>`,
                };
                console.log(`📧 [MAILGUN] Added reply headers for threading`);
            }
            // Send via Mailgun
            console.log(`📧 [MAILGUN] Sending to ${domain}...`);
            const response = await client.messages.create(domain, emailData);
            // Ensure we have valid IDs (Mailgun should always return an ID)
            const messageId = response.id || `mailgun-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
            console.log(`✅ [MAILGUN] Email sent successfully:`, {
                messageId: messageId,
                message: response.message,
            });
            // Generate thread ID (use Mailgun message ID or original thread ID)
            const threadId = replyToThreadId || messageId;
            return {
                messageId: messageId,
                threadId: threadId,
                sentAt: new Date(),
            };
        }
        catch (error) {
            console.error(`❌ [MAILGUN] Failed to send email:`, error);
            throw new Error(`Mailgun send failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    /**
     * Send email using Mailgun template
     */
    static async sendWithTemplate(to, templateName, variables, fromName, fromEmail) {
        console.log(`📧 [MAILGUN] Sending email with template "${templateName}" to: ${to}`);
        try {
            const client = this.getClient();
            const domain = process.env.MAILGUN_DOMAIN;
            const emailData = {
                from: `${fromName} <${fromEmail}@${domain}>`,
                to: [to],
                template: templateName,
                "h:X-Mailgun-Variables": JSON.stringify(variables),
            };
            const response = await client.messages.create(domain, emailData);
            // Ensure we have valid IDs
            const messageId = response.id || `mailgun-template-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
            console.log(`✅ [MAILGUN] Template email sent successfully:`, messageId);
            return {
                messageId: messageId,
                threadId: messageId,
                sentAt: new Date(),
            };
        }
        catch (error) {
            console.error(`❌ [MAILGUN] Failed to send template email:`, error);
            throw new Error(`Mailgun template send failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    /**
     * Validate Mailgun configuration
     */
    static async validateConfig() {
        try {
            const client = this.getClient();
            const domain = process.env.MAILGUN_DOMAIN;
            // Test by getting domain info
            const domainInfo = await client.domains.get(domain);
            console.log(`✅ [MAILGUN] Configuration valid - Domain: ${domain}`);
            console.log(`✅ [MAILGUN] Domain state: ${domainInfo.state}`);
            return true;
        }
        catch (error) {
            console.error(`❌ [MAILGUN] Configuration validation failed:`, error);
            return false;
        }
    }
    /**
     * Wrap email body with HTML template
     */
    static wrapEmailBody(body, recipientEmail) {
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
        <p>This email was sent to ${recipientEmail} via Influencer CRM Platform</p>
        <p>© ${new Date().getFullYear()} Influencer CRM. All rights reserved.</p>
      </div>
    </div>
  </body>
</html>`;
    }
    /**
     * Get email delivery statistics from Mailgun
     */
    static async getEmailStats(days = 7) {
        try {
            const client = this.getClient();
            const domain = process.env.MAILGUN_DOMAIN;
            // Get stats for the last N days
            const stats = await client.stats.getDomain(domain, {
                event: ["accepted", "delivered", "failed", "opened", "clicked"],
                duration: `${days}d`,
            });
            return stats;
        }
        catch (error) {
            console.error(`❌ [MAILGUN] Failed to fetch stats:`, error);
            throw error;
        }
    }
}
exports.MailgunService = MailgunService;
MailgunService.client = null;
