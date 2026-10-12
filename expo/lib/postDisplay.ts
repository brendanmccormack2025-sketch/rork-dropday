/**
 * What the post screens show for a post's status and counters. Pure; erasable TypeScript only so the Node tests can run it.
 * "Expired" is an internal status: it never appears in the UI, and a post that survived is never dimmed.
 */

/** The green SURVIVED banner shows for this long after survived_at, then the post is a normal profile post. */
export const SURVIVED_BANNER_MS = 24 * 60 * 60 * 1000;

type StatusPost = { status?: string | null; survived_at?: string | null };

/** A post that survived at some point (status 'survived', or 'expired' after the window). */
export function hasSurvivedPost(p: StatusPost): boolean {
  return !!p.survived_at && (p.status === "survived" || p.status === "expired");
}

/** SURVIVED banner: only during the 24 hours after survived_at. Never for other statuses, never without survived_at. */
export function showSurvivedBanner(p: StatusPost, nowMs: number): boolean {
  if (!hasSurvivedPost(p)) return false;
  const at = Date.parse(p.survived_at as string);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < SURVIVED_BANNER_MS;
}

/** Dim the video only for a post that never survived and was archived (creator-only, and those posts are hidden anyway). */
export function shouldDimPost(p: StatusPost): boolean {
  if (hasSurvivedPost(p)) return false;
  return p.status === "archived" || p.status === "expired";
}

/** The view counter: the recorded raw views, or the qualified views if those are higher (never less than what was recorded). */
export function viewsShown(p: { view_count?: number | null; qualified_view_count?: number | null }): number {
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return Math.max(n(p.view_count), n(p.qualified_view_count));
}

/** Compact count: 842, 1.2K, 12.3K, 3.4M (rounded down, so 999,999 reads 999.9K, never 1000K; ".0" is dropped). */
export function formatCount(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (n >= size) return `${(Math.floor((n / size) * 10) / 10).toString()}${suffix}`;
  }
  return String(n);
}
