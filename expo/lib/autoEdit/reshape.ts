/**
 * Drag a clip edge to recover (or give up) footage: the edit decision for "I want to see a bit more here".
 *
 * An edge is the left or right end of a kept clip. Dragging it outward shrinks the cut next to it (the footage
 * comes back); dragging it inward cuts more. The result is always a new EditState, never a trim of the timeline,
 * so everything the decisions know (re-planning, sensitivity changes, undo, captions, text overlays) stays right:
 *
 *  - A cut that is shrunk is replaced by what is left of it, owned by the creator (it survives a re-plan), plus a
 *    reverted decision over the footage that came back. Like every reverted decision it is a tombstone: mergePlan
 *    never cuts that footage again.
 *  - Footage is never duplicated: the kept footage is the complement of the cuts, so no edit can play it twice.
 *  - Nothing shorter than the smallest cut piece (LAUGH_PROTECT_CONFIG.minCutMs) is left behind: a sliver that
 *    would remain snaps to fully restored, and a cut shorter than that is not made.
 *  - A laugh's protection is kept for the parts of a cut that were not touched.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import {
  LAUGH_PROTECT_CONFIG,
  addManualCut,
  dedupe,
  effectivePieces,
  isActiveCut,
  isCutType,
  keepRangesOf,
  makeDecision,
  protectedRangesOf,
  sortDecisions,
  type Decision,
  type EditState,
} from "./decisions.ts";

export type SeamEdge = {
  /** "left" is the start of a kept clip (the end of the cut before it), "right" is the end of a kept clip. */
  side: "left" | "right";
  /** Where the edge is now, in source milliseconds. */
  atMs: number;
};

type Range = { startMs: number; endMs: number };

/** A drag shorter than this changes nothing (finger jitter). */
export const MIN_DRAG_MS = 40;
/** How close a given edge must be to a kept clip's end to count as that edge. */
const EDGE_TOLERANCE_MS = 25;
/** A kept clip never gets shorter than this by dragging its edge inward. */
export const MIN_KEEP_MS = LAUGH_PROTECT_CONFIG.minCutMs;

export type EdgeDrag =
  | { kind: "none"; edgeMs: number; clampedMs: number }
  | { kind: "reveal"; edgeMs: number; clampedMs: number; range: Range }
  | { kind: "cut"; edgeMs: number; clampedMs: number; range: Range };

/** The kept clip that owns an edge, or null when no kept clip ends there. */
function clipOfEdge(state: EditState, edge: SeamEdge, durationMs: number): Range | null {
  const keep = keepRangesOf(state, durationMs);
  const near = (k: Range) => Math.abs((edge.side === "left" ? k.startMs : k.endMs) - edge.atMs) <= EDGE_TOLERANCE_MS;
  const found = keep.filter(near);
  if (found.length === 0) return null;
  return found.reduce((best, k) => {
    const d = Math.abs((edge.side === "left" ? k.startMs : k.endMs) - edge.atMs);
    const bd = Math.abs((edge.side === "left" ? best.startMs : best.endMs) - edge.atMs);
    return d < bd ? k : best;
  });
}

/**
 * Where a drag of `edge` to `newSourceMs` lands and what it would do: the clamped position (the edge cannot cross
 * its own clip or leave the video) and the source range that comes back (reveal) or goes (cut).
 */
export function describeEdgeDrag(state: EditState, edge: SeamEdge, newSourceMs: number, durationMs: number): EdgeDrag {
  const clip = clipOfEdge(state, edge, durationMs);
  if (!clip || !(durationMs > 0) || !Number.isFinite(newSourceMs)) return { kind: "none", edgeMs: edge.atMs, clampedMs: edge.atMs };
  const edgeMs = edge.side === "left" ? clip.startMs : clip.endMs;
  const clampedMs =
    edge.side === "left"
      ? Math.min(Math.max(0, newSourceMs), Math.max(edgeMs, clip.endMs - MIN_KEEP_MS))
      : Math.max(Math.min(durationMs, newSourceMs), Math.min(edgeMs, clip.startMs + MIN_KEEP_MS));
  const moved = clampedMs - edgeMs;
  if (Math.abs(moved) < MIN_DRAG_MS) return { kind: "none", edgeMs, clampedMs: edgeMs };
  const outward = edge.side === "left" ? moved < 0 : moved > 0;
  const range = { startMs: Math.min(edgeMs, clampedMs), endMs: Math.max(edgeMs, clampedMs) };
  return { kind: outward ? "reveal" : "cut", edgeMs, clampedMs, range };
}

/** What is left of `r` once `hole` is taken out (zero, one or two ranges). */
function subtract(r: Range, hole: Range): Range[] {
  if (hole.endMs <= r.startMs || hole.startMs >= r.endMs) return [r];
  const out: Range[] = [];
  if (hole.startMs > r.startMs) out.push({ startMs: r.startMs, endMs: hole.startMs });
  if (hole.endMs < r.endMs) out.push({ startMs: hole.endMs, endMs: r.endMs });
  return out;
}

const overlaps = (a: Range, b: Range) => a.startMs < b.endMs && a.endMs > b.startMs;

/** Give the footage of `hole` back: shrink, split or drop every active cut that covers it. */
function revealRange(state: EditState, hole: Range): EditState {
  const prot = protectedRangesOf(state);
  const out: Decision[] = [];
  for (const d of state.decisions) {
    if (!isActiveCut(state, d)) {
      out.push(d);
      continue;
    }
    const pieces = effectivePieces({ startMs: d.sourceStartMs, endMs: d.sourceEndMs }, d.origin === "user" ? [] : prot);
    if (!pieces.some((p) => overlaps(p, hole))) {
      out.push(d);
      continue;
    }
    // The footage that comes back, and any sliver too small to leave behind next to it.
    let tombStart = Math.max(d.sourceStartMs, hole.startMs);
    let tombEnd = Math.min(d.sourceEndMs, hole.endMs);
    for (const p of pieces) {
      const touched = overlaps(p, hole);
      for (const rest of touched ? subtract(p, hole) : [p]) {
        if (touched && rest.endMs - rest.startMs < MIN_KEEP_MS) {
          tombStart = Math.min(tombStart, rest.startMs);
          tombEnd = Math.max(tombEnd, rest.endMs);
        } else {
          out.push(
            makeDecision(d.type, rest.startMs, rest.endMs, {
              ...(d.payload !== undefined ? { payload: d.payload } : {}),
              origin: touched ? "user" : d.origin,
            }),
          );
        }
      }
    }
    out.push(makeDecision(d.type, tombStart, tombEnd, { origin: "user", state: "reverted" }));
  }
  return { ...state, decisions: sortDecisions(dedupe(out)) };
}

/**
 * The decision for dragging `edge` to `newSourceMs`:
 *  - outward: the cut next to the edge shrinks (and, if the drag goes on, the next cut too) — see revealRange;
 *  - inward: the creator cuts that footage (addManualCut, like "Delete this part");
 *  - the first clip's left edge and the last clip's right edge are the start and end trim, the same way.
 * Returns the state unchanged for a tiny drag or an edge no kept clip owns.
 */
export function reshapeCutAtEdge(state: EditState, edge: SeamEdge, newSourceMs: number, durationMs: number): EditState {
  const drag = describeEdgeDrag(state, edge, newSourceMs, durationMs);
  if (drag.kind === "none") return state;
  if (drag.kind === "cut") return addManualCut(state, drag.range.startMs, drag.range.endMs);
  return revealRange(state, drag.range);
}

/**
 * The places the automatic edit put its cut boundaries (every cut it ever proposed, applied or not): dragging an
 * edge across one is the moment for a light haptic.
 */
export function aiBoundariesOf(state: EditState): number[] {
  const set = new Set<number>();
  for (const d of state.decisions) {
    if (d.origin !== "ai" || !isCutType(d.type)) continue;
    set.add(d.sourceStartMs);
    set.add(d.sourceEndMs);
  }
  return [...set].sort((a, b) => a - b);
}

/** Whether moving from `fromMs` to `toMs` passes (or lands on) one of the boundaries. */
export function crossedBoundary(boundaries: number[], fromMs: number, toMs: number): boolean {
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  if (lo === hi) return false;
  return boundaries.some((b) => b > lo && b <= hi);
}
