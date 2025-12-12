// src/lib/mailgun-client.ts
import axios from "axios";
import FormData from "form-data";

interface SendMailgunEmailInput {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  senderEmail?: string;
  senderName?: string;
  headers?: Record<string, string>;
}

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY!;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN!;
const MAILGUN_FROM_FALLBACK =
  process.env.MAILGUN_FROM_EMAIL || `noreply@${MAILGUN_DOMAIN}`;

// Util: simple email validation
const isValidEmail = (s: any): s is string =>
  !!s && typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export async function sendMailgunEmail(opts: SendMailgunEmailInput): Promise<{
  success: boolean;
  id?: string;
  messageId?: string;
  messageIdNormalized?: string | null;
  error?: any;
}> {
  try {
    if (!opts.to || !isValidEmail(opts.to)) {
      throw new Error(`Invalid "to" address: ${opts.to}`);
    }

    // ----------------------------
    // 1. Build sender identity
    // ----------------------------
    const fromEmail = isValidEmail(opts.senderEmail)
      ? opts.senderEmail
      : MAILGUN_FROM_FALLBACK;

    const fromName =
      (opts.senderName && opts.senderName.trim().replace(/["<>]/g, "")) ||
      fromEmail.split("@")[0];

    const fromHeader = `"${fromName}" <${fromEmail}>`;

    // ----------------------------
    // 2. Build Reply-To
    // ----------------------------
    const replyToAddress = isValidEmail(opts.replyTo)
      ? opts.replyTo
      : fromEmail; // fallback, but usually should be manager Gmail

    // ----------------------------
    // 3. Prepare form-data manually (axios-compatible)
    // ----------------------------
    const form = new FormData();

    form.append("from", fromHeader);
    form.append("to", opts.to);
    form.append("subject", opts.subject || "");
    form.append("html", opts.html || "");
    form.append("h:Reply-To", replyToAddress);

    // Minimal required headers only
    form.append("h:MIME-Version", "1.0");
    form.append("h:Date", new Date().toUTCString());

    // Add CRM-tracking headers ONLY if provided
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        if (v != null) {
          form.append(`h:${k}`, String(v));
        }
      }
    }

    // ------------------------------------------
    // VERY IMPORTANT:
    // - No Precedence
    // - No List-Unsubscribe
    // - No tracking
    // ------------------------------------------

    // EXPLICITLY DISABLE ALL MAILGUN TRACKING
    form.append("o:tracking", "no");
    form.append("o:tracking-clicks", "no");
    form.append("o:tracking-opens", "no");

    // ------------------------------------------
    // 4. Execute Mailgun API request
    // ------------------------------------------
    const url = `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`;

    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization:
          "Basic " + Buffer.from(`api:${MAILGUN_API_KEY}`).toString("base64"),
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    // Mailgun success = status 200
    if (response.status >= 200 && response.status < 300) {
      const mgId = response.data?.id || null;
      const normalized = normalizeMessageId(mgId);

      return {
        success: true,
        id: mgId || undefined,
        messageId: mgId || undefined,
        messageIdNormalized: normalized,
      };
    }

    // Failure
    return {
      success: false,
      error: {
        status: response.status,
        data: response.data,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || err,
    };
  }
}

// Normalizes "<abc@mg.mailgun.org>" → "abc@mg.mailgun.org"
function normalizeMessageId(msgId?: string | null): string | null {
  if (!msgId || typeof msgId !== "string") return null;
  return msgId.replace(/[<>\s]/g, "").trim() || null;
}
