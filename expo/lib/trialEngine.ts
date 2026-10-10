/**
 * Client side of the progressive-testing engine. Pure; erasable TypeScript only so the Node tests can run it.
 * The scoring itself lives in SQL (supabase/migration-trial-engine.sql); the app only reports how long a post was
 * watched and shows the creator where their post stands.
 */

export const TRIAL_ON_TRIAL_TITLE = "YOUR VIDEO IS ON TRIAL";
export const TRIAL_INCOMPLETE_MESSAGE = "Trial incomplete: not enough testing activity was available. Try posting again!";
export const TRIAL_INCOMPLETE_NOTIFICATION = "Trial incomplete: not enough testing activity was available. Try posting again!";

/** Seconds of watching that mean "watched to the end" when the clip is at least that long. */
const COMPLETED_FRACTION = 0.9;

export type ViewProgress = { watch_ms: number; duration_ms: number; completed: boolean };

/** What to report for one viewing: whole milliseconds, never negative, completed at 90% of a known duration. */
export function viewProgress(watchedMs: number, durationMs: number | null | undefined): ViewProgress {
  const watch = Math.max(0, Math.round(Number.isFinite(watchedMs) ? watchedMs : 0));
  const dur = Math.max(0, Math.round(durationMs != null && Number.isFinite(durationMs) ? durationMs : 0));
  return { watch_ms: watch, duration_ms: dur, completed: dur > 0 && watch >= dur * COMPLETED_FRACTION };
}

/** Anything under this is a swipe, not a view; the server counts it as an exposure with a score of 0. */
export const SWIPE_MS = 2000;
export function worthReporting(watchedMs: number): boolean {
  return watchedMs >= 250;
}

export type EngineFeedRow = { post_id: string | null; position: number; page_rows?: number | null };

/**
 * get_feed_engine returns `page_rows` (the source rows of the page, before testing posts the viewer is not assigned
 * to were filtered out) and one sentinel row with a null post_id when the page is empty. The old get_feed returns
 * plain rows. Returns the posts' ids in order plus the row count to use for end-of-feed detection.
 */
export function readFeedRows(rows: EngineFeedRow[]): { ids: { post_id: string; position: number }[]; rowCount: number } {
  const ids = rows.filter((r): r is { post_id: string; position: number } => !!r.post_id).map((r) => ({ post_id: r.post_id, position: r.position }));
  const counts = rows.map((r) => r.page_rows).filter((n): n is number => typeof n === "number");
  return { ids, rowCount: counts.length > 0 ? Math.max(...counts) : rows.length };
}

/** The status the creator sees for their own post on the profile / feed. Never says "failed". */
export function creatorTrialNote(status: string | null | undefined, queuePosition?: number | null): { title: string; body: string | null } | null {
  if (status === "queued") return { title: queuedLabel(queuePosition), body: null };
  if (status === "trial") return { title: TRIAL_ON_TRIAL_TITLE, body: null };
  if (status === "incomplete") return { title: "TRIAL INCOMPLETE", body: TRIAL_INCOMPLETE_MESSAGE };
  return null;
}

/** The feed's empty state (nothing assigned and nothing eligible to watch): never a blank screen. */
export const FEED_CAUGHT_UP_TITLE = "You're all caught up";
export const FEED_CAUGHT_UP_BODY = "Be the first to put something on Trial";
export const FEED_CAUGHT_UP_BUTTON = "Put it on Trial";

/** "Queued: up next" for the first post in line, "Queued: #2 in line" after that. */
export function queuedLabel(position: number | null | undefined): string {
  return !position || position <= 1 ? "Queued: up next" : `Queued: #${position} in line`;
}

/** A creator's place in line for each queued post, oldest first (1 = up next). */
export function queuePositions(posts: Array<{ id: string; status?: string | null; created_at?: string | null }>): Map<string, number> {
  const queued = posts
    .filter((p) => p.status === "queued")
    .sort((a, b) => (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0) || a.id.localeCompare(b.id));
  return new Map(queued.map((p, i) => [p.id, i + 1]));
}
