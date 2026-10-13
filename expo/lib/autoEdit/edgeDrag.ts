/**
 * Dragging a clip edge on the Cuts timeline, frame-precise: what the creator sees at the moment of release is what is
 * committed.
 *
 *  - The edge moves RELATIVE to where the finger went down (the horizontal distance travelled, in time at the current
 *    zoom), so there is no jump on grab and the slop before the gesture starts is not lost.
 *  - The position is clamped to what the edge can do, snapped only within a few points on screen (never across a word,
 *    never more than SNAP_MAX_MS), rounded to the nearest frame, and passed through `land` (the position the edit will
 *    really give that drag: the same function the commit uses), so the shown position, the preview frame and the
 *    committed position are one value.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { snapStart, snapStep, type SnapParams, type SnapState } from "./edgeSnap.ts";
import { frameMsOf } from "./timelineView.ts";

export type EdgeSession = {
  /** Where the edge was (source ms) when the drag began. */
  atMs: number;
  /** The finger's x (points, in the timeline) when it went down, and the timeline's scroll at that moment. */
  startX: number;
  offsetStart: number;
  /** How far the edge can go (source ms). */
  min: number;
  max: number;
  fps: number;
  snap: SnapState;
  /** The position shown (and committed) now. */
  ms: number;
};

/** The nearest video frame (the frame grid starts at 0). */
export function roundToFrame(ms: number, fps: number | null | undefined): number {
  const frame = frameMsOf(fps);
  // whole microseconds: the same number is shown, previewed and committed
  return Math.round((Math.round(ms / frame) * frame) * 1000) / 1000;
}

export function startEdgeSession(args: { atMs: number; startX: number; offsetStart: number; min: number; max: number; fps: number | null | undefined; now: number }): EdgeSession {
  return {
    atMs: args.atMs,
    startX: args.startX,
    offsetStart: args.offsetStart,
    min: Math.min(args.min, args.max, args.atMs),
    max: Math.max(args.min, args.max, args.atMs),
    fps: args.fps && args.fps > 0 ? args.fps : 30,
    snap: snapStart(args.atMs, args.now),
    ms: args.atMs,
  };
}

/** The unsnapped position for a finger at `x` with the timeline scrolled to `offset`. */
export function rawEdgeMs(s: EdgeSession, x: number, offset: number, scale: number): number {
  return s.atMs + (x - s.startX + (offset - s.offsetStart)) / Math.max(1e-9, scale);
}

/**
 * One move (or the release: call it once more with the last finger position). Returns the new position and whether it
 * just caught a snap target (a light haptic). The session is updated.
 */
export function moveEdge(
  s: EdgeSession,
  input: { x: number; offset: number; scale: number; now: number; targets: ArrayLike<number>; params: SnapParams; land?: (ms: number) => number },
): { ms: number; caught: boolean } {
  const clamp = (v: number) => Math.min(s.max, Math.max(s.min, v));
  const raw = clamp(rawEdgeMs(s, input.x, input.offset, input.scale));
  const snapped = snapStep(s.snap, raw, input.now, input.targets, input.params);
  s.snap = snapped.state;
  // the nearest frame, then what the edit will really give a drag to there. Until the finger has moved half a frame
  // the edge stays exactly where it is (no jump on grab).
  const half = frameMsOf(s.fps) / 2;
  let ms = Math.abs(snapped.ms - s.atMs) < half && snapped.state.target === null ? s.atMs : clamp(roundToFrame(snapped.ms, s.fps));
  if (input.land) ms = clamp(input.land(ms));
  s.ms = ms;
  return { ms, caught: snapped.caught };
}
