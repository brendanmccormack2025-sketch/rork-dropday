/**
 * Creator status (supabase/migration-graduation.sql): 'active' creators post as usual; 'graduated' ones have outgrown
 * Trial (a verified big creator: no new root posts, everything else stays); 'restricted' is a neutral posting block.
 * The database enforces it; this file is what the app shows and how it reads the backend's answer.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type CreatorStatus = "active" | "graduated" | "restricted";

/** A missing, unknown or null status (before the migration is run) is 'active'. */
export function parseCreatorStatus(value: unknown): CreatorStatus {
  return value === "graduated" || value === "restricted" ? value : "active";
}

export const BADGE_LABEL = "Verified Big Creator";

export const GRADUATED_TITLE = "You made it 🎓";
export const GRADUATED_BODY = "You've graduated from Trial. You can still watch, react, message and support emerging creators.";
export const RESTRICTED_TITLE = "Posting is currently restricted";
export const RESTRICTED_BODY = "You can still watch, react and message.";

export type PostingBlock = { kind: "graduated" | "restricted"; title: string; body: string };

/** Why this status cannot start a new post, or null when it can. Reactions are never blocked (see canReact). */
export function postingBlock(status: CreatorStatus | null | undefined): PostingBlock | null {
  if (status === "graduated") return { kind: "graduated", title: GRADUATED_TITLE, body: GRADUATED_BODY };
  if (status === "restricted") return { kind: "restricted", title: RESTRICTED_TITLE, body: RESTRICTED_BODY };
  return null;
}

export const blockForKind = (kind: "graduated" | "restricted"): PostingBlock => postingBlock(kind)!;

/** Reacting, liking, messaging and following are never limited by the status. */
export function canReact(_status: CreatorStatus | null | undefined): boolean {
  return true;
}

/** A root post (not a reaction) needs an active creator. */
export function canPostRoot(status: CreatorStatus | null | undefined): boolean {
  return postingBlock(status) === null;
}

/** What the database says when it refuses a post for the status (trigger messages POSTING_GRADUATED / POSTING_RESTRICTED). */
export function blockFromBackendError(err: unknown): "graduated" | "restricted" | null {
  const text = `${(err as { message?: unknown } | null)?.message ?? err ?? ""}`;
  if (/POSTING_GRADUATED/.test(text)) return "graduated";
  if (/POSTING_RESTRICTED/.test(text)) return "restricted";
  return null;
}

/** The error the app throws out of createPost for a status block, so every caller can show the matching message. */
export function postingBlockedError(kind: "graduated" | "restricted"): Error & { name: "PostingBlockedError"; kind: "graduated" | "restricted" } {
  const e = new Error(blockForKind(kind).title) as Error & { name: "PostingBlockedError"; kind: "graduated" | "restricted" };
  e.name = "PostingBlockedError";
  e.kind = kind;
  return e;
}

export function postingBlockedKind(err: unknown): "graduated" | "restricted" | null {
  const e = err as { name?: unknown; kind?: unknown } | null;
  if (e?.name === "PostingBlockedError" && (e.kind === "graduated" || e.kind === "restricted")) return e.kind;
  return null;
}

// ── Profile fields ──────────────────────────────────────────────────────────

export type GraduationFields = {
  creator_status?: string | null;
  graduation_reason?: string | null;
  graduated_at?: string | null;
  instagram_url?: string | null;
  tiktok_url?: string | null;
};

/** The badge shows for a graduated profile and only for that. */
export function showsVerifiedBadge(profile: GraduationFields | null | undefined): boolean {
  return parseCreatorStatus(profile?.creator_status) === "graduated";
}

type LinkSource = {
  instagram_handle?: string | null;
  tiktok_handle?: string | null;
  youtube_url?: string | null;
  website?: string | null;
} & GraduationFields;

/**
 * The links of a graduated profile in the shape the shared link pills take: the administrator's Instagram / TikTok URL
 * wins over the creator's own handle (the pills validate both and only ever open https links).
 */
export function linkSourceFor(profile: LinkSource | null | undefined): Omit<LinkSource, keyof GraduationFields> | null {
  if (!profile) return null;
  if (!showsVerifiedBadge(profile)) return profile;
  return {
    instagram_handle: profile.instagram_url || profile.instagram_handle || null,
    tiktok_handle: profile.tiktok_url || profile.tiktok_handle || null,
    youtube_url: profile.youtube_url ?? null,
    website: profile.website ?? null,
  };
}

// ── Selecting the new columns before the migration is run ───────────────────

let graduationColumnsMissing = false;

export function graduationColumns(): string {
  return graduationColumnsMissing ? "" : ", creator_status, graduation_reason, graduated_at, instagram_url, tiktok_url";
}

/** True the first time an error shows the graduation columns do not exist yet (the caller runs the query again). */
export function noteMissingGraduationColumns(error: { message?: string | null } | null | undefined): boolean {
  if (!error || graduationColumnsMissing) return false;
  if (!/creator_status|graduation_reason|graduated_at|instagram_url|tiktok_url/i.test(`${error.message ?? ""}`)) return false;
  graduationColumnsMissing = true;
  return true;
}

export function resetGraduationColumnsForTest(): void {
  graduationColumnsMissing = false;
}
