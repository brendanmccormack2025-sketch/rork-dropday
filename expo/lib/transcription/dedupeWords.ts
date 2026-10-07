/**
 * Clean a transcript of words the recognizer delivered twice.
 *
 * On-device recognition restarts after pauses and can re-deliver earlier words, which
 * then land later in time (a repeated opening phrase at the end of the clip) or on top
 * of the real words (two overlapping captions). Two passes:
 *  1. A run of at least MIN_REPEAT_WORDS (5) consecutive words whose text exactly
 *     matches an earlier run, with near-identical timing (each gap between words within
 *     REPEAT_GAP_TOLERANCE_MS of the other copy's), is a repeat. The copy whose times
 *     best land on non-silent audio is kept (the earlier one on a tie), the other is
 *     dropped, UNLESS the dropped copy sits on speech-level audio with no other word
 *     covering it: that is a real repeated phrase ("I don't know" twice), and both
 *     copies stay. Without loudness data nothing is verified, so nothing is dropped.
 *     Every decision, kept or removed, is reported.
 *  2. Words that overlap in time by more than half of the shorter word are one word
 *     heard twice: the higher-confidence one is kept.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { detectSilences } from "../silenceDetection.ts";
import type { DedupeDecision, Word } from "./types.ts";

export const MIN_REPEAT_WORDS = 5;
/** Runs of at least this many matching words are reported (as kept when they fail a rule). */
export const MIN_REPORTED_RUN = 3;
export const REPEAT_GAP_TOLERANCE_MS = 60;
/** A removed copy on at least this share of speech-level audio, with no other word over it, is real speech. */
export const REPEAT_SPEECH_SHARE = 0.5;
export const OVERLAP_SHARE = 0.5;

export type DedupeLoudness = { durationMs: number; windows: number[] };
export type DedupeReport = {
  repeatedWords: number;
  overlappingWords: number;
  /** The dropped words (source times). */
  words: Word[];
  decisions: DedupeDecision[];
};

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

const pct = (x: number) => `${Math.round(100 * x)}%`;
const sec = (ms: number) => (ms / 1000).toFixed(1);

/** Whether the later run is a restart artifact of the earlier one, and which copy goes. */
function judgeRepeat(
  earlier: Word[],
  later: Word[],
  others: Word[],
  loud: DedupeLoudness | null,
): { remove: "earlier" | "later" | null; reason: string } {
  const k = earlier.length;
  if (k < MIN_REPEAT_WORDS) return { remove: null, reason: `a run of ${k} words (a repeat needs at least ${MIN_REPEAT_WORDS}): kept both` };
  for (let t = 0; t + 1 < k; t++) {
    const gapE = earlier[t + 1]!.startMs - earlier[t]!.endMs;
    const gapL = later[t + 1]!.startMs - later[t]!.endMs;
    if (Math.abs(gapE - gapL) > REPEAT_GAP_TOLERANCE_MS) {
      return { remove: null, reason: `timing differs (gap after word ${t + 1}: ${Math.round(gapE)} ms vs ${Math.round(gapL)} ms; allowed ${REPEAT_GAP_TOLERANCE_MS}): a real repeat, kept both` };
    }
  }
  if (!loud) return { remove: null, reason: "no loudness data to verify it: kept both" };
  const eShare = runShare(loud, earlier);
  const lShare = runShare(loud, later);
  const drop = lShare <= eShare ? later : earlier;
  const dropShare = drop === later ? lShare : eShare;
  const from = drop[0]!.startMs;
  const to = drop[k - 1]!.endMs;
  const covered = others.some((w) => !drop.includes(w) && w.startMs < to && w.endMs > from);
  if (dropShare >= REPEAT_SPEECH_SHARE && !covered) {
    return { remove: null, reason: `the copy at ${sec(from)} s is ${pct(dropShare)} on speech-level audio with no other word over it: a real repeated phrase, kept both` };
  }
  return {
    remove: drop === later ? "later" : "earlier",
    reason: `restart artifact: same timing; the copy at ${sec(from)} s is ${pct(dropShare)} on sound${covered ? " and other words cover it" : ""} (the other copy ${pct(drop === later ? eShare : lShare)})`,
  };
}

export function dedupeWords(
  input: Word[],
  loud: DedupeLoudness | null,
): { words: Word[]; report: DedupeReport } {
  let words = [...input].sort((a, b) => a.startMs - b.startMs);
  const report: DedupeReport = { repeatedWords: 0, overlappingWords: 0, words: [], decisions: [] };
  const seen = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    const keys = words.map(norm);
    for (let j = MIN_REPORTED_RUN; j < words.length; j++) {
      const { i, k } = longestMatch(keys, j);
      if (k < MIN_REPORTED_RUN) continue;
      const earlier = words.slice(i, i + k);
      const later = words.slice(j, j + k);
      const verdict = judgeRepeat(earlier, later, words, loud);
      const key = `${earlier[0]!.startMs}|${later[0]!.startMs}|${k}`;
      if (!seen.has(key)) {
        seen.add(key);
        report.decisions.push({
          outcome: verdict.remove ? "removed" : "kept",
          text: later.map((x) => x.text).join(" "),
          wordCount: k,
          earlierStartMs: earlier[0]!.startMs,
          laterStartMs: later[0]!.startMs,
          reason: verdict.reason,
        });
      }
      if (verdict.remove) {
        const dropFrom = verdict.remove === "later" ? j : i;
        report.words.push(...words.slice(dropFrom, dropFrom + k));
        words = [...words.slice(0, dropFrom), ...words.slice(dropFrom + k)];
        report.repeatedWords += k;
        changed = true;
        break;
      }
      j += k - 1;
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
        if ((w.confidence ?? 0) > (prev.confidence ?? 0)) {
          report.words.push(prev);
          kept[kept.length - 1] = w;
        } else {
          report.words.push(w);
        }
        continue;
      }
    }
    kept.push(w);
  }
  report.decisions.sort((a, b) => a.laterStartMs - b.laterStartMs);
  return { words: kept, report };
}
