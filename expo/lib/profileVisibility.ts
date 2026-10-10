/**
 * Who sees which posts on a profile. Survived posts stay on the creator's profile for good (until they delete them):
 * they leave the FEED after their 24 h window, never the profile, and their media is never deleted. Pure; erasable
 * TypeScript only so the Node tests can run it. The server decides the same thing in profile_posts() (SQL).
 */
export type ProfilePost = {
  status?: string | null;
  survived_at?: string | null;
  created_at?: string | null;
  media_deleted_at?: string | null;
};

/** Ended and incomplete posts stay on the creator's own profile (privately) for this long. */
export const RECENT_ENDED_DAYS = 7;

/** A post that earned its place: it survived at some point (its status is 'survived', or 'expired' after the window). */
export function hasSurvived(p: ProfilePost): boolean {
  return !!p.survived_at && (p.status === "survived" || p.status === "expired");
}

/** Other people's profile: survived posts only, with their media. Never testing, ended, incomplete or queued posts. */
export function isOnOtherProfile(p: ProfilePost): boolean {
  return hasSurvived(p) && !p.media_deleted_at;
}

/** The creator's own profile: queued and testing posts, survived posts forever, and recent ended / incomplete ones. */
export function isOnOwnProfilePost(p: ProfilePost, nowMs: number = Date.now()): boolean {
  if (p.status === "queued" || p.status === "trial") return true;
  if (hasSurvived(p)) return !p.media_deleted_at;
  if (p.status === "archived" || p.status === "incomplete") {
    if (p.media_deleted_at) return false;
    const created = Date.parse(p.created_at ?? "");
    return Number.isNaN(created) ? true : nowMs - created < RECENT_ENDED_DAYS * 24 * 60 * 60 * 1000;
  }
  return false;
}
