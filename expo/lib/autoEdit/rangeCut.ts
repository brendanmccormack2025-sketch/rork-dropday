/**
 * Cut a range inside a kept clip (long-press and drag across the waveform), and the cut chips on the Cuts timeline.
 *
 * A cut here is the creator's own cut decision (addManualCut, like "Delete this part"): it splits the clip, is
 * reversible (Restore / undo / Reset to AI edit) and every caption, text and the cut count follow because the whole
 * edit is the decision state.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { addManualCut, keepRangesOf, type EditState } from "./decisions.ts";
import type { TimelineMarker } from "./markers.ts";
import { MIN_KEEP_MS } from "./reshape.ts";

type Range = { startMs: number; endMs: number };

/** The smallest range that can be cut (finger jitter and accidental taps are not cuts). */
export const RANGE_MIN_MS = 100;

/** A clip on the output timeline: where it starts there and the source time it starts at. */
export type RangeClip = { outStartMs: number; durMs: number; srcStartMs: number };

/**
 * The range a drag from `anchorOutMs` to `currentOutMs` selects: sorted and kept inside the clip the drag started in
 * (the finger may go beyond it; the range stops at the clip's edge). Output time.
 */
export function selectRange(anchorOutMs: number, currentOutMs: number, clip: Pick<RangeClip, "outStartMs" | "durMs">): Range {
  const lo = clip.outStartMs;
  const hi = clip.outStartMs + clip.durMs;
  const a = Math.min(hi, Math.max(lo, anchorOutMs));
  const b = Math.min(hi, Math.max(lo, currentOutMs));
  return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
}

/** An output-time range inside a clip as source time. */
export function outputRangeToSource(range: Range, clip: RangeClip): Range {
  return { startMs: clip.srcStartMs + (range.startMs - clip.outStartMs), endMs: clip.srcStartMs + (range.endMs - clip.outStartMs) };
}

/** A source range as output ranges, one per kept clip it overlaps (for drawing a hint or a selection). */
export function sourceRangeToOutput(range: Range, clips: RangeClip[]): Range[] {
  const out: Range[] = [];
  for (const c of clips) {
    const s = Math.max(range.startMs, c.srcStartMs);
    const e = Math.min(range.endMs, c.srcStartMs + c.durMs);
    if (e > s) out.push({ startMs: c.outStartMs + (s - c.srcStartMs), endMs: c.outStartMs + (e - c.srcStartMs) });
  }
  return out;
}

export type RangeCutPlan =
  | { kind: "none"; reason: "too-short" | "no-footage" | "everything" }
  | { kind: "cut"; range: Range; next: EditState };

/**
 * Cut a source range. It is held inside the kept footage it falls in (a range over already-cut footage cuts only the
 * kept part); a sliver of footage that would be left at either end of that footage (under the smallest keepable piece)
 * is cut with it, so no unusable fragment remains. Under RANGE_MIN_MS nothing is cut; neither is everything.
 */
export function planRangeCut(state: EditState, startMs: number, endMs: number, durationMs: number): RangeCutPlan {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  if (!(hi - lo >= RANGE_MIN_MS)) return { kind: "none", reason: "too-short" };
  const keep = keepRangesOf(state, durationMs);
  // the kept footage that holds most of the range
  let best: Range | null = null;
  let bestOverlap = 0;
  for (const k of keep) {
    const o = Math.min(hi, k.endMs) - Math.max(lo, k.startMs);
    if (o > bestOverlap) {
      bestOverlap = o;
      best = k;
    }
  }
  if (!best || bestOverlap < RANGE_MIN_MS) return { kind: "none", reason: bestOverlap > 0 ? "too-short" : "no-footage" };
  let s = Math.max(lo, best.startMs);
  let e = Math.min(hi, best.endMs);
  if (s - best.startMs < MIN_KEEP_MS) s = best.startMs;
  if (best.endMs - e < MIN_KEEP_MS) e = best.endMs;
  const next = addManualCut(state, s, e);
  if (keepRangesOf(next, durationMs).length === 0) return { kind: "none", reason: "everything" };
  return { kind: "cut", range: { startMs: s, endMs: e }, next };
}

/** The text of a cut chip's inline bar: "Silence 1.2s", "Cut 0.8s", or "3 cuts · 2.4s" for cuts sharing a seam. */
export function chipLabel(marker: Pick<TimelineMarker, "items">): string {
  const items = marker.items;
  if (items.length === 0) return "Cut";
  if (items.length === 1) return items[0]!.label;
  const total = items.reduce((sum, i) => sum + i.lengthMs, 0);
  return `${items.length} cuts · ${(Math.round(total / 100) / 10).toFixed(1)}s`;
}
