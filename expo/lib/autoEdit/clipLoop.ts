/**
 * A selected clip plays on its own (loops) until the creator taps off or selects another one.
 *
 * Nothing is loaded or rendered for it: the same players seek inside the source. The loop jumps back a moment BEFORE the
 * clip's end, so no frame of the footage after the clip is ever shown at the loop point.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { buildSegments, type ClipLike, type Segment } from "./virtualTimeline.ts";

/** The jump back to the clip's start is made this long before its end. */
export const CLIP_LOOP_LEAD_MS = 45;
/** A player this far outside the clip's range is put back at its start (a seek elsewhere, then play). */
export const CLIP_LOOP_SLACK_MS = 150;

export type ClipLoop = {
  /** The clip's source range and where it starts on the edited timeline. */
  index: number;
  srcStartMs: number;
  srcEndMs: number;
  outStartMs: number;
  outEndMs: number;
};

/** The loop of a clip (by id), or null when there is no such clip. */
export function clipLoopOf(clips: ClipLike[], clipId: string | null | undefined): ClipLoop | null {
  if (!clipId) return null;
  const segs = buildSegments(clips);
  const seg = segs.find((s) => s.id === clipId);
  return seg ? loopOfSegment(seg) : null;
}

export function loopOfSegment(seg: Segment): ClipLoop {
  return { index: seg.index, srcStartMs: seg.srcStartMs, srcEndMs: seg.srcEndMs, outStartMs: seg.outStartMs, outEndMs: seg.outEndMs };
}

/**
 * Selecting a clip: where the playhead goes. It stays where it is when it is already inside the clip; otherwise it
 * moves to the clip's start. (Edited time.)
 */
export function playheadOnSelect(loop: ClipLoop, playheadMs: number): number {
  return playheadMs >= loop.outStartMs && playheadMs < loop.outEndMs ? playheadMs : loop.outStartMs;
}

export type LoopTick =
  | { kind: "play" }
  /** Jump back to the clip's start now (before its end, so nothing after it is shown). */
  | { kind: "wrap"; seekToSourceMs: number }
  /** The player is outside the clip: put it at the start. */
  | { kind: "resync"; seekToSourceMs: number };

export function loopTick(loop: ClipLoop, sourceMs: number, leadMs: number = CLIP_LOOP_LEAD_MS): LoopTick {
  if (sourceMs < loop.srcStartMs - CLIP_LOOP_SLACK_MS || sourceMs > loop.srcEndMs + CLIP_LOOP_SLACK_MS) return { kind: "resync", seekToSourceMs: loop.srcStartMs };
  const length = loop.srcEndMs - loop.srcStartMs;
  // a clip shorter than twice the lead loops at its end (the lead cannot be larger than half of it)
  const lead = Math.min(leadMs, Math.max(0, length / 2));
  if (sourceMs >= loop.srcEndMs - lead) return { kind: "wrap", seekToSourceMs: loop.srcStartMs };
  return { kind: "play" };
}

/**
 * After an edit (trimming the clip's edge, a split, a delete) the selected clip has a new id or none: the successor is the
 * new clip that overlaps the old one most (the one holding the playhead on a tie). -1 when nothing overlaps.
 */
export function selectionSuccessor(old: { srcStartMs: number; srcEndMs: number }, next: Array<{ srcStartMs: number; srcEndMs: number }>, playheadSourceMs?: number): number {
  let best = -1;
  let bestOverlap = 0;
  next.forEach((n, i) => {
    const overlap = Math.min(old.srcEndMs, n.srcEndMs) - Math.max(old.srcStartMs, n.srcStartMs);
    const holds = playheadSourceMs !== undefined && playheadSourceMs >= n.srcStartMs && playheadSourceMs < n.srcEndMs;
    if (overlap > bestOverlap + 1 || (Math.abs(overlap - bestOverlap) <= 1 && overlap > 0 && holds)) {
      best = i;
      bestOverlap = overlap;
    }
  });
  return best;
}

/** Tapping off: full-video playback continues from the same moment, playing or paused as it was. */
export function tapOff(state: { positionMs: number; isPlaying: boolean }): { positionMs: number; isPlaying: boolean; seek: false } {
  return { positionMs: state.positionMs, isPlaying: state.isPlaying, seek: false };
}
