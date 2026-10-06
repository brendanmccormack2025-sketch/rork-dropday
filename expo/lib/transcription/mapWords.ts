/**
 * Words on the source recording -> words on the edited (output) timeline.
 *
 * Pure: no React, no native modules. Erasable TypeScript only so
 * scripts/test-transcription.mjs can run it with Node's type stripping.
 */
import type { KeepRange } from "../editModel.ts";
import type { Word } from "./types.ts";

/**
 * keptRanges are the parts of the source that survive the edit (ms on the source;
 * silence cuts keep source order, so output order is source order). Touching or
 * overlapping kept ranges count as one continuous stretch. Words are shifted onto
 * the output timeline; any other fields on a word are kept.
 *
 * A word that straddles a cut is kept when at least 50% of its duration lies in one
 * kept range, and is then clamped to that range's edges; otherwise it is dropped.
 * Cuts are tight and recognizer word edges are imprecise, so dropping every
 * straddler would lose the first and last word of segments. A word that is mostly
 * cut away is dropped: its audio is mostly gone.
 */
export function mapWordsToEdit<T extends Word>(words: T[], keptRanges: KeepRange[]): T[] {
  const sorted = keptRanges
    .filter((r) => r.endMs > r.startMs)
    .map((r) => ({ startMs: r.startMs, endMs: r.endMs }))
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Array<{ startMs: number; endMs: number; outputOffsetMs: number }> = [];
  let outputOffsetMs = 0;
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs) {
      if (r.endMs > last.endMs) {
        outputOffsetMs += r.endMs - last.endMs;
        last.endMs = r.endMs;
      }
      continue;
    }
    merged.push({ ...r, outputOffsetMs });
    outputOffsetMs += r.endMs - r.startMs;
  }

  const out: T[] = [];
  for (const w of words) {
    const duration = w.endMs - w.startMs;
    let best: (typeof merged)[number] | null = null;
    let bestOverlap = -1;
    for (const r of merged) {
      const overlap = Math.min(w.endMs, r.endMs) - Math.max(w.startMs, r.startMs);
      if (overlap > bestOverlap) {
        best = r;
        bestOverlap = overlap;
      }
    }
    if (!best) continue;
    const keep =
      duration > 0 ? bestOverlap >= duration * 0.5 : w.startMs >= best.startMs && w.startMs <= best.endMs;
    if (!keep) continue;
    const shift = best.outputOffsetMs - best.startMs;
    const startMs = Math.max(w.startMs, best.startMs) + shift;
    const endMs = Math.min(Math.max(w.endMs, w.startMs), best.endMs) + shift;
    out.push({ ...w, startMs, endMs: Math.max(endMs, startMs) });
  }
  return out;
}
