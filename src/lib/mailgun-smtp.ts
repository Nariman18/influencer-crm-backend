// src/lib/mailgun-smtp.ts
import nodemailer from "nodemailer";

/**
 * SMTP config is read from environment:
 * - MAILGUN_SMTP_HOST
 * - MAILGUN_SMTP_PORT
 * - MAILGUN_SMTP_SECURE (optional; "true"|"false")
 * - MAILGUN_SMTP_USER
 * - MAILGUN_SMTP_PASSWORD
 * - SMTP_TLS_REJECT_UNAUTHORIZED (optional)
 * If SMTP_TLS_REJECT_UNAUTHORIZED is absent we fall back to REDIS_TLS_REJECT_UNAUTHORIZED
 * (you already have that set in your .env files).
 */

const host = process.env.MAILGUN_SMTP_HOST;
const port = Number(process.env.MAILGUN_SMTP_PORT || 587);
const secureEnv = String(process.env.MAILGUN_SMTP_SECURE || "").toLowerCase();
const secure =
  secureEnv === "true" ? true : secureEnv === "false" ? false : port === 465;
const user = process.env.MAILGUN_SMTP_USER;
const pass = process.env.MAILGUN_SMTP_PASSWORD;

// Prefer dedicated SMTP_TLS_REJECT_UNAUTHORIZED, otherwise fall back to REDIS_TLS_REJECT_UNAUTHORIZED
const tlsRejectStr =
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED ??
  process.env.REDIS_TLS_REJECT_UNAUTHORIZED ??
  "true";
const tlsReject = String(tlsRejectStr).toLowerCase() === "true";

if (!host || !user || !pass) {
  console.warn(
    "[mailgun-smtp] SMTP not fully configured; SMTP fallback disabled"
  );
}

export const sendViaSmtp = async (opts: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}) => {
  if (!host || !user || !pass) {
    throw new Error("SMTP credentials missing");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465, false for 587 (STARTTLS)
    auth: { user, pass },
    tls: { rejectUnauthorized: tlsReject },
  });

  // Verify connection/auth — helpful during startup/test
  try {
    await transporter.verify();
    console.log("[mailgun-smtp] SMTP transporter verified OK");
  } catch (verifyErr) {
    console.warn("[mailgun-smtp] transporter.verify() warning:", verifyErr);
    // don't throw — caller may want to attempt fallback or surface the error
  }

  const info = await transporter.sendMail({
    from:
      opts.from ||
      `"${process.env.MAILGUN_FROM_NAME || "Influencer CRM"}" <${
        process.env.MAILGUN_FROM_EMAIL || user
      }>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    replyTo: opts.replyTo,
    headers: opts.headers,
  });

  // Return the nodemailer info object — caller (mailgun-client) will inspect info.messageId or info.response
  return { success: true, info };
};
