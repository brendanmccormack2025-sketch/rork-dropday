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
 * silence cuts keep source order, so output order is source order). A word is kept only if it lies entirely inside the kept
 * footage, and its times are shifted onto the output timeline. Touching or
 * overlapping kept ranges count as one continuous stretch.
 *
 * A word that straddles a cut is DROPPED, not clamped. Silence cuts are placed in
 * silence, so a straddling word is a recognizer timing error or speech that was
 * really cut. A clamped caption would show a word whose audio is partly gone and
 * would flash for a few milliseconds; a dropped word is deterministic and never
 * shows text the viewer cannot hear.
 */
export function mapWordsToEdit(words: Word[], keptRanges: KeepRange[]): Word[] {
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

  const out: Word[] = [];
  for (const w of words) {
    const range = merged.find((r) => w.startMs >= r.startMs && w.endMs <= r.endMs);
    if (!range) continue;
    const shift = range.outputOffsetMs - range.startMs;
    out.push({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift });
  }
  return out;
}
