// src/lib/import-helpers.ts
import { InfluencerStatus, Prisma } from "@prisma/client";

export interface ParsedRow {
  name: string | null;
  email: string | null;
  instagramHandle: string | null;
  link: string | null;
  followers: number | null;
  country: string | null;
  notes: string | null;
}

/**
 * Returns true when a given cell looks like a DM/no-email marker.
 * Covers multiple languages and variants including:
 * "директ", "дм", "дірект", "direct", "DM", "dm", "via dm", "instagram", "no email", "n/a", etc.
 */
export const looksLikeDM = (s: string | null | undefined): boolean => {
  if (s === null || s === undefined) return false;
  const v = String(s).trim().toLowerCase();
  if (!v) return false;

  // markers to treat as DM / no-email. includes Cyrillic and Latin variants.
  const markers = [
    // user-provided
    "директ",
    "дірект",
    "дм",
    // latin
    "direct",
    "dm",
    "d/m",
    "via dm",
    "instagram dm",
    "ig dm",
    "direct message",
    // other common no-email markers
    "instagram",
    "no email",
    "noemail",
    "n/a",
    "na",
    "-",
    "—",
    "none",
  ];

  // Exact-match or contains any marker as a word/phrase
  for (const m of markers) {
    if (v === m) return true;
    if (v.includes(m)) return true;
  }

  // also accept short forms with parentheses or slashes like "(dm)" or "dm/"
  if (/(\(|\)|\/|\\)/.test(v) && /dm/.test(v)) return true;

  return false;
};

const emailLooksValid = (s: string | null): boolean => {
  if (!s) return false;
  const normalized = String(s).trim();
  if (!normalized) return false;
  // treat DM / n/a / empty markers as no email
  const lower = normalized.toLowerCase();
  if (looksLikeDM(lower)) return false;
  // simple email regex (not perfect but OK for validation)
  return /^\S+@\S+\.\S+$/.test(normalized);
};

export function extractInstagramHandleFromLink(
  link?: string | null
): string | null {
  if (!link) return null;
  try {
    // common forms: https://www.instagram.com/handle/  or instagram.com/handle
    const m = String(link).match(/instagram\.com\/([^\/?#\s]+)/i);
    if (m && m[1]) return m[1].replace(/^@/, "").trim();
    // fallback: if cell already looks like handle
    const cand = String(link).trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(cand)) return cand;
    return null;
  } catch {
    return null;
  }
}

/**
 * Given `headers` array and `values` array (row values with 1-based or 0-based indexing),
 * build a ParsedRow. This is tolerant to several header names.
 *
 * DM-detection: if the email cell looks like a DM marker and no email is found,
 * `notes` will be set to "Contact is through DM." (or appended if notes present).
 */
export function parseRowFromHeaders(
  headers: string[],
  values: any[]
): ParsedRow {
  // normalize header names to simple keys
  const headerMap = headers.map((h) =>
    (h || "").toString().trim().toLowerCase()
  );
  const get = (names: string[]) => {
    for (const nm of names) {
      const idx = headerMap.findIndex((h) => h === nm || h.includes(nm));
      if (idx >= 0) return values[idx] ?? null;
    }
    return null;
  };

  const rawNickname = get([
    "nickname",
    "nick",
    "name",
    "full name",
    "fullname",
  ]);
  const rawLink = get([
    "link",
    "profile",
    "instagram",
    "instagram url",
    "profile url",
    "url",
  ]);
  const rawEmail = get(["email", "e-mail", "e_mail", "mail"]);
  const rawFollowers = get(["followers", "followers_count", "followers count"]);
  const rawNotes = get(["notes", "note", "comments", "comment"]);
  const rawCountry = get(["country", "location", "nation"]);

  const linkStr = rawLink ? String(rawLink).trim() : null;
  let instagramHandle = extractInstagramHandleFromLink(linkStr);
  if (!instagramHandle && rawNickname) {
    const cand = String(rawNickname).trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(cand)) instagramHandle = cand;
  }

  const email = emailLooksValid(rawEmail)
    ? String(rawEmail).trim().toLowerCase()
    : null;

  let followersNum: number | null = null;
  if (rawFollowers != null) {
    const digits = String(rawFollowers).replace(/[^\d]/g, "");
    followersNum = digits ? parseInt(digits, 10) : null;
  }

  const name = rawNickname
    ? String(rawNickname).trim()
    : instagramHandle ?? null;

  // determine notes and DM behavior:
  let notesVal: string | null = rawNotes ? String(rawNotes).trim() : null;
  // If there's no valid email and the raw email cell looks like DM or the link looks like an instagram handle without email -> add DM note
  const rawEmailCell = rawEmail ? String(rawEmail).trim() : null;
  // consider DM when raw email cell explicitly contains a DM marker OR when email missing but we have an instagram handle and the raw email cell is empty/absent
  const considerDM =
    (!email && looksLikeDM(rawEmailCell)) ||
    (!email &&
      !!instagramHandle &&
      (!rawEmailCell || rawEmailCell.trim() === ""));

  if (considerDM) {
    const dmNote = "Contact is through DM.";
    if (!notesVal) notesVal = dmNote;
    else if (!notesVal.includes(dmNote)) notesVal = `${notesVal}\n${dmNote}`;
  }

  const countryVal = rawCountry ? String(rawCountry).trim() : null;

  return {
    name: name || null,
    email,
    instagramHandle: instagramHandle || null,
    link: linkStr || null,
    followers: typeof followersNum === "number" ? followersNum : null,
    country: countryVal || null,
    notes: notesVal || null,
  };
}

/**
 * Map ParsedRow -> Prisma.InfluencerCreateManyInput
 */
export function mappedToCreateMany(
  row: ParsedRow,
  managerId: string
): Prisma.InfluencerCreateManyInput {
  return {
    name: row.name || row.instagramHandle || "Unknown",
    email: row.email || null,
    instagramHandle: row.instagramHandle || null,
    link: row.link || null,
    followers: row.followers ?? null,
    country: row.country ?? null,
    notes: row.notes ?? null,
    status: InfluencerStatus.NOT_SENT,
    managerId,
  };
}
