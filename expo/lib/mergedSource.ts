/**
 * Merged projects: "original" is the MERGED file. The segments a take was recorded in only exist to build that
 * file; the editor never plays them (no live multi-clip seams at the camera flips).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

type ClipLike = { uri: string };

/** The distinct files the player would load for these clips, in order. */
export function playerUris(clips: ReadonlyArray<ClipLike>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of clips) if (!seen.has(c.uri)) (seen.add(c.uri), out.push(c.uri));
  return out;
}

/**
 * Keep only clips of the merged file when the project was merged. A clip of any pre-merge segment is dropped (and
 * reported by the caller): its time range belongs to a different file than the editor's timeline.
 */
export function enforceMergedSource<T extends ClipLike>(
  clips: ReadonlyArray<T>,
  merged: { uri: string } | null,
  segmentUris: ReadonlyArray<string>,
): { clips: T[]; dropped: T[] } {
  if (!merged) return { clips: [...clips], dropped: [] };
  const segments = new Set(segmentUris.filter((u) => u !== merged.uri));
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const c of clips) (segments.has(c.uri) ? dropped : kept).push(c);
  return { clips: kept, dropped };
}

/**
 * After a merge the merged file is the ONE source of truth for its own length: every clip of it carries the length the render
 * verified (durationMs), and no trim end reaches past it. Nothing a player reports while a clip is loading (it can still be the
 * previous clip's length) may shorten it. Returns the same array when nothing needs fixing.
 */
export function pinMergedLength<T extends ClipLike & { durationMs?: number; trimStartMs?: number; trimEndMs?: number }>(
  clips: T[],
  merged: { uri: string; durationMs: number } | null,
): T[] {
  if (!merged || !(merged.durationMs > 0)) return clips;
  let changed = false;
  const out = clips.map((c) => {
    if (c.uri !== merged.uri) return c;
    const end = c.trimEndMs && c.trimEndMs > 0 ? Math.min(c.trimEndMs, merged.durationMs) : merged.durationMs;
    if (c.durationMs === merged.durationMs && c.trimEndMs === end) return c;
    changed = true;
    return { ...c, durationMs: merged.durationMs, trimEndMs: end };
  });
  return changed ? out : clips;
}
