// lib/mailgun-client.ts
import axios from "axios";

const API_KEY = process.env.MAILGUN_API_KEY || "";
const DOMAIN = process.env.MAILGUN_DOMAIN || "";
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";

const FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL || "";
const FROM_NAME = process.env.MAILGUN_FROM_NAME || "Influencer CRM";

console.log("[mailgun-client] Mailgun config:", {
  MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
  MAILGUN_FROM_NAME: FROM_NAME ? "present" : "missing",
  MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
  MAILGUN_API_KEY: API_KEY ? "present" : "missing",
});

if (!FROM_EMAIL || !API_KEY || !DOMAIN) {
  console.warn("[mailgun-client] MAILGUN config incomplete — sends may fail", {
    MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
    MAILGUN_API_KEY: API_KEY ? "present" : "missing",
    MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
  });
}

/**
 * Build a safe RFC-like From header: `"Name" <address@domain.tld>`
 * - strips problematic chars
 * - limits length
 * - forces quoting for safer parsing
 */
const buildFrom = () => {
  const rawName = String(FROM_NAME || "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const cleaned = rawName
    .replace(/[\r\n\t]/g, " ")
    .replace(/["<>]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  const safeName = cleaned || "No Reply";

  const validEmail =
    typeof FROM_EMAIL === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(FROM_EMAIL.trim());
  const fromAddr = validEmail
    ? FROM_EMAIL.trim()
    : "invalid-from@example.invalid";

  return `"${safeName}" <${fromAddr}>`;
};

type SendResult = {
  success: boolean;
  id?: string;
  messageId?: string;
  error?: string;
};

const isEmailValid = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

export const sendMailgunEmail = async (opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
}): Promise<SendResult> => {
  try {
    const url = `${BASE}/${DOMAIN}/messages`;

    const fromHeader = buildFrom();

    // Fail early if FROM or TO invalid (clear logs)
    if (!isEmailValid(FROM_EMAIL)) {
      const msg = `Invalid MAILGUN_FROM_EMAIL: "${FROM_EMAIL}"`;
      console.error("[mailgun-client] " + msg);
      return { success: false, error: msg };
    }
    if (!isEmailValid(opts.to)) {
      const msg = `Invalid recipient email: "${opts.to}"`;
      console.error("[mailgun-client] " + msg);
      return { success: false, error: msg };
    }

    const form = new URLSearchParams();
    form.append("from", fromHeader);
    form.append("to", opts.to);
    form.append("subject", opts.subject);
    form.append("html", opts.html);
    if (opts.replyTo) form.append("h:Reply-To", opts.replyTo);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        form.append(`h:${k}`, v);
      }
    }

    console.log("[mailgun-client] sending mailgun request", {
      url,
      from: fromHeader,
      to: opts.to,
      subject: opts.subject,
      replyTo: opts.replyTo,
    });

    const res = await axios.post(url, form.toString(), {
      auth: { username: "api", password: API_KEY },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    return {
      success: true,
      id: res.data?.id,
      messageId: res.data?.message || undefined,
    };
  } catch (err: any) {
    // build a safe string
    const responseData = err?.response?.data;
    let errString: string;
    try {
      if (typeof responseData === "string") errString = responseData;
      else if (responseData && typeof responseData === "object")
        errString = JSON.stringify(responseData);
      else errString = err?.message || String(err);
    } catch {
      errString = err?.message || "Unknown Mailgun error";
    }

    console.error(
      "[mailgun-client] Mailgun send error:",
      responseData || err?.message || err
    );
    return { success: false, error: errString };
  }
};
