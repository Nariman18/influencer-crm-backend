// src/lib/mailgun-helpers.ts
import axios, { AxiosResponse } from "axios"; // ✅ Add AxiosResponse import
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
      // ✅ Fix: Explicitly type the response
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
 * Fetch all complained emails from Mailgun
 */
export async function getComplainedEmails(): Promise<string[]> {
  if (!API_KEY || !DOMAIN) return [];

  const complainedEmails: string[] = [];
  let nextUrl: string | null = `${BASE}/${DOMAIN}/complaints?limit=100`;

  try {
    while (nextUrl) {
      // ✅ Fix: Explicitly type the response
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
 * Categorize bounce error message as permanent or temporary
 */
export function isPermanentBounce(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") return false;

  const msg = errorMessage.toLowerCase();

  // Permanent bounce indicators (5.x.x errors)
  const permanentPatterns = [
    "does not exist",
    "user does not exist",
    "account disabled",
    "mailbox unavailable",
    "mailbox not found",
    "user unknown",
    "address rejected",
    "recipient address rejected",
    "unrouteable address",
    "no such user",
    "invalid mailbox",
    "5.1.1", // User unknown
    "5.2.1", // Account disabled
    "5.5.0", // Mailbox unavailable
    "550", // Mailbox unavailable
    "551", // User not local
    "553", // Mailbox name not allowed
  ];

  return permanentPatterns.some((pattern) => msg.includes(pattern));
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
