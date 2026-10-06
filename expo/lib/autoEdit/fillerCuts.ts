/**
 * Filler cuts.
 *  Method 1: transcript words um/uh/er/ah/hmm become applied fillerCut decisions
 *            (reversible one by one).
 *  Method 2: stretches of 150-800 ms where the loudness shows sound but no
 *            transcript word explains it. Only reported (logged), never applied.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import { makeDecision, type Decision } from "./decisions.ts";

const FILLER = /^(u+m+|u+h+|u+hm+|e+r+m*|a+h+|h+m+)$/;

export function isFillerWord(text: string): boolean {
  return FILLER.test(text.toLowerCase().replace(/[^a-z]/g, ""));
}

export function planFillerCuts(words: Word[]): Decision[] {
  return words
    .filter((w) => isFillerWord(w.text) && w.endMs > w.startMs)
    .map((w) => makeDecision("fillerCut", w.startMs, w.endMs, { payload: { text: w.text } }));
}

export const UNEXPLAINED_MIN_MS = 150;
export const UNEXPLAINED_MAX_MS = 800;
/** Word timings are imprecise: a sound this close to a word still belongs to it. */
export const WORD_SLACK_MS = 120;

export type UnexplainedSound = { startMs: number; endMs: number; lengthMs: number };

/** Method 2 (log only): loud windows above thresholdDb with no transcript word near them. */
export function findUnexplainedSounds(
  windows: number[],
  windowMs: number,
  words: Word[],
  thresholdDb: number,
): UnexplainedSound[] {
  const out: UnexplainedSound[] = [];
  const explained = (startMs: number, endMs: number) =>
    words.some((w) => w.startMs - WORD_SLACK_MS < endMs && w.endMs + WORD_SLACK_MS > startMs);
  let run = -1;
  for (let i = 0; i <= windows.length; i++) {
    const loud = i < windows.length && Number.isFinite(windows[i]!) && windows[i]! > thresholdDb;
    if (loud && run < 0) run = i;
    if (!loud && run >= 0) {
      const startMs = run * windowMs;
      const endMs = i * windowMs;
      const lengthMs = endMs - startMs;
      if (lengthMs >= UNEXPLAINED_MIN_MS && lengthMs <= UNEXPLAINED_MAX_MS && !explained(startMs, endMs)) {
        out.push({ startMs, endMs, lengthMs });
      }
      run = -1;
    }
  }
  return out;
}
