// src/lib/mailgun-smtp.ts
import nodemailer from "nodemailer";

/**
 * SMTP config is read from environment:
 * - MAILGUN_SMTP_HOST
 * - MAILGUN_SMTP_PORT
 * - MAILGUN_SMTP_SECURE (optional; "true"|"false")
 * - MAILGUN_SMTP_USER
 * - MAILGUN_SMTP_PASSWORD
 * - MAILGUN_SMTP_POOL (optional; "true"|"false")
 * - MAILGUN_SMTP_MAX_CONNECTIONS (optional; number)
 * - MAILGUN_SMTP_MAX_MESSAGES (optional; number)
 * - MAILGUN_SMTP_TIMEOUT_MS (optional; number)
 * - SMTP_TLS_REJECT_UNAUTHORIZED (optional)
 *
 * This module returns { success: true, info } similar to the prior implementation.
 */

const host = process.env.MAILGUN_SMTP_HOST;
const port = Number(process.env.MAILGUN_SMTP_PORT || 587);
const secureEnv = String(process.env.MAILGUN_SMTP_SECURE || "").toLowerCase();
const secure =
  secureEnv === "true" ? true : secureEnv === "false" ? false : port === 465;
const user = process.env.MAILGUN_SMTP_USER;
const pass = process.env.MAILGUN_SMTP_PASSWORD;

const poolEnv = String(process.env.MAILGUN_SMTP_POOL ?? "true").toLowerCase();
const pool = poolEnv === "true";

const maxConnections = Number(process.env.MAILGUN_SMTP_MAX_CONNECTIONS || 5);
const maxMessages = Number(process.env.MAILGUN_SMTP_MAX_MESSAGES || 1000);
const smtpTimeout = Number(process.env.MAILGUN_SMTP_TIMEOUT_MS || 20000);

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

/**
 * sendViaSmtp(opts)
 * - opts.to, opts.subject, opts.html
 * - optional opts.from, opts.replyTo, opts.headers
 *
 * Returns: { success: true, info } or throws.
 */
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

  // Create transporter with pooling enabled by default for better throughput
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: pool,
    maxConnections: pool
      ? Math.max(1, Math.min(10, maxConnections))
      : undefined,
    maxMessages: pool ? Math.max(1, maxMessages) : undefined,
    tls: { rejectUnauthorized: tlsReject },
    socketTimeout: smtpTimeout,
    connectionTimeout: smtpTimeout,
  } as any);

  // Verify connection/auth — helpful during startup/test
  try {
    await transporter.verify();
    console.log("[mailgun-smtp] SMTP transporter verified OK", {
      host,
      port,
      pool,
      maxConnections,
      smtpTimeout,
    });
  } catch (verifyErr) {
    // Log a warning but don't fail outright — fallback caller can handle send error
    console.warn("[mailgun-smtp] transporter.verify() warning:", verifyErr);
  }

  // Generate headers for better deliverability (Message-ID, List-Unsubscribe)
  const domain = process.env.MAILGUN_DOMAIN || "mail.imx.agency";
  const uniqueId = `${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 15)}`;
  const messageId = `<${uniqueId}@${domain}>`;

  const enhancedHeaders: Record<string, string> = {
    "Message-ID": messageId,
    "MIME-Version": "1.0",
    ...(opts.replyTo && {
      "List-Unsubscribe": `<mailto:${opts.replyTo}?subject=Unsubscribe>`,
    }),
    ...opts.headers,
  };

  // Wrap sendMail in a promise that enforces a hard timeout as a safety fallback
  const sendPromise = transporter.sendMail({
    from:
      opts.from ||
      `"${process.env.MAILGUN_FROM_NAME || "Collaboration Team"}" <${
        process.env.MAILGUN_FROM_EMAIL || user
      }>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    replyTo: opts.replyTo,
    headers: enhancedHeaders,
    messageId: messageId,
  });

  const timeoutMs = smtpTimeout || 20000;
  const timed = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SMTP send timeout")), timeoutMs)
  );

  // Race send vs timeout
  const info = (await Promise.race([sendPromise, timed])) as any;

  // nodemailer returns an info object; keep callers' expectations
  return { success: true, info };
};
