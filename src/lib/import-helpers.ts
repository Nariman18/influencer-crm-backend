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
 * Returns true when a given cell looks like a DM/no-email marker.
 */
export const looksLikeDM = (s: string | null | undefined): boolean => {
  if (s === null || s === undefined) return false;
  const v = String(s).trim().toLowerCase();
  if (!v) return false;

  const markers = [
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
  ];

  for (const m of markers) {
    if (v === m) return true;
    if (v.includes(m)) return true;
  }

  if (/(\(|\)|\/|\\)/.test(v) && /dm/.test(v)) return true;

  return false;
};

/**
 * Extract plain text from any cell value (handles richText, objects, etc.)
 * NOTE: intentionally simple — does NOT attempt fancy font conversions.
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
    // ExcelJS richText format
    if ("richText" in v && Array.isArray(v.richText)) {
      const text = v.richText
        .map((seg: any) => {
          if (!seg) return "";
          if (typeof seg === "string") return seg;
          if (typeof seg.text === "string") return seg.text;
          return "";
        })
        .join("")
        .trim();
      if (text.toLowerCase().startsWith("mailto:"))
        return text.substring(7).trim();
      return text;
    }

    // hyperlink object: { text, hyperlink }
    if ("hyperlink" in v) {
      const hyperlink = String(v.hyperlink || "").trim();
      if (hyperlink.toLowerCase().startsWith("mailto:")) {
        return hyperlink.substring(7).trim();
      }
      if ("text" in v && typeof v.text === "string") return v.text.trim();
    }

    // simple text object
    if ("text" in v && typeof v.text === "string") {
      const t = v.text.trim();
      if (t.toLowerCase().startsWith("mailto:")) return t.substring(7).trim();
      return t;
    }

    // formula result
    if ("result" in v) return extractCellText(v.result);

    // array
    if (Array.isArray(v)) {
      return v
        .map((it) => extractCellText(it))
        .join(" ")
        .trim();
    }

    // fallback
    if (typeof v.toString === "function") {
      const s = v.toString();
      if (s && s !== "[object Object]") {
        const t = s.trim();
        if (t.toLowerCase().startsWith("mailto:")) return t.substring(7).trim();
        return t;
      }
    }
  }

  return "";
};

/**
 * Simple email validation - very permissive.
 * Returns true if the string contains @ and looks like an email.
 * Returns false for DM markers, empty values, or clearly non-email text.
 */
const emailLooksValid = (s: any): boolean => {
  if (s === null || s === undefined) return false;
  const normalized = extractCellText(s).trim();
  if (!normalized) return false;

  // Skip DM markers
  if (looksLikeDM(normalized.toLowerCase())) return false;

  // Very simple check: must have @ and at least one dot after @
  // This allows weird characters, unicode, etc.
  const atIndex = normalized.indexOf("@");
  if (atIndex < 1) return false; // must have something before @
  const afterAt = normalized.substring(atIndex + 1);
  if (!afterAt.includes(".")) return false;
  if (afterAt.endsWith(".")) return false;

  return true;
};

export function extractInstagramHandleFromLink(
  link?: string | null | undefined
): string | null {
  if (!link) return null;
  try {
    const m = String(link).match(/instagram\.com\/([^\/?#\s]+)/i);
    if (m && m[1]) return m[1].replace(/^@/, "").trim();
    const cand = String(link).trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(cand)) return cand;
    return null;
  } catch {
    return null;
  }
}

/**
 * parseRowFromHeaders
 * - headers: normalized header list (strings)
 * - values: ExcelJS row.values (1-based array)
 *
 * This version is conservative and explicitly uses values[index+1].
 */
export function parseRowFromHeaders(
  headers: string[],
  values: any[]
): ParsedRow {
  const headerMap = headers.map((h) =>
    (h || "").toString().trim().toLowerCase()
  );

  const getCellByNames = (names: string[]) => {
    for (const nm of names) {
      // exact match first
      const exactIdx = headerMap.findIndex((h) => h === nm);
      if (exactIdx >= 0) return values[exactIdx + 1] ?? null;
      // contains fallback
      const containsIdx = headerMap.findIndex((h) => h.includes(nm));
      if (containsIdx >= 0) return values[containsIdx + 1] ?? null;
    }
    return null;
  };

  const rawNickname = getCellByNames([
    "nickname",
    "nick",
    "name",
    "full name",
    "fullname",
  ]);
  const rawLink = getCellByNames([
    "link",
    "profile",
    "instagram",
    "instagram url",
    "profile url",
    "url",
  ]);
  const rawEmail = getCellByNames(["email", "e-mail", "e_mail", "mail"]);
  const rawFollowers = getCellByNames([
    "followers",
    "followers_count",
    "followers count",
  ]);
  const rawNotes = getCellByNames(["notes", "note", "comments", "comment"]);
  const rawCountry = getCellByNames(["country", "location", "nation"]);

  const linkStr = rawLink ? String(rawLink).trim() : null;
  let instagramHandle = extractInstagramHandleFromLink(linkStr);

  if (!instagramHandle && rawNickname) {
    const cand = String(rawNickname).trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(cand)) instagramHandle = cand;
  }

  const emailCandidate =
    rawEmail === null || rawEmail === undefined
      ? null
      : extractCellText(rawEmail).trim();
  const email =
    emailCandidate && emailLooksValid(emailCandidate)
      ? emailCandidate.toLowerCase()
      : null;

  let followersNum: number | null = null;
  if (rawFollowers !== null && rawFollowers !== undefined) {
    const rawFollowersStr = String(rawFollowers).trim();
    if (rawFollowersStr !== "") {
      const digits = rawFollowersStr.replace(/[^\d]/g, "");
      followersNum = digits ? parseInt(digits, 10) : null;
    }
  }

  const name = rawNickname ?? instagramHandle ?? null;

  let notesVal: string | null =
    rawNotes !== null && rawNotes !== undefined
      ? String(rawNotes).trim()
      : null;
  const rawEmailCell =
    rawEmail !== null && rawEmail !== undefined
      ? String(extractCellText(rawEmail)).trim()
      : null;

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

  const countryVal =
    rawCountry !== null && rawCountry !== undefined
      ? String(rawCountry).trim()
      : null;

  return {
    name,
    email,
    instagramHandle: instagramHandle ?? null,
    link: linkStr ?? null,
    followers: typeof followersNum === "number" ? followersNum : null,
    country: countryVal ?? null,
    notes: notesVal ?? null,
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
    name:
      typeof row.name === "string" && row.name.trim()
        ? row.name
        : row.instagramHandle || "Unknown",
    email: row.email || null,
    instagramHandle: row.instagramHandle || null,
    link: row.link ?? null,
    followers: typeof row.followers === "number" ? row.followers : null,
    country: row.country ?? null,
    notes: row.notes ?? null,
    status: InfluencerStatus.NOT_SENT,
    managerId,
  };
}
