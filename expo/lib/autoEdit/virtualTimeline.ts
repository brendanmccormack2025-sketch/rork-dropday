/**
 * The virtual timeline of the Cuts screen: the edit is a list of source ranges, and the preview plays the ORIGINAL
 * source through it. Nothing is rendered, merged or exported while editing: a cut only changes this list.
 *
 *  - edited time <-> source time (playhead, captions, text overlays),
 *  - playback: when the player reaches the end of a kept range, jump to the start of the next one (`playbackTick`),
 *    decided early and from a precomputed table so the seek is the only work left at the seam,
 *  - a playhead that moves continuously between the player's coarse progress events (`interpolatePosition`).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type ClipLike = { id?: string; uri?: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

/** One kept range of the source and where it sits on the edited timeline. */
export type Segment = {
  index: number;
  id: string;
  srcStartMs: number;
  srcEndMs: number;
  outStartMs: number;
  outEndMs: number;
};

/** A clip's source range: trimEnd 0 / missing means "to the end of the file". */
export function clipRange(c: ClipLike): { start: number; end: number } {
  const start = c.trimStartMs ?? 0;
  const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
  return { start, end: Number.isFinite(end) ? end : start };
}

/** The segment table for a list of clips (in timeline order). Empty clips are left out. */
export function buildSegments(clips: ClipLike[]): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    const { start, end } = clipRange(c);
    const dur = end - start;
    if (!(dur > 0)) return;
    out.push({ index: i, id: c.id ?? String(i), srcStartMs: start, srcEndMs: end, outStartMs: t, outEndMs: t + dur });
    t += dur;
  });
  return out;
}

export function totalEditedMs(segs: Segment[]): number {
  return segs.length === 0 ? 0 : segs[segs.length - 1]!.outEndMs;
}

/** The segment holding an edited time (the last one for a time past the end, the first for a negative one); -1: none. */
export function segmentAtEdited(segs: Segment[], editedMs: number): number {
  if (segs.length === 0) return -1;
  if (!(editedMs > 0)) return 0;
  for (let i = 0; i < segs.length; i++) {
    if (editedMs < segs[i]!.outEndMs) return i;
  }
  return segs.length - 1;
}

/** Edited time -> the source moment it shows (null without segments). A time past the end maps to the end. */
export function editedToSource(segs: Segment[], editedMs: number): { sourceMs: number; segment: number } | null {
  const i = segmentAtEdited(segs, editedMs);
  if (i < 0) return null;
  const s = segs[i]!;
  const within = Math.min(s.outEndMs - s.outStartMs, Math.max(0, editedMs - s.outStartMs));
  return { sourceMs: s.srcStartMs + within, segment: i };
}

/**
 * Source time -> edited time. A moment inside a removed range lands on the seam (the start of the next kept range,
 * or the end of the video after the last one); `removed` says so. Edited time of a moment before the first range is 0.
 */
export function sourceToEdited(segs: Segment[], sourceMs: number): { editedMs: number; segment: number; removed: boolean } {
  if (segs.length === 0) return { editedMs: 0, segment: -1, removed: false };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (sourceMs < s.srcStartMs) return { editedMs: s.outStartMs, segment: i, removed: true };
    if (sourceMs < s.srcEndMs) return { editedMs: s.outStartMs + (sourceMs - s.srcStartMs), segment: i, removed: false };
  }
  const last = segs[segs.length - 1]!;
  return { editedMs: last.outEndMs, segment: segs.length - 1, removed: sourceMs > last.srcEndMs };
}

/** The edited time the player is at, while it plays segment `activeIndex` (held inside that segment). */
export function editedFromPlayer(segs: Segment[], activeIndex: number, sourceMs: number): number {
  const s = segs[Math.min(Math.max(0, activeIndex), segs.length - 1)];
  if (!s) return 0;
  return s.outStartMs + Math.min(s.outEndMs - s.outStartMs, Math.max(0, sourceMs - s.srcStartMs));
}

/** How early (before the end of a kept range) the jump to the next one is made, so the seek lands at the seam. */
export const SKIP_LEAD_MS = 45;
/** A player this far before the start of its segment, or this far past its end, is out of place and is put back. */
export const SKIP_SLACK_MS = 150;

export type PlaybackTick =
  | { kind: "play"; editedMs: number }
  /** The active range is over: go on with `toIndex`. `seekToSourceMs` is null when it continues where this one ends. */
  | { kind: "advance"; toIndex: number; seekToSourceMs: number | null; editedMs: number }
  /** The last range is over. */
  | { kind: "end"; editedMs: number }
  /** The player is somewhere the active range does not cover (a seek landed in a removed part): put it back. */
  | { kind: "resync"; toIndex: number; seekToSourceMs: number; editedMs: number };

/**
 * What the playback loop does with the player at `sourceMs` while it plays `activeIndex`:
 *  - inside the range: nothing (the edited time is returned for the playhead),
 *  - within `leadMs` of the end: jump to the start of the next range (no seek if it continues where this one ends),
 *  - far outside the range (a cut-out part was entered): to the range that holds the moment, else the next one.
 */
export function playbackTick(args: { segs: Segment[]; activeIndex: number; sourceMs: number; leadMs?: number }): PlaybackTick {
  const { segs, sourceMs } = args;
  const lead = args.leadMs ?? SKIP_LEAD_MS;
  if (segs.length === 0) return { kind: "end", editedMs: 0 };
  const ai = Math.min(Math.max(0, args.activeIndex), segs.length - 1);
  const s = segs[ai]!;
  if (sourceMs < s.srcStartMs - SKIP_SLACK_MS || sourceMs > s.srcEndMs + SKIP_SLACK_MS) {
    const at = sourceToEdited(segs, sourceMs);
    const to = at.segment;
    const target = segs[to]!;
    if (at.removed || sourceMs < target.srcStartMs) {
      return { kind: "resync", toIndex: to, seekToSourceMs: target.srcStartMs, editedMs: target.outStartMs };
    }
    return { kind: "resync", toIndex: to, seekToSourceMs: sourceMs, editedMs: at.editedMs };
  }
  if (sourceMs >= s.srcEndMs - lead) {
    if (ai >= segs.length - 1) return { kind: "end", editedMs: s.outEndMs };
    const next = segs[ai + 1]!;
    const continuous = Math.abs(next.srcStartMs - s.srcEndMs) <= 1;
    return { kind: "advance", toIndex: ai + 1, seekToSourceMs: continuous ? null : next.srcStartMs, editedMs: next.outStartMs };
  }
  return { kind: "play", editedMs: editedFromPlayer(segs, ai, sourceMs) };
}

/** Whether a jump is needed at all, for the list of seams: the source time each seam jumps to (null: continuous). */
export function seamTargets(segs: Segment[]): Array<number | null> {
  return segs.slice(0, -1).map((s, i) => (Math.abs(segs[i + 1]!.srcStartMs - s.srcEndMs) <= 1 ? null : segs[i + 1]!.srcStartMs));
}

// ── the playhead between progress events ──

/**
 * Where the playhead is `now`, given the last position the player reported (`anchorMs` at `anchorAt`): it moves on at
 * normal speed while playing, never past `maxMs`.
 */
export function interpolatePosition(anchorMs: number, anchorAt: number, now: number, playing: boolean, maxMs: number): number {
  const t = playing ? anchorMs + Math.max(0, now - anchorAt) : anchorMs;
  return Math.min(Math.max(0, maxMs), Math.max(0, t));
}

/**
 * One frame of the playhead's display: it follows the target closely and smoothly, and jumps when the target jumped
 * (a seek, a seam, an edit).
 */
export function followPlayhead(displayMs: number, targetMs: number, jumpMs: number = 250, ease: number = 0.45): number {
  if (!Number.isFinite(displayMs)) return targetMs;
  if (Math.abs(targetMs - displayMs) > jumpMs) return targetMs;
  return displayMs + (targetMs - displayMs) * ease;
}

// ── a split point ──

/** Smallest piece a split may leave on either side. */
export const MIN_PIECE_MS = 80;

/** Whether the playhead is inside a segment far enough from both ends to split there (edited time). */
export function canSplitAt(segs: Segment[], editedMs: number, minPieceMs: number = MIN_PIECE_MS): boolean {
  const i = segmentAtEdited(segs, editedMs);
  if (i < 0) return false;
  const s = segs[i]!;
  return editedMs - s.outStartMs >= minPieceMs && s.outEndMs - editedMs >= minPieceMs;
}
