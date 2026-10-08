/**
 * The feed while a post uploads: what plays, what the progress UI says, and how the finished post
 * takes the place of its optimistic copy without a gap. Pure: no React, no native modules.
 */

export type FeedPostLike = {
  id: string;
  _key?: string;
  _optimistic?: { tempId: string; status: "uploading" | "failed"; progress?: number } | null;
};

/** True while any post of this list is still uploading. */
export function isPosting(posts: ReadonlyArray<FeedPostLike>): boolean {
  return posts.some((p) => p._optimistic?.status === "uploading");
}

/**
 * Which feed item plays. While posting nothing plays or makes sound (-1): the creator's own post
 * shows its first frame behind the progress UI. Otherwise the visible item plays, when the screen is focused.
 */
export function playingIndex(posts: ReadonlyArray<FeedPostLike>, visibleIndex: number, focused: boolean): number {
  if (!focused || isPosting(posts)) return -1;
  return visibleIndex;
}

/** The list index the feed scrolls to when an upload starts (the new post is first), or null to stay. */
export function scrollTarget(posts: ReadonlyArray<FeedPostLike>): number | null {
  const i = posts.findIndex((p) => p._optimistic?.status === "uploading");
  return i >= 0 ? i : null;
}

/** The progress text. At 100% the bytes are up but the post row is not yet: say so. */
export function uploadLabel(progress: number | undefined): { text: string; indeterminate: boolean } {
  const p = Math.max(0, Math.min(100, Math.round(progress ?? 0)));
  return p >= 100 ? { text: "Finishing up…", indeterminate: true } : { text: `Uploading… ${p}%`, indeterminate: false };
}

/**
 * The key a list row keeps for its whole life: the optimistic id, also after the server row replaces
 * it, so the row (and its video) is not torn down and rebuilt when the upload completes.
 */
export function rowKey(p: FeedPostLike): string {
  return p._key ?? p._optimistic?.tempId ?? p.id;
}

/** The server's post, carrying the key of the optimistic row it replaces. */
export function adoptKey<T extends FeedPostLike>(real: T, tempId: string | undefined): T {
  return tempId ? { ...real, _key: tempId, _optimistic: undefined } : real;
}

/** A new optimistic post goes first. Never duplicates. */
export function insertFirst<T extends FeedPostLike>(list: ReadonlyArray<T> | undefined, post: T): T[] {
  const rest = (list ?? []).filter((p) => p.id !== post.id);
  return [post, ...rest];
}

/**
 * The finished post replaces the optimistic one in place (same position, never an empty or shorter
 * list in between). If the optimistic row is gone, the post goes first. Never duplicates.
 */
export function swapOptimistic<T extends FeedPostLike>(list: ReadonlyArray<T> | undefined, tempId: string | undefined, real: T): T[] {
  const next = adoptKey(real, tempId);
  const items = list ?? [];
  const at = tempId ? items.findIndex((p) => p._optimistic?.tempId === tempId || p._key === tempId) : -1;
  const without = items.filter((p, i) => i === at || p.id !== real.id);
  if (at < 0) return [next, ...without];
  const out = without.slice();
  out[out.findIndex((p) => p === items[at])] = next;
  return out;
}
