// src/lib/import-helpers.ts
import { InfluencerStatus, Prisma } from "@prisma/client";

/**
 * Note: ParsedRow fields are intentionally permissive (any) because row parsing
 * may return ExcelJS cell objects / arrays / formula objects. The import worker
 * will normalize these to primitives before persisting.
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
    if (v.includes(m!)) return true;
  }

  if (/(\(|\)|\/|\\)/.test(v) && /dm/.test(v)) return true;

  return false;
};

/**
 * Extract plain text from any cell value (handles richText, objects, etc.)
 */
const extractCellText = (v: any): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    // Clean up mailto: prefix and trim
    let text = v.trim();
    if (text.toLowerCase().startsWith("mailto:")) {
      text = text.substring(7).trim();
    }
    return text;
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";

  if (typeof v === "object") {
    // ExcelJS richText format
    if ("richText" in v && Array.isArray(v.richText)) {
      let text = v.richText
        .map((seg: any) => {
          if (!seg) return "";
          if (typeof seg === "string") return seg;
          if (typeof seg.text === "string") return seg.text;
          return "";
        })
        .join("")
        .trim();
      // Clean up mailto: prefix
      if (text.toLowerCase().startsWith("mailto:")) {
        text = text.substring(7).trim();
      }
      return text;
    }

    // Hyperlink object: { text: "...", hyperlink: "mailto:..." }
    if ("hyperlink" in v) {
      // Try to get email from hyperlink if it's a mailto link
      const hyperlink = String(v.hyperlink || "").trim();
      if (hyperlink.toLowerCase().startsWith("mailto:")) {
        return hyperlink.substring(7).trim();
      }
      // Otherwise use text property
      if ("text" in v && typeof v.text === "string") {
        return v.text.trim();
      }
    }

    // Simple text object
    if ("text" in v && typeof v.text === "string") {
      let text = v.text.trim();
      if (text.toLowerCase().startsWith("mailto:")) {
        text = text.substring(7).trim();
      }
      return text;
    }

    // Formula result
    if ("result" in v) {
      return extractCellText(v.result);
    }

    // Array of values
    if (Array.isArray(v)) {
      return v
        .map((item) => extractCellText(item))
        .join(" ")
        .trim();
    }

    // Try toString as last resort
    if (typeof v.toString === "function") {
      const s = v.toString();
      if (s && s !== "[object Object]") {
        let text = s.trim();
        if (text.toLowerCase().startsWith("mailto:")) {
          text = text.substring(7).trim();
        }
        return text;
      }
    }
  }

  return "";
};

const emailLooksValid = (s: any): boolean => {
  if (s === null || s === undefined) return false;
  const normalized = extractCellText(s).trim();
  if (!normalized) return false;
  if (looksLikeDM(normalized.toLowerCase())) return false;
  return /^\S+@\S+\.\S+$/.test(normalized);
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
 * Given `headers` array and `values` array (row values with 1-based or 0-based indexing),
 * build a ParsedRow. This function is intentionally conservative: it returns raw cell
 * values (not stringified) for fields like `name` so the import worker can normalize
 * complex ExcelJS objects (richText / formula objects / arrays) later.
 */
export function parseRowFromHeaders(
  headers: string[],
  values: any[]
): ParsedRow {
  // defensive: ensure headers is an array and values is the ExcelJS row.values (1-based)
  const headerMap = headers.map((h) =>
    (h || "").toString().trim().toLowerCase()
  );

  // helper: fetch a cell by header name (case-insensitive, allow contains)
  const getCellByNames = (names: string[]) => {
    for (const nm of names) {
      // exact match first
      const exactIdx = headerMap.findIndex((h) => h === nm);
      if (exactIdx >= 0) {
        // ExcelJS row.values are 1-based
        return values[exactIdx + 1] ?? null;
      }
      // contains fallback
      const containsIdx = headerMap.findIndex((h) => h.includes(nm));
      if (containsIdx >= 0) {
        return values[containsIdx + 1] ?? null;
      }
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

  // normalize and try to detect handle from link or nickname
  const linkStr = rawLink ? String(rawLink).trim() : null;
  let instagramHandle = extractInstagramHandleFromLink(linkStr);

  if (!instagramHandle && rawNickname) {
    const cand = String(rawNickname).trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(cand)) instagramHandle = cand;
  }

  // Use extractCellText to safely get plain text from rawEmail (handles richText/hyperlinks/etc.)
  const emailCandidate =
    rawEmail === null || rawEmail === undefined
      ? null
      : extractCellText(rawEmail).trim();
  const email =
    emailCandidate && emailLooksValid(emailCandidate)
      ? emailCandidate.toLowerCase()
      : null;

  // followers coercion
  let followersNum: number | null = null;
  if (rawFollowers !== null && rawFollowers !== undefined) {
    const rawFollowersStr = String(rawFollowers).trim();
    if (rawFollowersStr !== "") {
      const digits = rawFollowersStr.replace(/[^\d]/g, "");
      followersNum = digits ? parseInt(digits, 10) : null;
    }
  }

  const name = rawNickname ?? instagramHandle ?? null;

  // Notes handling + DM logic
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
 * Note: import worker will call normalizeParsedRow before mappedToCreateMany,
 * so values here should already be primitives.
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
