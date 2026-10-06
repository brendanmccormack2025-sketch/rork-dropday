/**
 * Timeline sanity check for the debug view: do the transcript words lie on sound?
 * Words and loudness windows must both be SOURCE time. If only a small share of the
 * word time is above the silence threshold at shift 0, but a shift of a few hundred
 * ms raises it a lot, the transcript timestamps are offset from the audio.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";

export type Alignment = {
  wordCount: number;
  firstWordMs: number;
  lastWordMs: number;
  loudnessMs: number;
  /** Share (0-1) of the word time that is above the silence threshold, as is. */
  shareAtZero: number;
  /** The shift (ms, positive = loudness is later than the words) with the best share. */
  bestShiftMs: number;
  bestShare: number;
};

export function checkAlignment(
  windows: number[],
  windowMs: number,
  words: Word[],
  thresholdDb: number,
  maxShiftMs = 2000,
  stepMs = 100,
): Alignment | null {
  const indexes: number[] = [];
  for (const w of words) {
    const from = Math.max(0, Math.floor(w.startMs / windowMs));
    const to = Math.min(windows.length, Math.ceil(w.endMs / windowMs));
    for (let i = from; i < to; i++) indexes.push(i);
  }
  if (indexes.length === 0) return null;
  const shareAt = (shiftMs: number): number => {
    const shift = Math.round(shiftMs / windowMs);
    let on = 0;
    for (const i of indexes) {
      const v = windows[i + shift];
      if (v !== undefined && Number.isFinite(v) && v > thresholdDb) on++;
    }
    return on / indexes.length;
  };
  const zero = shareAt(0);
  let bestShift = 0;
  let best = zero;
  for (let shift = -maxShiftMs; shift <= maxShiftMs; shift += stepMs) {
    const share = shareAt(shift);
    if (share > best + 1e-9) {
      best = share;
      bestShift = shift;
    }
  }
  return {
    wordCount: words.length,
    firstWordMs: Math.min(...words.map((w) => w.startMs)),
    lastWordMs: Math.max(...words.map((w) => w.endMs)),
    loudnessMs: windows.length * windowMs,
    shareAtZero: zero,
    bestShiftMs: bestShift,
    bestShare: best,
  };
}
