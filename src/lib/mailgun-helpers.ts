// src/lib/mailgun-helpers.ts
import axios, { AxiosResponse } from "axios";
import { resolveMx } from "dns/promises";
import { getPrisma } from "../config/prisma";
import { InfluencerStatus } from "@prisma/client";

const prisma = getPrisma();

const API_KEY = process.env.MAILGUN_API_KEY || "";
const DOMAIN = process.env.MAILGUN_DOMAIN || "";
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";

/**
 * Check if email is in Mailgun suppression lists (bounces, complaints, unsubscribes)
 */
export async function isSuppressedByMailgun(email: string): Promise<boolean> {
  if (!API_KEY || !DOMAIN) return false;

  try {
    // Check bounce list
    await axios.get(`${BASE}/${DOMAIN}/bounces/${encodeURIComponent(email)}`, {
      auth: { username: "api", password: API_KEY },
      timeout: 5000,
    });
    return true;
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      console.warn(
        "[mailgun-helpers] bounce check network error:",
        err?.message
      );
    }
  }

  try {
    // Check complaints
    await axios.get(
      `${BASE}/${DOMAIN}/complaints/${encodeURIComponent(email)}`,
      {
        auth: { username: "api", password: API_KEY },
        timeout: 5000,
      }
    );
    return true;
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      console.warn(
        "[mailgun-helpers] complaint check network error:",
        err?.message
      );
    }
  }

  try {
    // Check unsubscribes
    await axios.get(
      `${BASE}/${DOMAIN}/unsubscribes/${encodeURIComponent(email)}`,
      {
        auth: { username: "api", password: API_KEY },
        timeout: 5000,
      }
    );
    return true;
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      console.warn(
        "[mailgun-helpers] unsubscribe check network error:",
        err?.message
      );
    }
  }

  return false;
}

/**
 * Check if domain has valid MX records
 */
export async function domainHasMX(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch (e) {
    console.warn(`[mailgun-helpers] MX lookup failed for ${domain}:`, e);
    return false;
  }
}

/**
 * Fetch all bounced emails from Mailgun
 */
export async function getBouncedEmails(): Promise<string[]> {
  if (!API_KEY || !DOMAIN) {
    console.warn(
      "[mailgun-helpers] Cannot fetch bounces - missing API credentials"
    );
    return [];
  }

  const bouncedEmails: string[] = [];
  let nextUrl: string | null = `${BASE}/${DOMAIN}/bounces?limit=100`;

  try {
    while (nextUrl) {
      // Explicitly type the response
      const response: AxiosResponse<{
        items?: Array<{ address?: string }>;
        paging?: { next?: string };
      }> = await axios.get(nextUrl, {
        auth: { username: "api", password: API_KEY },
        timeout: 10000,
      });

      const items = response.data?.items || [];
      for (const item of items) {
        if (item.address) {
          bouncedEmails.push(item.address.toLowerCase());
        }
      }

      // Pagination
      nextUrl = response.data?.paging?.next || null;

      // Safety limit to prevent infinite loops
      if (bouncedEmails.length > 10000) {
        console.warn(
          "[mailgun-helpers] Reached 10k bounce limit, stopping pagination"
        );
        break;
      }
    }

    console.log(
      `[mailgun-helpers] Fetched ${bouncedEmails.length} bounced emails from Mailgun`
    );
    return bouncedEmails;
  } catch (error: any) {
    console.error(
      "[mailgun-helpers] Failed to fetch bounced emails:",
      error?.message
    );
    return [];
  }
}

/**
 * Categorize bounce/error based on SMTP code and message
 * Returns detailed error category for better handling
 */
export function categorizeBounceError(
  errorMessage: string,
  code?: number | string | null,
  severity?: string | null
): string {
  const msg = (errorMessage || "").toLowerCase();
  const codeStr = String(code || "");

  // EXPLICIT 5.1.1 DETECTION (Invalid/Non-existent mailbox)
  if (
    codeStr === "511" ||
    codeStr === "5.1.1" ||
    msg.includes("5.1.1") ||
    msg.includes("does not exist") ||
    msg.includes("user does not exist") ||
    msg.includes("user unknown") ||
    msg.includes("no such user") ||
    msg.includes("invalid mailbox") ||
    msg.includes("mailbox not found") ||
    msg.includes("recipient address rejected")
  ) {
    return "INVALID_MAILBOX_5.1.1";
  }

  // 5.1.0 - Address does not exist
  if (
    codeStr === "510" ||
    codeStr === "5.1.0" ||
    msg.includes("address does not exist") ||
    msg.includes("unrouteable address")
  ) {
    return "ADDRESS_NOT_FOUND_5.1.0";
  }

  // 5.2.1 - Mailbox disabled/unavailable
  if (
    codeStr === "521" ||
    codeStr === "5.2.1" ||
    msg.includes("account disabled") ||
    msg.includes("mailbox unavailable") ||
    msg.includes("mailbox disabled")
  ) {
    return "MAILBOX_DISABLED_5.2.1";
  }

  // 5.2.2 - Mailbox full
  if (
    codeStr === "522" ||
    codeStr === "5.2.2" ||
    msg.includes("mailbox full") ||
    msg.includes("over quota") ||
    msg.includes("quota exceeded")
  ) {
    return "MAILBOX_FULL_5.2.2";
  }

  // 5.5.0 - Mailbox syntax incorrect
  if (
    codeStr === "550" ||
    codeStr === "5.5.0" ||
    (msg.includes("invalid") && msg.includes("address")) ||
    msg.includes("syntax error")
  ) {
    return "INVALID_ADDRESS_5.5.0";
  }

  // 5.7.1 - Policy/spam rejection
  if (
    codeStr === "571" ||
    codeStr === "5.7.1" ||
    msg.includes("spam") ||
    msg.includes("blocked") ||
    msg.includes("policy") ||
    msg.includes("denied")
  ) {
    return "POLICY_REJECTION_5.7.1";
  }

  // 4.x.x - Temporary failures
  if (
    severity === "temporary" ||
    (codeStr.startsWith("4") && codeStr.length === 3)
  ) {
    if (msg.includes("greylisted") || msg.includes("try again later")) {
      return "TEMPORARY_GREYLISTED_4.x.x";
    }
    if (msg.includes("rate limit") || msg.includes("too many")) {
      return "TEMPORARY_RATE_LIMIT_4.x.x";
    }
    return "TEMPORARY_FAILURE_4.x.x";
  }

  // Generic permanent bounce
  if (
    severity === "permanent" ||
    (codeStr.startsWith("5") && codeStr.length === 3)
  ) {
    return "PERMANENT_BOUNCE_5.x.x";
  }

  // Spam complaint
  if (msg.includes("complaint") || msg.includes("spam")) {
    return "SPAM_COMPLAINT";
  }

  // Unknown/other
  return "UNKNOWN_ERROR";
}

// More comprehensive permanent bounce detection
export function isPermanentBounce(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") return false;

  const msg = errorMessage.toLowerCase();

  // COMPREHENSIVE permanent bounce indicators
  const permanentPatterns = [
    // User/mailbox doesn't exist (5.1.1)
    "5.1.1",
    "does not exist",
    "user does not exist",
    "no such user",
    "user unknown",
    "invalid mailbox",
    "mailbox not found",
    "recipient address rejected",
    "unrouteable address",

    // Account disabled (5.2.1)
    "5.2.1",
    "account disabled",
    "mailbox unavailable",
    "mailbox disabled",

    // Address syntax errors (5.5.0)
    "5.5.0",
    "550", // Common SMTP rejection code

    // Domain doesn't exist
    "551", // User not local
    "553", // Mailbox name not allowed
    "domain not found",
    "domain does not exist",

    // Generic 5.x.x indicators
    "permanent failure",
    "permanently rejected",
    "permanent error",
  ];

  return permanentPatterns.some((pattern) => msg.includes(pattern));
}

/**
 * Fetch all complained emails from Mailgun
 */
export async function getComplainedEmails(): Promise<string[]> {
  if (!API_KEY || !DOMAIN) return [];

  const complainedEmails: string[] = [];
  let nextUrl: string | null = `${BASE}/${DOMAIN}/complaints?limit=100`;

  try {
    while (nextUrl) {
      // Explicitly type the response
      const response: AxiosResponse<{
        items?: Array<{ address?: string }>;
        paging?: { next?: string };
      }> = await axios.get(nextUrl, {
        auth: { username: "api", password: API_KEY },
        timeout: 10000,
      });

      const items = response.data?.items || [];
      for (const item of items) {
        if (item.address) {
          complainedEmails.push(item.address.toLowerCase());
        }
      }

      nextUrl = response.data?.paging?.next || null;

      if (complainedEmails.length > 10000) break;
    }

    console.log(
      `[mailgun-helpers] Fetched ${complainedEmails.length} complained emails from Mailgun`
    );
    return complainedEmails;
  } catch (error: any) {
    console.error(
      "[mailgun-helpers] Failed to fetch complained emails:",
      error?.message
    );
    return [];
  }
}

/**
 * Clean up influencers with bounced/complained emails
 * Marks them as REJECTED and prevents future sends
 */
export async function cleanupBouncedInfluencers(): Promise<{
  bounced: number;
  complained: number;
  total: number;
}> {
  console.log("[mailgun-helpers] Starting bounce cleanup...");

  const [bouncedEmails, complainedEmails] = await Promise.all([
    getBouncedEmails(),
    getComplainedEmails(),
  ]);

  const allBadEmails = [...new Set([...bouncedEmails, ...complainedEmails])];

  if (allBadEmails.length === 0) {
    console.log("[mailgun-helpers] No bounced/complained emails to clean up");
    return { bounced: 0, complained: 0, total: 0 };
  }

  try {
    // Update influencers to REJECTED status
    const result = await prisma.influencer.updateMany({
      where: {
        email: {
          in: allBadEmails,
          mode: "insensitive", // Case-insensitive match
        },
        status: {
          not: InfluencerStatus.REJECTED, // Don't update already rejected
        },
      },
      data: {
        status: InfluencerStatus.REJECTED,
      },
    });

    console.log(
      `[mailgun-helpers] Marked ${result.count} influencers as REJECTED`
    );

    // Also mark their PENDING emails as FAILED
    const emailUpdate = await prisma.email.updateMany({
      where: {
        influencer: {
          email: {
            in: allBadEmails,
            mode: "insensitive",
          },
        },
        status: "PENDING",
      },
      data: {
        status: "FAILED",
        errorMessage: "Email address bounced or complained in Mailgun",
      },
    });

    console.log(
      `[mailgun-helpers] Marked ${emailUpdate.count} pending emails as FAILED`
    );

    return {
      bounced: bouncedEmails.length,
      complained: complainedEmails.length,
      total: result.count,
    };
  } catch (error) {
    console.error(
      "[mailgun-helpers] Failed to clean up bounced influencers:",
      error
    );
    throw error;
  }
}

/**
 * Add email to Mailgun bounce list (for manual bounce tracking)
 */
export async function addToBounceList(
  email: string,
  reason: string = "Manual addition - permanent bounce"
): Promise<boolean> {
  if (!API_KEY || !DOMAIN) return false;

  try {
    await axios.post(
      `${BASE}/${DOMAIN}/bounces`,
      new URLSearchParams({
        address: email.toLowerCase(),
        code: "550",
        error: reason,
      }),
      {
        auth: { username: "api", password: API_KEY },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 5000,
      }
    );

    console.log(`[mailgun-helpers] Added ${email} to Mailgun bounce list`);
    return true;
  } catch (error: any) {
    // 409 means already exists - that's fine
    if (error?.response?.status === 409) {
      console.log(`[mailgun-helpers] ${email} already in bounce list`);
      return true;
    }

    console.error(
      `[mailgun-helpers] Failed to add ${email} to bounce list:`,
      error?.message
    );
    return false;
  }
}
