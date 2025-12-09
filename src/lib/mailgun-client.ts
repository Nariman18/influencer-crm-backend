// src/lib/mailgun-client.ts
import axios from "axios";
import { sendViaSmtp } from "./mailgun-smtp";
import { domainHasMX } from "./mailgun-helpers";

const API_KEY = process.env.MAILGUN_API_KEY || "";
const DOMAIN = process.env.MAILGUN_DOMAIN || "";
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";

const FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL || "";
const FROM_NAME = process.env.MAILGUN_FROM_NAME || "Collaboration Team";

const SMTP_CONFIGURED =
  Boolean(process.env.MAILGUN_SMTP_HOST) &&
  Boolean(process.env.MAILGUN_SMTP_USER) &&
  Boolean(process.env.MAILGUN_SMTP_PASSWORD);

const WARMUP_DAYS_THRESHOLD = Number(
  process.env.WARMUP_DAYS_THRESHOLD || process.env.WarmUpDateTreasure || 15
);

console.log("[mailgun-client] Mailgun config:", {
  MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
  MAILGUN_FROM_NAME: FROM_NAME ? "present" : "missing",
  MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
  MAILGUN_API_KEY: API_KEY ? "present" : "missing",
  SMTP_FALLBACK: SMTP_CONFIGURED ? "enabled" : "disabled",
  WARMUP_DAYS_THRESHOLD,
});

if (!FROM_EMAIL || !API_KEY || !DOMAIN) {
  console.warn("[mailgun-client] MAILGUN config incomplete — sends may fail", {
    MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
    MAILGUN_API_KEY: API_KEY ? "present" : "missing",
    MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
  });
}

/** Existing buildFrom (fallback using global env FROM_EMAIL) */
const buildFrom = (senderName?: string) => {
  const rawName = senderName || FROM_NAME || "";
  const cleaned = String(rawName)
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/[\r\n\t]/g, " ")
    .replace(/["<>]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);

  const safeName = cleaned || "Collaboration Team";
  const validEmail =
    typeof FROM_EMAIL === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(FROM_EMAIL.trim());
  const fromAddr = validEmail
    ? FROM_EMAIL.trim()
    : "invalid-from@example.invalid";
  return `"${safeName}" <${fromAddr}>`;
};

/**
 * buildFromFull:
 * Prefer explicit senderEmail if provided and valid, otherwise fall back to global FROM_EMAIL.
 */
const buildFromFull = (senderName?: string, senderEmail?: string) => {
  const validSenderEmail =
    typeof senderEmail === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(senderEmail).trim());

  if (validSenderEmail) {
    const rawName =
      senderName || (senderEmail || "").split("@")[0] || FROM_NAME;
    const cleaned = String(rawName)
      .replace(/^["']|["']$/g, "")
      .trim()
      .replace(/[\r\n\t]/g, " ")
      .replace(/["<>]/g, "")
      .replace(/,/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64);
    const safeName = cleaned || FROM_NAME;
    return `"${safeName}" <${String(senderEmail).trim()}>`;
  }

  // fallback
  return buildFrom(senderName);
};

type SendResult = {
  success: boolean;
  id?: string;
  messageId?: string;
  messageIdNormalized?: string;
  message?: string;
  error?: string;
};

const isEmailValid = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

const normalizeError = (x: any) => {
  try {
    if (!x) return "Unknown error";
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.message;
    if (x?.response?.data) {
      if (typeof x.response.data === "string") return x.response.data;
      try {
        return JSON.stringify(x.response.data);
      } catch {
        return String(x.response.data);
      }
    }
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  } catch {
    return "Unknown error";
  }
};

export const sendMailgunEmail = async (opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
  warmupDay?: number;
  unsubscribeUrl?: string;
  senderName?: string;
  senderEmail?: string;
}): Promise<SendResult> => {
  // Basic recipient validation
  if (!isEmailValid(opts.to)) {
    const msg = `Invalid recipient email: "${opts.to}"`;
    console.error("[mailgun-client] " + msg);
    return { success: false, error: msg };
  }

  // Require at least one valid from address: either global FROM_EMAIL or provided opts.senderEmail
  const hasValidGlobalFrom = isEmailValid(FROM_EMAIL);
  const hasValidSenderEmail =
    !!opts.senderEmail && isEmailValid(opts.senderEmail);
  if (!hasValidGlobalFrom && !hasValidSenderEmail) {
    const msg = `Invalid MAILGUN_FROM_EMAIL in environment and no valid senderEmail provided: "${FROM_EMAIL}"`;
    console.error("[mailgun-client] " + msg);
    return { success: false, error: msg };
  }

  // Recipient domain and provider heuristics
  const recipientDomain = opts.to.split("@").pop()?.toLowerCase() || "";
  const RUSSIAN_PROVIDERS = ["mail.ru", "yandex.ru", "rambler.ru", "bk.ru"];
  const GMAIL_PROVIDERS = ["gmail.com", "googlemail.com"];
  const isRussianProvider = RUSSIAN_PROVIDERS.includes(recipientDomain);
  const isGmailProvider = GMAIL_PROVIDERS.includes(recipientDomain);
  const isStrictProvider = isRussianProvider || isGmailProvider;

  // Best-effort MX check (do not fail hard on DNS failures, but log)
  if (recipientDomain) {
    try {
      const hasMX = await domainHasMX(recipientDomain);
      if (!hasMX) {
        const msg = `No MX records found for domain: ${recipientDomain}`;
        console.error(`[mailgun-client] ${msg}`);
        return { success: false, error: msg };
      }
      console.log(
        `[mailgun-client] ✓ MX records verified for ${recipientDomain}`
      );
    } catch (mxErr) {
      console.warn(
        `[mailgun-client] MX check failed for ${recipientDomain}:`,
        mxErr
      );
      // continue — MX check is informative
    }
  }

  // Build From header: prefer explicit senderEmail (envelope) then fall back to global FROM_EMAIL
  const fromHeader = buildFromFull(opts.senderName, opts.senderEmail);

  if (opts.senderEmail && hasValidSenderEmail) {
    console.log(
      "[mailgun-client] Using explicit envelope senderEmail for From:",
      opts.senderEmail
    );
  } else {
    console.log(
      "[mailgun-client] Using global MAILGUN_FROM_EMAIL for From:",
      FROM_EMAIL
    );
  }

  // Reply-To: prefer explicit opts.replyTo (manager Gmail) otherwise fallback to senderEmail or MAILGUN_FROM_EMAIL
  const replyToAddress =
    opts.replyTo && isEmailValid(opts.replyTo)
      ? opts.replyTo
      : hasValidSenderEmail
      ? opts.senderEmail!
      : FROM_EMAIL;

  // If Mailgun API not configured, attempt SMTP fallback (unchanged behavior)
  if (!API_KEY || !DOMAIN) {
    const msg = "Mailgun API key or domain missing in environment";
    console.error("[mailgun-client] " + msg);
    if (SMTP_CONFIGURED) {
      console.warn(
        "[mailgun-client] attempting SMTP fallback because API config is missing"
      );
      try {
        const smtpRes = await sendViaSmtp({
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          replyTo: replyToAddress,
          headers: opts.headers,
          from: fromHeader,
          unsubscribeUrl: opts.unsubscribeUrl,
          warmupDay: opts.warmupDay,
        });
        const smtpMessageId =
          smtpRes?.info?.messageId || smtpRes?.info?.response || undefined;
        const smtpNormalized =
          typeof smtpMessageId === "string"
            ? smtpMessageId.replace(/[<>]/g, "").trim()
            : undefined;
        return {
          success: true,
          id: smtpMessageId,
          messageId: smtpMessageId,
          messageIdNormalized: smtpNormalized,
        };
      } catch (smtpErr: any) {
        return {
          success: false,
          error: `SMTP fallback failed: ${smtpErr?.message || smtpErr}`,
        };
      }
    }
    return { success: false, error: msg };
  }

  // Build Mailgun form body
  const url = `${BASE}/${DOMAIN}/messages`;
  const form = new URLSearchParams();
  form.append("from", fromHeader);
  form.append("to", opts.to);
  form.append("subject", opts.subject || "");
  form.append("html", opts.html || "");

  // Set Reply-To header
  if (replyToAddress) {
    form.append("h:Reply-To", replyToAddress);
    console.log("[mailgun-client] Reply-To set to:", replyToAddress);
  }

  // Disable tracking for warmup/strict providers and as a safe default
  form.append("o:tracking", "no");
  form.append("o:tracking-clicks", "no");
  form.append("o:tracking-opens", "no");

  if (isStrictProvider) {
    console.log(
      `[mailgun-client] 🔒 WARM-UP/STRICT: Tracking disabled for ${recipientDomain}`
    );
  }

  // Generate unique Message-ID to help deliverability / correlation
  const messageIdDomain =
    DOMAIN || FROM_EMAIL.split("@").pop() || "mail.imx.agency";
  const uniqueId = `${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 15)}`;
  const generatedMessageId = `<${uniqueId}@${messageIdDomain}>`;
  form.append("h:Message-ID", generatedMessageId);

  // Required headers
  form.append("h:Date", new Date().toUTCString());
  form.append("h:MIME-Version", "1.0");
  form.append("h:Content-Type", "text/html; charset=UTF-8");

  // List-Unsubscribe policy: only add after warmup threshold and NOT for strict providers
  try {
    const warmupDays = Number(opts.warmupDay || 0);
    const hasPassedWarmup = warmupDays >= WARMUP_DAYS_THRESHOLD;

    const unsubscribeParts: string[] = [];
    const replyToAddr = replyToAddress || FROM_EMAIL;

    if (hasPassedWarmup && !isStrictProvider) {
      if (replyToAddr)
        unsubscribeParts.push(`<mailto:${replyToAddr}?subject=Unsubscribe>`);
      const candidateHttps =
        (opts.unsubscribeUrl && String(opts.unsubscribeUrl).trim()) ||
        (process.env.MAILGUN_UNSUBSCRIBE_URL &&
          String(process.env.MAILGUN_UNSUBSCRIBE_URL).trim());
      if (candidateHttps && String(candidateHttps).startsWith("http")) {
        unsubscribeParts.push(`<${String(candidateHttps).trim()}>`);
      }
    }

    if (unsubscribeParts.length > 0) {
      form.append("h:List-Unsubscribe", unsubscribeParts.join(", "));
      console.log(
        "[mailgun-client] Added List-Unsubscribe header:",
        unsubscribeParts.join(", ")
      );
    } else {
      console.log(
        "[mailgun-client] Skipped List-Unsubscribe header (warmup or strict provider)"
      );
    }
  } catch (luErr) {
    console.warn("[mailgun-client] List-Unsubscribe generation error:", luErr);
  }

  // X-Mailer for correlation
  form.append("h:X-Mailer", "Collaboration Platform 1.0");

  // Add internal tracking header: store provided senderEmail as X-CRM-SENDER (internal)
  if (opts.senderEmail) {
    form.append("h:X-CRM-SENDER", String(opts.senderEmail));
  }

  // Skip Precedence: bulk for known strict providers (helps deliverability)
  const SKIP_BULK_HEADER_PROVIDERS = [
    "mail.ru",
    "yandex.ru",
    "rambler.ru",
    "bk.ru",
    "gmail.com",
    "googlemail.com",
  ];
  if (!SKIP_BULK_HEADER_PROVIDERS.includes(recipientDomain || "")) {
    form.append("h:Precedence", "bulk");
  } else {
    console.log(
      `[mailgun-client] 🔒 WARM-UP: Skipped 'Precedence: bulk' for ${recipientDomain}`
    );
  }

  // Append any caller-provided custom headers
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      form.append(`h:${k}`, v);
    }
  }

  console.log("[mailgun-client] Sending via Mailgun API:", {
    url,
    from: fromHeader,
    to: opts.to,
    domain: recipientDomain,
    subject: opts.subject?.substring(0, 80),
    replyTo: replyToAddress,
    isGmailProvider,
    isStrictProvider,
    warmupDay: opts.warmupDay,
    explicitSenderEmail: opts.senderEmail,
  });

  // Retry/backoff parameters (respect env overrides)
  const MAX_RETRIES = Math.max(1, Number(process.env.MAILGUN_MAX_RETRIES || 5));
  const BASE_DELAY_MS = Math.max(
    100,
    Number(process.env.MAILGUN_BASE_DELAY_MS || 1000)
  );
  const MAX_DELAY_MS = Math.max(
    1000,
    Number(process.env.MAILGUN_MAX_DELAY_MS || 60000)
  );

  const postWithRetries = async () => {
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        const res = await axios.post(url, form.toString(), {
          auth: { username: "api", password: API_KEY },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 20000,
        });
        return res;
      } catch (err: any) {
        const status = err?.response?.status;
        const respData = err?.response?.data;
        let recommendedDelaySec: number | null = null;

        try {
          if (respData && typeof respData === "object") {
            if (
              respData["delivery-status"] &&
              respData["delivery-status"].retry_seconds
            ) {
              recommendedDelaySec = Number(
                respData["delivery-status"].retry_seconds
              );
            } else if (respData.retry_seconds) {
              recommendedDelaySec = Number(respData.retry_seconds);
            }
          }
        } catch {
          recommendedDelaySec = null;
        }

        const isTransient =
          !status ||
          status === 421 ||
          status === 429 ||
          (status >= 500 && status < 600);

        if (!isTransient) {
          console.error(
            `[mailgun-client] Permanent error for ${recipientDomain}:`,
            { status, data: respData, to: opts.to }
          );
          throw err;
        }

        const msg =
          respData && typeof respData === "object"
            ? JSON.stringify(respData)
            : err?.message;
        console.warn(
          `[mailgun-client] Transient send error (attempt ${attempt}/${MAX_RETRIES}) for ${recipientDomain}:`,
          { status, message: msg, recommendedDelaySec, to: opts.to }
        );

        let delayMs: number;
        if (recommendedDelaySec && Number.isFinite(recommendedDelaySec)) {
          delayMs = Math.min(
            MAX_DELAY_MS,
            Math.floor(recommendedDelaySec * 1000)
          );
        } else {
          delayMs = Math.min(
            MAX_DELAY_MS,
            Math.round(BASE_DELAY_MS * Math.pow(2, attempt - 1))
          );
        }
        delayMs += Math.floor(Math.random() * 500);

        if (attempt >= MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`Mailgun post failed after ${MAX_RETRIES} retries`);
  };

  try {
    const res = await postWithRetries();

    const rawId = res.data?.id || res.data?.messageId || undefined;
    const normalizedId =
      typeof rawId === "string" ? rawId.replace(/[<>]/g, "").trim() : undefined;

    console.log(
      `[mailgun-client] ✓ Email sent successfully to ${recipientDomain}:`,
      {
        to: opts.to,
        mailgunId: rawId,
        messageIdNormalized: normalizedId,
      }
    );

    return {
      success: true,
      id: rawId,
      messageId: rawId,
      messageIdNormalized: normalizedId,
      message: res.data?.message || undefined,
    };
  } catch (err: any) {
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
      `[mailgun-client] ✗ Mailgun API send error (after retries) for ${recipientDomain}:`,
      {
        to: opts.to,
        error: responseData || err?.message || err,
        domain: recipientDomain,
      }
    );

    // Try SMTP fallback if configured
    if (SMTP_CONFIGURED) {
      console.warn(
        `[mailgun-client] Attempting SMTP fallback for ${recipientDomain}`,
        { to: opts.to }
      );
      try {
        const smtpRes = await sendViaSmtp({
          to: opts.to,
          subject: opts.subject,
          html: opts.html,
          replyTo: replyToAddress,
          headers: opts.headers,
          from: fromHeader,
          unsubscribeUrl: opts.unsubscribeUrl,
          warmupDay: opts.warmupDay,
        });

        const smtpMessageId =
          smtpRes?.info?.messageId || smtpRes?.info?.response || undefined;
        const smtpNormalized =
          typeof smtpMessageId === "string"
            ? smtpMessageId.replace(/[<>]/g, "").trim()
            : undefined;
        console.log(
          `[mailgun-client] ✓ SMTP fallback succeeded for ${recipientDomain}:`,
          { to: opts.to, smtpMessageId }
        );

        return {
          success: true,
          id: smtpMessageId,
          messageId: smtpMessageId,
          messageIdNormalized: smtpNormalized,
        };
      } catch (smtpErr: any) {
        const smtpErrMsg = smtpErr?.message || String(smtpErr);
        console.error(
          `[mailgun-client] ✗ SMTP fallback failed for ${recipientDomain}:`,
          smtpErrMsg
        );
        return {
          success: false,
          error: `${errString} ; SMTP fallback: ${smtpErrMsg}`,
        };
      }
    }

    return { success: false, error: errString };
  }
};

export default sendMailgunEmail;
