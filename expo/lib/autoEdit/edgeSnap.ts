/**
 * Snapping an edge that is being dragged to the places that matter: the starts and ends of spoken words and the
 * boundaries of the automatic silence cuts. The snap holds while the finger stays near; pausing for a moment, or
 * dragging past the threshold, lets go.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type TimedWord = { startMs: number; endMs: number };

/** How close (points) the edge must come to a target before it is pulled onto it. */
export const SNAP_PX = 10;
/** The threshold in time is this many points at the current zoom, but never below / above these. */
export const SNAP_MIN_MS = 6;
export const SNAP_MAX_MS = 150;
/** Holding still this long while snapped lets go of the snap. */
export const SNAP_PAUSE_MS = 350;
/** Movement smaller than this (points) counts as holding still. */
export const SNAP_JITTER_PX = 1.5;

/** Word starts, word ends and cut boundaries (source ms), sorted and without duplicates. */
export function buildSnapTargets(words: TimedWord[] | null | undefined, boundaries: number[] | null | undefined): number[] {
  const set = new Set<number>();
  for (const w of words ?? []) {
    if (Number.isFinite(w.startMs)) set.add(Math.round(w.startMs));
    if (Number.isFinite(w.endMs)) set.add(Math.round(w.endMs));
  }
  for (const b of boundaries ?? []) if (Number.isFinite(b)) set.add(Math.round(b));
  return [...set].sort((a, b) => a - b);
}

/** The snap threshold in ms at a zoom (scale = points per ms). */
export function snapThresholdMs(scale: number): number {
  const ms = SNAP_PX / Math.max(1e-6, scale);
  return Math.min(SNAP_MAX_MS, Math.max(SNAP_MIN_MS, ms));
}

/** The target nearest to `ms` within `thresholdMs`, or null; `skip` is ignored (a target just let go of). */
export function nearestTarget(targets: ArrayLike<number>, ms: number, thresholdMs: number, skip: number | null = null): number | null {
  const n = targets.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = Math.max(0, lo - 2); i <= Math.min(n - 1, lo + 1); i++) {
    const t = targets[i]!;
    if (skip !== null && t === skip) continue;
    const d = Math.abs(t - ms);
    if (d <= thresholdMs && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export type SnapState = {
  /** The target the edge is held on, or null. */
  target: number | null;
  /** A target the creator let go of (pause): not caught again until the edge has left its zone. */
  released: number | null;
  /** The last raw position that counted as movement, and when. */
  anchorMs: number;
  movedAt: number;
};

export function snapStart(rawMs: number, now: number): SnapState {
  return { target: null, released: null, anchorMs: rawMs, movedAt: now };
}

export type SnapParams = { thresholdMs: number; pauseMs: number; jitterMs: number };

export function snapParams(scale: number): SnapParams {
  return { thresholdMs: snapThresholdMs(scale), pauseMs: SNAP_PAUSE_MS, jitterMs: SNAP_JITTER_PX / Math.max(1e-6, scale) };
}

/**
 * One step: where the edge really is (`ms`), the new state, and whether it just caught a target (`caught`: the moment
 * for a light haptic). Call it on every touch move and on every frame while the finger is down (so a pause is seen
 * even when no move events arrive).
 */
export function snapStep(
  state: SnapState,
  rawMs: number,
  now: number,
  targets: ArrayLike<number>,
  p: SnapParams,
): { ms: number; state: SnapState; caught: boolean } {
  let { target, released, anchorMs, movedAt } = state;
  if (Math.abs(rawMs - anchorMs) > p.jitterMs) {
    anchorMs = rawMs;
    movedAt = now;
  }
  if (released !== null && Math.abs(rawMs - released) > p.thresholdMs) released = null;
  if (target !== null) {
    if (Math.abs(rawMs - target) > p.thresholdMs) {
      target = null;   // dragged past the threshold
    } else if (now - movedAt >= p.pauseMs) {
      released = target;   // held still: let go, so the edge can be placed exactly where the finger is
      target = null;
    }
  }
  let caught = false;
  if (target === null) {
    const found = nearestTarget(targets, rawMs, p.thresholdMs, released);
    if (found !== null) {
      target = found;
      caught = true;
      movedAt = now;
      anchorMs = rawMs;
    }
  }
  return { ms: target !== null ? target : rawMs, state: { target, released, anchorMs, movedAt }, caught };
}
