// src/lib/mailgun-helpers.ts
import axios from "axios";
import { resolveMx } from "dns/promises";

const API_KEY = process.env.MAILGUN_API_KEY || "";
const DOMAIN = process.env.MAILGUN_DOMAIN || "";
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";

export async function isSuppressedByMailgun(email: string): Promise<boolean> {
  if (!API_KEY || !DOMAIN) return false;
  try {
    // check bounce list
    await axios.get(`${BASE}/${DOMAIN}/bounces/${encodeURIComponent(email)}`, {
      auth: { username: "api", password: API_KEY },
      timeout: 5000,
    });
    return true;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      // not found => not suppressed in bounce list
    } else {
      // Could be network error; treat as not suppressed (caller may decide)
    }
  }

  try {
    // check complaints
    await axios.get(
      `${BASE}/${DOMAIN}/complaints/${encodeURIComponent(email)}`,
      {
        auth: { username: "api", password: API_KEY },
        timeout: 5000,
      }
    );
    return true;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      // not found
    }
  }

  try {
    // check unsubscribes
    await axios.get(
      `${BASE}/${DOMAIN}/unsubscribes/${encodeURIComponent(email)}`,
      {
        auth: { username: "api", password: API_KEY },
        timeout: 5000,
      }
    );
    return true;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      // not found
    }
  }

  return false;
}

export async function domainHasMX(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch (e) {
    // DNS errors -> treat as false (caller may choose to retry)
    return false;
  }
}
