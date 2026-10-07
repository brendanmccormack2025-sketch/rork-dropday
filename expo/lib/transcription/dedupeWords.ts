/**
 * Clean a transcript of words the recognizer delivered twice.
 *
 * On-device recognition restarts after pauses and can re-deliver earlier words, which
 * then land later in time (a repeated opening phrase at the end of the clip) or on top
 * of the real words (two overlapping captions). Two passes:
 *  1. A run of at least MIN_REPEAT_WORDS consecutive words whose text exactly matches
 *     an earlier run is a repeat: the copy whose times best land on non-silent audio
 *     is kept (the earlier one on a tie), the other is dropped.
 *  2. Words that overlap in time by more than half of the shorter word are one word
 *     heard twice: the higher-confidence one is kept.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { detectSilences } from "../silenceDetection.ts";
import type { Word } from "./types.ts";

export const MIN_REPEAT_WORDS = 3;
export const OVERLAP_SHARE = 0.5;

export type DedupeLoudness = { durationMs: number; windows: number[] };
export type DedupeReport = { repeatedWords: number; overlappingWords: number };

const norm = (w: Word) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Share (0..1) of [startMs, endMs) that lies on non-silent audio; 0.5 without loudness data. */
export function soundShare(loud: DedupeLoudness | null, startMs: number, endMs: number): number {
  if (!loud || loud.windows.length === 0 || endMs <= startMs) return 0.5;
  const windowMs = loud.durationMs / loud.windows.length;
  const threshold = detectSilences(loud.windows, windowMs, { durationMs: loud.durationMs }).thresholdDb;
  let sound = 0;
  let total = 0;
  const first = Math.max(0, Math.floor(startMs / windowMs));
  const last = Math.min(loud.windows.length - 1, Math.floor((endMs - 1) / windowMs));
  for (let i = first; i <= last; i++) {
    const from = Math.max(startMs, i * windowMs);
    const to = Math.min(endMs, (i + 1) * windowMs);
    if (to <= from) continue;
    total += to - from;
    if (Number.isFinite(loud.windows[i]!) && loud.windows[i]! > threshold) sound += to - from;
  }
  return total > 0 ? sound / total : 0.5;
}

function runShare(loud: DedupeLoudness | null, run: Word[]): number {
  let sound = 0;
  let total = 0;
  for (const w of run) {
    const d = Math.max(1, w.endMs - w.startMs);
    sound += soundShare(loud, w.startMs, w.startMs + d) * d;
    total += d;
  }
  return total > 0 ? sound / total : 0;
}

/** Index of the longest earlier run (ending before j) that matches the words from j, or -1. */
function longestMatch(keys: string[], j: number): { i: number; k: number } {
  let best = { i: -1, k: 0 };
  for (let i = 0; i < j; i++) {
    let k = 0;
    while (i + k < j && j + k < keys.length && keys[i + k] !== "" && keys[i + k] === keys[j + k]) k++;
    if (k > best.k) best = { i, k };
  }
  return best;
}

export function dedupeWords(
  input: Word[],
  loud: DedupeLoudness | null,
): { words: Word[]; report: DedupeReport } {
  let words = [...input].sort((a, b) => a.startMs - b.startMs);
  const report: DedupeReport = { repeatedWords: 0, overlappingWords: 0 };

  let changed = true;
  while (changed) {
    changed = false;
    const keys = words.map(norm);
    for (let j = MIN_REPEAT_WORDS; j < words.length; j++) {
      const { i, k } = longestMatch(keys, j);
      if (k < MIN_REPEAT_WORDS) continue;
      const earlier = words.slice(i, i + k);
      const later = words.slice(j, j + k);
      const dropLater = runShare(loud, later) <= runShare(loud, earlier);
      const dropFrom = dropLater ? j : i;
      words = [...words.slice(0, dropFrom), ...words.slice(dropFrom + k)];
      report.repeatedWords += k;
      changed = true;
      break;
    }
  }

  const kept: Word[] = [];
  for (const w of words) {
    const prev = kept[kept.length - 1];
    if (prev) {
      const overlap = Math.min(prev.endMs, w.endMs) - Math.max(prev.startMs, w.startMs);
      const shorter = Math.max(1, Math.min(prev.endMs - prev.startMs, w.endMs - w.startMs));
      if (overlap > shorter * OVERLAP_SHARE) {
        report.overlappingWords++;
        if ((w.confidence ?? 0) > (prev.confidence ?? 0)) kept[kept.length - 1] = w;
        continue;
      }
    }
    kept.push(w);
  }
  return { words: kept, report };
}
