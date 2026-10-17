/**
 * Word guard: the automatic pause cuts never eat into a spoken word.
 *
 * Pause removal runs first, from loudness alone, so a quiet word ending ("-s", "-ing", a soft last syllable) or a
 * soft start can look like silence and get clipped. Once the transcript arrives, its word timings show where speech
 * really is: every automatic silence cut is pulled back so it starts at least PAD_AFTER_MS after the word before it
 * and ends at least PAD_BEFORE_MS before the word after it. A word lying inside a cut splits it in two (each side
 * keeps its own pause). Pieces shorter than MIN_CUT_MS are dropped: a pause that short is no longer worth a jump.
 * Cuts the creator made by hand, and every other kind of cut, are left exactly as they are.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { makeDecision, type Decision, type EditState } from "./decisions.ts";

/** Kept after a word ends (its tail decays slowly), before the cut starts. */
export const WORD_PAD_AFTER_MS = 90;
/** Kept before a word starts (soft onsets, a breath in), after the cut ends. */
export const WORD_PAD_BEFORE_MS = 60;
/** A cut piece shorter than this is dropped. */
export const WORD_GUARD_MIN_CUT_MS = 150;

type Range = { startMs: number; endMs: number };
export type GuardWord = { startMs: number; endMs: number };

export type WordGuardResult = { state: EditState; shortened: number; split: number; dropped: number };

/** What is left of one cut range once the padded words are taken out of it. */
export function cutPiecesAroundWords(
  cut: Range,
  words: GuardWord[],
  padAfterMs = WORD_PAD_AFTER_MS,
  padBeforeMs = WORD_PAD_BEFORE_MS,
  minCutMs = WORD_GUARD_MIN_CUT_MS,
): Range[] {
  const blocked = words
    .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs)
    .map((w) => ({ startMs: w.startMs - padBeforeMs, endMs: w.endMs + padAfterMs }))
    .filter((b) => b.startMs < cut.endMs && b.endMs > cut.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (blocked.length === 0) return [cut];
  const pieces: Range[] = [];
  let cursor = cut.startMs;
  for (const b of blocked) {
    if (b.endMs <= cursor) continue;
    if (b.startMs > cursor) pieces.push({ startMs: cursor, endMs: Math.min(b.startMs, cut.endMs) });
    cursor = Math.max(cursor, b.endMs);
    if (cursor >= cut.endMs) break;
  }
  if (cursor < cut.endMs) pieces.push({ startMs: cursor, endMs: cut.endMs });
  return pieces.filter((p) => p.endMs - p.startMs >= minCutMs);
}

/** The edit state with every automatic silence cut kept clear of the words. Unchanged state when nothing touched a word. */
export function guardSilenceCutsAgainstWords(state: EditState, words: GuardWord[]): WordGuardResult {
  let shortened = 0;
  let split = 0;
  let dropped = 0;
  const out: Decision[] = [];
  for (const d of state.decisions) {
    if (d.type !== "silenceCut" || d.origin === "user") {
      out.push(d);
      continue;
    }
    const range = { startMs: d.sourceStartMs, endMs: d.sourceEndMs };
    const pieces = cutPiecesAroundWords(range, words);
    if (pieces.length === 1 && pieces[0]!.startMs === range.startMs && pieces[0]!.endMs === range.endMs) {
      out.push(d);
      continue;
    }
    if (pieces.length === 0) dropped++;
    else if (pieces.length === 1) shortened++;
    else split++;
    for (const p of pieces) {
      out.push(makeDecision("silenceCut", Math.round(p.startMs), Math.round(p.endMs), {
        payload: { ...(typeof d.payload === "object" && d.payload ? d.payload : {}), lengthMs: Math.round(p.endMs - p.startMs), wordGuarded: true },
        origin: d.origin,
        state: d.state,
      }));
    }
  }
  if (shortened + split + dropped === 0) return { state, shortened, split, dropped };
  // ids must stay unique (two pieces can never share a range, but a piece could equal another decision's range)
  const seen = new Set<string>();
  const unique = out.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  return { state: { ...state, decisions: unique }, shortened, split, dropped };
}
