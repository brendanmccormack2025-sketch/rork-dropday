import { Linking } from "react-native";

/**
 * Creator links (Instagram, TikTok, YouTube, website): the ONE place that
 * validates, normalizes, builds and opens them.
 *
 *  - Handles may contain only letters, digits, dot and underscore (max 30);
 *    a leading @ is stripped. Anything else is rejected.
 *  - Only https URLs are ever built or opened. Other schemes, empty values and
 *    malformed input are rejected (null).
 *  - Pasted URLs are normalized back to a handle.
 */

const HANDLE_RE = /^[A-Za-z0-9._]+$/;
const MAX_HANDLE_LENGTH = 30;
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];

export type CreatorLinkSource =
  | {
      instagram_handle?: string | null;
      tiktok_handle?: string | null;
      youtube_url?: string | null;
      website?: string | null;
    }
  | null
  | undefined;

export type CreatorLinkKind = "instagram" | "tiktok" | "youtube" | "website";

export type CreatorLink = {
  kind: CreatorLinkKind;
  /** Safe https URL. */
  url: string;
  /** Short text for chips: @handle or the website host. */
  label: string;
};

function cleanHandle(raw: string): string | null {
  const h = raw.trim().replace(/^@+/, "");
  if (h.length === 0 || h.length > MAX_HANDLE_LENGTH) return null;
  return HANDLE_RE.test(h) ? h : null;
}

/** Parse an https URL from input that may omit the scheme. Null for any other scheme. */
function parseHttps(raw: string): URL | null {
  const t = raw.trim();
  if (t.length === 0 || /\s/.test(t)) return null;
  let candidate = t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    if (!/^https:\/\//i.test(t)) return null;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/:]+:\d+(\/|$)/.test(t)) {
    // javascript:, data:, mailto:, ... (a bare "host:port" is allowed)
    return null;
  } else {
    candidate = `https://${t}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function hostMatches(u: URL, domain: string): boolean {
  const h = u.hostname.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

function looksLikeUrl(raw: string): boolean {
  return /[/:]/.test(raw) || /^www\./i.test(raw.trim());
}

/** Instagram handle from a handle or a pasted instagram.com URL; null if invalid. */
export function normalizeInstagramHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!looksLikeUrl(raw)) return cleanHandle(raw);
  const u = parseHttps(raw);
  if (!u || !hostMatches(u, "instagram.com")) return null;
  return cleanHandle(u.pathname.split("/").filter(Boolean)[0] ?? "");
}

/** TikTok handle from a handle or a pasted tiktok.com URL; null if invalid. */
export function normalizeTikTokHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!looksLikeUrl(raw)) return cleanHandle(raw);
  const u = parseHttps(raw);
  if (!u || !hostMatches(u, "tiktok.com")) return null;
  return cleanHandle(u.pathname.split("/").filter(Boolean)[0] ?? "");
}

/**
 * Value to STORE for YouTube: "@handle" for a handle or a youtube.com/@handle
 * URL, otherwise the https youtube.com / youtu.be URL. Null if invalid.
 */
export function normalizeYouTubeValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t.length === 0) return null;
  if (!looksLikeUrl(t)) {
    const h = cleanHandle(t);
    return h ? `@${h}` : null;
  }
  const u = parseHttps(t);
  if (!u || !YOUTUBE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/);
  if (m && m[1]!.length <= MAX_HANDLE_LENGTH) return `@${m[1]}`;
  return u.toString();
}

/** Website as a safe https URL (adds https:// to a bare domain); null if invalid. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = parseHttps(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    return null;
  }
  const href = u.toString();
  return u.pathname === "/" && !u.search && !u.hash ? href.replace(/\/$/, "") : href;
}

export function instagramUrl(raw: string | null | undefined): string | null {
  const h = normalizeInstagramHandle(raw);
  return h ? `https://www.instagram.com/${h}` : null;
}

export function tiktokUrl(raw: string | null | undefined): string | null {
  const h = normalizeTikTokHandle(raw);
  return h ? `https://www.tiktok.com/@${h}` : null;
}

/** The stored https URL, or https://www.youtube.com/@handle for a value starting with @. */
export function youtubeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t.startsWith("@")) {
    const h = cleanHandle(t);
    return h ? `https://www.youtube.com/@${h}` : null;
  }
  const u = parseHttps(t);
  if (!u || !YOUTUBE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return u.toString();
}

export const websiteUrl = normalizeWebsite;

/** Only the links the creator has set (and that validate), in a fixed order. */
export function getCreatorLinks(profile: CreatorLinkSource): CreatorLink[] {
  if (!profile) return [];
  const out: CreatorLink[] = [];

  const ig = normalizeInstagramHandle(profile.instagram_handle);
  if (ig) out.push({ kind: "instagram", url: `https://www.instagram.com/${ig}`, label: `@${ig}` });

  const tt = normalizeTikTokHandle(profile.tiktok_handle);
  if (tt) out.push({ kind: "tiktok", url: `https://www.tiktok.com/@${tt}`, label: `@${tt}` });

  const yt = youtubeUrl(profile.youtube_url);
  if (yt) {
    const handle = profile.youtube_url?.trim().startsWith("@") ? profile.youtube_url.trim() : null;
    out.push({ kind: "youtube", url: yt, label: handle ?? "YouTube" });
  }

  const web = normalizeWebsite(profile.website);
  if (web) {
    out.push({ kind: "website", url: web, label: web.replace(/^https:\/\//, "").replace(/\/$/, "") });
  }
  return out;
}

/** Open a link; never throws. Returns whether the OS accepted it. */
export async function openCreatorLink(url: string): Promise<boolean> {
  try {
    if (!url.startsWith("https://")) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Text-field helper for handle inputs: a pasted URL becomes its handle; typed
 * text has invalid characters stripped (same as before).
 */
export function sanitizeHandleInput(text: string, kind: "instagram" | "tiktok"): string {
  if (looksLikeUrl(text)) {
    const h = kind === "instagram" ? normalizeInstagramHandle(text) : normalizeTikTokHandle(text);
    if (h) return h;
  }
  return text.replace(/^@/, "").replace(/[^a-zA-Z0-9._]/g, "").slice(0, MAX_HANDLE_LENGTH);
}

// ── youtube_url column fallback ─────────────────────────────────────────────
// Until migration-profile-links.sql is run, selecting youtube_url fails. Queries
// build their column list with profileLinkColumns() and, when a result carries
// an error for which noteMissingYoutubeColumn() returns true, run once more.

let youtubeColumnMissing = false;

export function profileLinkColumns(): string {
  return youtubeColumnMissing
    ? "instagram_handle, tiktok_handle, website"
    : "instagram_handle, tiktok_handle, youtube_url, website";
}

/** True the first time an error shows that youtube_url does not exist (caller should retry once). */
export function noteMissingYoutubeColumn(
  error: { message?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (!error || youtubeColumnMissing) return false;
  if (!/youtube_url/i.test(`${error.message ?? ""}`)) return false;
  youtubeColumnMissing = true;
  return true;
}
