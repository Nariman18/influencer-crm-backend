// src/lib/import-helpers.ts
import { InfluencerStatus, Prisma } from "@prisma/client";

/**
 * ParsedRow: permissive types because ExcelJS cell values can be objects / richText
 */
export interface ParsedRow {
  name: any;
  email: any;
  instagramHandle: any;
  link: any;
  followers: any;
  country: any;
  notes: any;
}

/**
 * Normalize Unicode email to plain ASCII
 */
export const normalizeUnicodeEmail = (email: string): string => {
  if (!email) return email;

  // Normalize Unicode characters to their closest ASCII equivalents
  return email
    .normalize("NFKD") // Normalize Unicode
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (char) => {
      // Map mathematical bold characters to regular characters
      const codePoint = char.codePointAt(0);
      if (codePoint && codePoint >= 0x1d400 && codePoint <= 0x1d7ff) {
        // Mathematical bold ranges to regular ranges
        if (codePoint >= 0x1d400 && codePoint <= 0x1d419) {
          // Bold uppercase A-Z
          return String.fromCodePoint(codePoint - 0x1d400 + 0x41);
        } else if (codePoint >= 0x1d41a && codePoint <= 0x1d433) {
          // Bold lowercase a-z
          return String.fromCodePoint(codePoint - 0x1d41a + 0x61);
        } else if (codePoint >= 0x1d7ce && codePoint <= 0x1d7d7) {
          // Bold digits 0-9
          return String.fromCodePoint(codePoint - 0x1d7ce + 0x30);
        }
      }
      return char;
    })
    .replace(/[^\x00-\x7F]/g, "") // Remove any remaining non-ASCII characters
    .trim();
};

/**
 * Returns true when a given cell looks like a DM/no-email marker.
 */
export const looksLikeDM = (s: string | null | undefined): boolean => {
  if (s === null || s === undefined) return false;
  const v = String(s).trim().toLowerCase();
  if (!v) return false;

  // If it contains @, it's likely an email, not a DM marker
  if (v.includes("@")) return false;

  // Exact match markers only (don't use .includes() to avoid false positives)
  const exactMarkers = [
    "директ",
    "дірект",
    "дм",
    "direct",
    "dm",
    "d/m",
    "via dm",
    "instagram dm",
    "ig dm",
    "direct message",
    "instagram",
    "no email",
    "noemail",
    "n/a",
    "na",
    "-",
    "—",
    "none",
    "немає",
    "нет",
    "ні",
  ];

  for (const m of exactMarkers) {
    if (v === m) return true;
  }

  // Only check .includes() for longer, unambiguous phrases
  const phraseMarkers = [
    "via dm",
    "instagram dm",
    "direct message",
    "no email",
  ];
  for (const m of phraseMarkers) {
    if (v.includes(m)) return true;
  }

  // Pattern: contains "dm" with special characters around it (not part of email)
  if (/\bdm\b/.test(v)) return true;

  return false;
};

/**
 * Extract plain text from any cell value (handles richText, objects, etc.)
 */
export const extractCellText = (v: any): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    let s = v.trim();
    if (s.toLowerCase().startsWith("mailto:")) s = s.substring(7).trim();
    return s;
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";

  if (typeof v === "object") {
    // Handle hyperlink objects - this is what your Excel has!
    if (v.text && typeof v.text === "object") {
      // Deep nested object with richText
      if (v.text.richText && Array.isArray(v.text.richText)) {
        const text = v.text.richText
          .map((seg: any) => seg.text || "")
          .join("")
          .trim();
        return text;
      }
      // Try to get any text property
      if (v.text.text) {
        return String(v.text.text).trim();
      }
    }

    // Simple text in object
    if (v.text && typeof v.text === "string") {
      return v.text.trim();
    }

    // Hyperlink as fallback
    if (v.hyperlink) {
      return String(v.hyperlink).trim();
    }

    // Try toString as last resort
    if (typeof v.toString === "function") {
      const s = v.toString();
      if (s && s !== "[object Object]") {
        return s.trim();
      }
    }
  }

  return String(v || "").trim();
};

/**
 * Enhanced email validation with Unicode normalization
 */
export const emailLooksValid = (s: any): boolean => {
  if (s === null || s === undefined) return false;

  let normalized = extractCellText(s).trim();
  if (!normalized) return false;

  // Normalize Unicode characters first
  normalized = normalizeUnicodeEmail(normalized);

  // Skip DM markers
  if (looksLikeDM(normalized.toLowerCase())) return false;

  // More permissive email check for your data
  const atIndex = normalized.indexOf("@");
  if (atIndex < 1) return false;

  // Check if it's a valid email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(normalized)) return true;

  // Also accept emails with common TLDs
  const afterAt = normalized.substring(atIndex + 1);
  if (afterAt.includes(".") && afterAt.length > 1) {
    return true;
  }

  return false;
};

/**
 * Extract Instagram username from URL for display purposes
 */
export function extractInstagramUsername(link: string | null): string | null {
  if (!link) return null;

  try {
    // Match Instagram URL patterns
    const patterns = [
      /instagram\.com\/([A-Za-z0-9._]+)(?:\/|$)/i,
      /^@?([A-Za-z0-9._]{1,30})$/,
    ];

    for (const pattern of patterns) {
      const match = link.match(pattern);
      if (match && match[1]) {
        return match[1].replace(/^@/, "").trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * parseRowFromHeaders - KEPT FOR COMPATIBILITY BUT NOT USED IN MANUAL MAPPING
 */
export function parseRowFromHeaders(
  headers: string[],
  values: any[]
): ParsedRow {
  // This function is kept for compatibility but manual mapping bypasses it
  console.log("⚠️ parseRowFromHeaders called but using manual mapping instead");

  return {
    name: null,
    email: null,
    instagramHandle: null,
    link: null,
    followers: null,
    country: null,
    notes: null,
  };
}

/**
 * Map ParsedRow -> Prisma.InfluencerCreateManyInput - DIRECT MAPPING
 */
export function mappedToCreateMany(
  row: ParsedRow,
  managerId: string
): Prisma.InfluencerCreateManyInput {
  // Use the nickname directly as name
  const finalName =
    row.name && row.name.trim() ? row.name : "Unknown Influencer";

  return {
    name: finalName, // Nickname from Excel
    email: row.email || null, // Email from Excel
    instagramHandle: row.instagramHandle || null, // FULL Instagram URL from Excel Link column
    link: row.link || null, // Also the FULL Instagram URL from Excel Link column
    followers: null,
    country: null,
    notes: row.notes || null, // Include DM notes if any
    status: InfluencerStatus.NOT_SENT,
    managerId,
  };
}

/**
 * normalizeParsedRow - SIMPLE CLEANUP ONLY
 */
export function normalizeParsedRow(row: ParsedRow): ParsedRow {
  const normalized: ParsedRow = {
    name: row.name ? String(row.name).trim() : null,
    email: row.email ? String(row.email).trim().toLowerCase() : null,
    instagramHandle: row.instagramHandle
      ? String(row.instagramHandle).trim()
      : null, // NO @ removal!
    link: row.link ? String(row.link).trim() : null,
    followers: null,
    country: null,
    notes: row.notes ? String(row.notes).trim() : null,
  };

  // Final fallback if no name
  if (!normalized.name || normalized.name.trim() === "") {
    normalized.name = "Unknown Influencer";
  }

  // Clean up email - handle "DM" markers properly
  if (normalized.email && looksLikeDM(normalized.email.toLowerCase())) {
    normalized.email = null;
  }

  return normalized;
}
