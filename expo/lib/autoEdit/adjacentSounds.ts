/**
 * Sounds that continue straight on from a word.
 *
 * findUnexplainedSounds drops any loud run that comes within WORD_SLACK_MS of a word, so
 * an um spoken right after (or before) a word, with no gap, counts as part of the word.
 * Here such a run is not dropped: the part inside the word span plus a safety margin is
 * removed (tailMarginMs after the word end, headMarginMs before the word start), and
 * the rest becomes a method-2 candidate when it is at least minPieceMs long and within
 * minPeakVsSpeechDb..maxPeakVsSpeechDb of the speech baseline. It then goes through the
 * normal um rule and every um-cut guard.
 *
 * Not applied when the next / previous word is within neighbourGapMs: that is
 * connected speech, not a tail or head.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import { UNEXPLAINED_MIN_MS, WORD_SLACK_MS, type UnexplainedSound } from "./fillerCuts.ts";

export const ADJACENT_SOUND_CONFIG = {
  /** The cut starts this long after the word end (tail) / ends this long before the word start (head), ms. */
  tailMarginMs: 80,
  headMarginMs: 80,
  /** The piece left after the margin must be at least this long (ms) and at most this long (longer is probably untranscribed speech). */
  minPieceMs: UNEXPLAINED_MIN_MS,
  maxPieceMs: 900,
  /** A tail or head with more loudness pulses than this is probably untranscribed words, not an um. */
  maxBursts: 1,
  /** Within these dB of the speech baseline (peak of the piece). */
  minPeakVsSpeechDb: -12,
  maxPeakVsSpeechDb: 6,
  /** A neighbouring word this close (ms) means connected speech: nothing is looked for. */
  neighbourGapMs: 250,
  /** Words followed or preceded by a pause longer than this (ms) are listed in the debug report. */
  reportPauseMs: 300,
  /** The debug profile covers this much after the word end / before its start (ms), in bins of profileBinMs. */
  profileSpanMs: 1000,
  profileBinMs: 50,
};
export type AdjacentSoundConfig = typeof ADJACENT_SOUND_CONFIG;

export type AdjacentStatus =
  | "no sound"
  | "separate sound"
  | "too short"
  | "too quiet"
  | "too loud"
  | "too long"
  | "candidate";

export type AdjacentFinding = {
  kind: "tail" | "head";
  /** The word the sound follows (tail) or precedes (head). */
  text: string;
  wordStartMs: number;
  wordEndMs: number;
  /** The pause between the word and its neighbour on that side (null: no neighbour). */
  pauseMs: number | null;
  status: AdjacentStatus;
  startMs?: number;
  endMs?: number;
  lengthMs?: number;
  /** Peak of the piece minus the speech baseline (dB). */
  dbVsSpeech?: number;
  /** 50 ms loudness profile (dB vs speech) of the stretch next to the word. */
  profile: string;
};

export function profileOf(
  windows: number[],
  windowMs: number,
  fromMs: number,
  toMs: number,
  speechDb: number,
  binMs: number,
): string {
  const out: string[] = [];
  for (let t = Math.max(0, Math.floor(fromMs / binMs) * binMs); t < toMs; t += binMs) {
    const from = Math.floor(t / windowMs);
    const to = Math.max(from + 1, Math.ceil((t + binMs) / windowMs));
    const dbs = windows.slice(from, to).filter((v) => Number.isFinite(v));
    out.push(`${(t / 1000).toFixed(2)}:${dbs.length ? (dbs.reduce((a, b) => a + b, 0) / dbs.length - speechDb).toFixed(0) : "--"}`);
  }
  return out.join(" ");
}

/**
 * Every stretch of sound that lies outside all words, of ANY length: the loud windows
 * that are not inside a word widened by the tail / head margins, as contiguous pieces of
 * at least minPieceMs. (findUnexplainedSounds stops at 1500 ms, which hides a real
 * multi-second laugh, and drops a laugh that runs on from a word.)
 */
export function findStretchesOutsideWords(
  windows: number[],
  windowMs: number,
  words: Word[],
  thresholdDb: number,
  config: AdjacentSoundConfig = ADJACENT_SOUND_CONFIG,
): UnexplainedSound[] {
  const covered = new Uint8Array(windows.length);
  for (const w of words) {
    const from = Math.max(0, Math.floor((w.startMs - config.headMarginMs) / windowMs));
    const to = Math.min(windows.length, Math.ceil((w.endMs + config.tailMarginMs) / windowMs));
    for (let i = from; i < to; i++) covered[i] = 1;
  }
  const out: UnexplainedSound[] = [];
  let run = -1;
  for (let i = 0; i <= windows.length; i++) {
    const on = i < windows.length && !covered[i] && Number.isFinite(windows[i]!) && windows[i]! > thresholdDb;
    if (on && run < 0) run = i;
    if (!on && run >= 0) {
      const startMs = run * windowMs;
      const endMs = i * windowMs;
      if (endMs - startMs >= config.minPieceMs) out.push({ startMs, endMs, lengthMs: endMs - startMs });
      run = -1;
    }
  }
  return out;
}

export function analyzeAdjacent(
  windows: number[],
  windowMs: number,
  allWords: Word[],
  thresholdDb: number,
  speechDb: number,
  config: AdjacentSoundConfig = ADJACENT_SOUND_CONFIG,
): { candidates: UnexplainedSound[]; findings: AdjacentFinding[] } {
  const words = [...allWords].filter((w) => w.endMs > w.startMs).sort((a, b) => a.startMs - b.startMs);
  const candidates: UnexplainedSound[] = [];
  const findings: AdjacentFinding[] = [];
  const loud = (i: number) => i >= 0 && i < windows.length && Number.isFinite(windows[i]!) && windows[i]! > thresholdDb;
  const clipEndMs = windows.length * windowMs;

  const examine = (kind: "tail" | "head", w: Word, neighbour: Word | undefined) => {
    const pause = neighbour ? (kind === "tail" ? neighbour.startMs - w.endMs : w.startMs - neighbour.endMs) : null;
    if (pause !== null && pause <= config.neighbourGapMs) return; // connected speech
    const from = kind === "tail" ? w.endMs + config.tailMarginMs : (neighbour ? neighbour.endMs + config.tailMarginMs : 0);
    const to = kind === "tail" ? (neighbour ? neighbour.startMs - config.headMarginMs : clipEndMs) : w.startMs - config.headMarginMs;
    const fromIdx = Math.ceil(from / windowMs);
    const toIdx = Math.min(windows.length, Math.floor(to / windowMs));
    const base = {
      kind,
      text: w.text,
      wordStartMs: w.startMs,
      wordEndMs: w.endMs,
      pauseMs: pause,
      profile:
        kind === "tail"
          ? profileOf(windows, windowMs, w.endMs, w.endMs + config.profileSpanMs, speechDb, config.profileBinMs)
          : profileOf(windows, windowMs, w.startMs - config.profileSpanMs, w.startMs, speechDb, config.profileBinMs),
    };
    const report = (f: Omit<AdjacentFinding, keyof typeof base>) => {
      // The clip's first and last word have no pause beside them to explain: only list them when there is sound.
      if (pause === null ? f.status !== "no sound" : pause > config.reportPauseMs) findings.push({ ...base, ...f });
    };

    // The loud run next to the word: the first one in the region for a tail, the last for a head.
    let idx = -1;
    if (kind === "tail") {
      for (let i = Math.max(0, fromIdx); i < toIdx; i++) if (loud(i)) { idx = i; break; }
    } else {
      for (let i = toIdx - 1; i >= Math.max(0, fromIdx); i--) if (loud(i)) { idx = i; break; }
    }
    if (idx < 0) {
      report({ status: "no sound" });
      return;
    }
    let rs = idx;
    while (loud(rs - 1)) rs--;
    let re = idx + 1;
    while (loud(re)) re++;
    const runStartMs = rs * windowMs;
    const runEndMs = re * windowMs;
    // Does it run on from the word (would the old rule have called it part of the word)?
    const touches = kind === "tail" ? runStartMs <= w.endMs + WORD_SLACK_MS : runEndMs >= w.startMs - WORD_SLACK_MS;
    const pieceStart = Math.max(runStartMs, fromIdx * windowMs);
    const pieceEnd = Math.min(runEndMs, toIdx * windowMs);
    const lengthMs = pieceEnd - pieceStart;
    const dbs = windows.slice(Math.floor(pieceStart / windowMs), Math.ceil(pieceEnd / windowMs)).filter((v) => Number.isFinite(v));
    const dbVsSpeech = dbs.length ? Math.max(...dbs) - speechDb : -Infinity;
    const detail = { startMs: pieceStart, endMs: pieceEnd, lengthMs, dbVsSpeech };
    if (!touches) {
      // A run that reaches the word on the other side is that word's head (or tail), not this word's.
      const reachesNeighbour = neighbour
        ? kind === "tail"
          ? runEndMs >= neighbour.startMs - WORD_SLACK_MS
          : runStartMs <= neighbour.endMs + WORD_SLACK_MS
        : false;
      if (reachesNeighbour) report({ status: "no sound" });
      else report({ status: "separate sound", ...detail });
      return;
    }
    if (lengthMs < config.minPieceMs) report({ status: "too short", ...detail });
    else if (lengthMs > config.maxPieceMs) report({ status: "too long", ...detail });
    else if (dbVsSpeech < config.minPeakVsSpeechDb) report({ status: "too quiet", ...detail });
    else if (dbVsSpeech > config.maxPeakVsSpeechDb) report({ status: "too loud", ...detail });
    else {
      report({ status: "candidate", ...detail });
      if (!candidates.some((c) => c.startMs < pieceEnd && c.endMs > pieceStart)) {
        candidates.push({
          startMs: pieceStart,
          endMs: pieceEnd,
          lengthMs,
          adjacent: kind === "tail" ? `after '${w.text}'` : `before '${w.text}'`,
        });
      }
    }
  };

  words.forEach((w, i) => {
    examine("tail", w, words[i + 1]);
    examine("head", w, words[i - 1]);
  });
  candidates.sort((a, b) => a.startMs - b.startMs);
  return { candidates, findings };
}
