/**
 * Ums the recognizer absorbed into a word.
 *
 * Apple sometimes folds a hesitation into the end (or start) of the neighbouring word
 * ("lease [um]" is heard as one long "lease"): there is then no sound without a word
 * for method 2 to find. This planner finds such words and the absorbed um:
 *   1. The speaker's expected duration per word comes from the transcript (median ms
 *      per character, so outliers do not matter).
 *   2. A word is stretched when it lasts more than stretchFactor x expected AND a pause
 *      longer than pauseMs follows or precedes it.
 *   3. Inside a stretched word, at the END (pause follows) or START (pause precedes):
 *      a loudness dip of at least dipDb below the word body lasting at least dipMinMs,
 *      next to a sustained voiced stretch (voicedMinMs, within voicedMinDb..voicedMaxDb
 *      of the speech baseline). That stretch plus the non-silent sound adjacent to it
 *      in the gap is the absorbed um.
 *   4. No dip, or an um that would take more than maxWordCutShare of the word: nothing.
 * The result is 'um' sounds for planUmCuts, which applies every existing guard (edge
 * padding, merge with silence, no slivers, laugh protection, safety cap, Ums switch).
 * Also reports a diagnosis of the gap next to each stretched word.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import {
  SOUND_CLASSIFIER_CONFIG,
  silenceThresholdDb,
  soundFeatures,
  speechMedianDb,
  type ClassifiedSound,
  type SoundClassifierConfig,
  type SoundContext,
} from "./classifySound.ts";
import { UNEXPLAINED_MAX_MS, UNEXPLAINED_MIN_MS, WORD_SLACK_MS } from "./fillerCuts.ts";
import { profileOf } from "./adjacentSounds.ts";

export const STRETCHED_UM_CONFIG = {
  /** A word is stretched when longer than this times its expected duration... */
  stretchFactor: 1.5,
  /** ...and a pause longer than this (ms) follows or precedes it. */
  pauseMs: 300,
  /** The dip: at least this far below the word body (dB)... */
  dipDb: 5,
  /** ...for at least this long (ms). */
  dipMinMs: 40,
  /** The voiced stretch next to the dip: at least this long (ms) and within these dB of the speech baseline. */
  voicedMinMs: 150,
  voicedMinDb: -12,
  voicedMaxDb: 6,
  /** Never cut more than this share of the word's duration. */
  maxWordCutShare: 0.5,
  /** The profile in the debug text covers this much around the word and its gap (ms), in bins of profileBinMs. */
  profilePadMs: 200,
  profileBinMs: 50,
};
export type StretchedUmConfig = typeof STRETCHED_UM_CONFIG;

export type StretchedWordInfo = {
  text: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  expectedMs: number;
  pauseBeforeMs: number | null;
  pauseAfterMs: number | null;
  /** Which end was searched when a dip was found (or the last one tried). */
  side: "end" | "start" | null;
  dipFound: boolean;
  dip?: { startMs: number; endMs: number; dropDb: number };
  /** The absorbed um (source time), when found. */
  cut?: { startMs: number; endMs: number; insideWordMs: number };
  note?: string;
  /** Why the gap next to this word did or did not produce a method-2 candidate. */
  gapDiagnosis: string[];
  /** 50 ms loudness profile (dB vs the speech baseline) from before the word to after its gap. */
  profile: string;
};

export type StretchedReport = {
  expectedMsPerChar: number | null;
  words: StretchedWordInfo[];
};

const charsOf = (w: Word) => [...w.text.replace(/[^\p{L}\p{N}]+/gu, "")].length;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** "m:ss.s" style seconds for the report ("9.2" style is enough here). */
const sec = (ms: number) => (ms / 1000).toFixed(2);

/** Why method 2 found no candidate in [fromMs, toMs): the sound there, run by run. */
function diagnoseGap(
  ctx: SoundContext & { thresholdDb: number },
  fromMs: number,
  toMs: number,
  speechDb: number,
): string[] {
  const { windows, windowMs, words, thresholdDb } = ctx;
  const out: string[] = [`gap ${sec(fromMs)}-${sec(toMs)} (${Math.round(toMs - fromMs)} ms), silence threshold ${thresholdDb.toFixed(1)} dB (${(thresholdDb - speechDb).toFixed(1)} vs speech)`];
  const a = Math.max(0, Math.floor(fromMs / windowMs));
  const b = Math.min(windows.length, Math.ceil(toMs / windowMs));
  const inGap = windows.slice(a, b).filter((v) => Number.isFinite(v));
  const peak = inGap.length ? Math.max(...inGap) : -Infinity;
  const loudWindows = inGap.filter((v) => v > thresholdDb).length;
  if (loudWindows === 0) {
    out.push(`  no sound above the threshold in the gap (peak ${Number.isFinite(peak) ? (peak - speechDb).toFixed(1) : "none"} dB vs speech): too quiet to be a candidate`);
    return out;
  }
  // The loud runs that touch the gap, extended over their whole length (they can start inside a word).
  let i = a;
  while (i < b) {
    if (!(Number.isFinite(windows[i]!) && windows[i]! > thresholdDb)) {
      i++;
      continue;
    }
    let s = i;
    while (s > 0 && Number.isFinite(windows[s - 1]!) && windows[s - 1]! > thresholdDb) s--;
    let e = i;
    while (e < windows.length && Number.isFinite(windows[e]!) && windows[e]! > thresholdDb) e++;
    const runStart = s * windowMs;
    const runEnd = e * windowMs;
    const len = runEnd - runStart;
    const touching = words.find((w) => w.startMs - WORD_SLACK_MS < runEnd && w.endMs + WORD_SLACK_MS > runStart);
    let verdict: string;
    if (len < UNEXPLAINED_MIN_MS) verdict = `too short (needs ${UNEXPLAINED_MIN_MS} ms)`;
    else if (len > UNEXPLAINED_MAX_MS) verdict = `too long (over ${UNEXPLAINED_MAX_MS} ms)`;
    else if (touching) verdict = `joined to the word '${touching.text}' (within ${WORD_SLACK_MS} ms of it), so a word explains it: not a candidate`;
    else verdict = "a candidate (see the list above)";
    out.push(`  sound ${sec(runStart)}-${sec(runEnd)} (${Math.round(len)} ms, peak ${(Math.max(...windows.slice(s, e)) - speechDb).toFixed(1)} dB vs speech): ${verdict}`);
    i = e;
  }
  return out;
}

export function planStretchedUms(
  windows: number[],
  windowMs: number,
  durationMs: number,
  allWords: Word[],
  config: StretchedUmConfig = STRETCHED_UM_CONFIG,
  umConfig: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): { sounds: ClassifiedSound[]; report: StretchedReport } {
  const words = [...allWords].filter((w) => w.endMs > w.startMs && charsOf(w) > 0).sort((a, b) => a.startMs - b.startMs);
  const empty = { sounds: [] as ClassifiedSound[], report: { expectedMsPerChar: null, words: [] } as StretchedReport };
  if (words.length < umConfig.umFallbackBelowWords || windows.length === 0) return empty;

  const threshold = silenceThresholdDb(windows, windowMs, durationMs);
  const ctx = { windows, windowMs, words: allWords, thresholdDb: threshold };
  const speechDb = speechMedianDb(ctx, umConfig);
  const perChar = median(words.map((w) => (w.endMs - w.startMs) / charsOf(w)));
  const sound = (v: number | undefined) => v !== undefined && Number.isFinite(v) && v > threshold;
  const voiced = (v: number | undefined) =>
    v !== undefined && Number.isFinite(v) && v >= speechDb + config.voicedMinDb && v <= speechDb + config.voicedMaxDb;
  const dipWin = Math.max(1, Math.ceil(config.dipMinMs / windowMs));
  const voicedWin = Math.max(1, Math.ceil(config.voicedMinMs / windowMs));

  const sounds: ClassifiedSound[] = [];
  const infos: StretchedWordInfo[] = [];

  words.forEach((w, wi) => {
    const durationMsW = w.endMs - w.startMs;
    const expectedMs = perChar * charsOf(w);
    if (durationMsW <= config.stretchFactor * expectedMs) return;
    const prev = words[wi - 1];
    const next = words[wi + 1];
    const pauseBefore = prev ? w.startMs - prev.endMs : null;
    const pauseAfter = next ? next.startMs - w.endMs : null;
    const pauseAfterOk = pauseAfter !== null && pauseAfter > config.pauseMs;
    const pauseBeforeOk = pauseBefore !== null && pauseBefore > config.pauseMs;
    if (!pauseAfterOk && !pauseBeforeOk) return;

    const info: StretchedWordInfo = {
      text: w.text,
      startMs: w.startMs,
      endMs: w.endMs,
      durationMs: durationMsW,
      expectedMs,
      pauseBeforeMs: pauseBefore,
      pauseAfterMs: pauseAfter,
      side: null,
      dipFound: false,
      gapDiagnosis: [],
      profile: profileOf(
        windows,
        windowMs,
        w.startMs - (pauseBeforeOk ? pauseBefore! : 0) - config.profilePadMs,
        w.endMs + (pauseAfterOk ? pauseAfter! : 0) + config.profilePadMs,
        speechDb,
        config.profileBinMs,
      ),
    };
    if (pauseAfterOk) info.gapDiagnosis.push(...diagnoseGap(ctx, w.endMs, next!.startMs, speechDb));
    if (pauseBeforeOk) info.gapDiagnosis.push(...diagnoseGap(ctx, prev!.endMs, w.startMs, speechDb));
    infos.push(info);

    const w0 = Math.floor(w.startMs / windowMs);
    const w1 = Math.min(windows.length, Math.ceil(w.endMs / windowMs));
    const n = w1 - w0;
    const half = Math.floor(n * config.maxWordCutShare);
    if (n < 2 || half < 1) {
      info.note = "word too short to search";
      return;
    }
    const medianBody = (from: number, to: number): number | null => {
      const v = windows.slice(from, to).filter((x) => sound(x));
      return v.length ? median(v) : null;
    };
    const lowerBound = prev ? Math.ceil(prev.endMs / windowMs) : 0;
    const upperBound = next ? Math.floor(next.startMs / windowMs) : windows.length;

    type Found = { side: "end" | "start"; dipFrom: number; dipTo: number; dropDb: number; umFrom: number; umTo: number };
    const searchEnd = (): Found | null => {
      const ref = medianBody(w0, w1 - half);
      if (ref === null) return null;
      for (let j = w1 - half; j < w1; j++) {
        if (!(!Number.isFinite(windows[j]!) || windows[j]! <= ref - config.dipDb)) continue;
        let je = j;
        while (je < windows.length && (!Number.isFinite(windows[je]!) || windows[je]! <= ref - config.dipDb)) je++;
        if (je - j >= dipWin) {
          let k = je;
          while (k < upperBound && voiced(windows[k])) k++;
          if (k - je >= voicedWin) {
            let end = k;
            while (end < upperBound && sound(windows[end])) end++;
            const dropDb = ref - Math.min(...windows.slice(j, je).filter((x) => Number.isFinite(x)), ref - config.dipDb);
            return { side: "end", dipFrom: j, dipTo: je, dropDb, umFrom: je, umTo: end };
          }
        }
        j = je;
      }
      return null;
    };
    const searchStart = (): Found | null => {
      const ref = medianBody(w0 + half, w1);
      if (ref === null) return null;
      for (let j = w0; j < w0 + half; j++) {
        if (!(!Number.isFinite(windows[j]!) || windows[j]! <= ref - config.dipDb)) continue;
        let je = j;
        while (je < windows.length && (!Number.isFinite(windows[je]!) || windows[je]! <= ref - config.dipDb)) je++;
        if (je - j >= dipWin) {
          let k = j;
          while (k > lowerBound && voiced(windows[k - 1])) k--;
          if (j - k >= voicedWin) {
            let start = k;
            while (start > lowerBound && sound(windows[start - 1])) start--;
            const dropDb = ref - Math.min(...windows.slice(j, je).filter((x) => Number.isFinite(x)), ref - config.dipDb);
            return { side: "start", dipFrom: j, dipTo: je, dropDb, umFrom: start, umTo: j };
          }
        }
        j = je;
      }
      return null;
    };

    const found = (pauseAfterOk ? searchEnd() : null) ?? (pauseBeforeOk ? searchStart() : null);
    info.side = found?.side ?? (pauseAfterOk ? "end" : "start");
    if (!found) {
      info.note = "no loudness dip with a voiced stretch next to it: nothing cut";
      return;
    }
    info.dipFound = true;
    info.dip = { startMs: found.dipFrom * windowMs, endMs: found.dipTo * windowMs, dropDb: found.dropDb };
    const startMs = found.umFrom * windowMs;
    const endMs = found.umTo * windowMs;
    const insideWordMs = Math.max(0, Math.min(endMs, w.endMs) - Math.max(startMs, w.startMs));
    if (insideWordMs > config.maxWordCutShare * durationMsW) {
      info.note = `the um would take ${Math.round((100 * insideWordMs) / durationMsW)}% of the word (limit ${Math.round(100 * config.maxWordCutShare)}%): nothing cut`;
      return;
    }
    info.cut = { startMs, endMs, insideWordMs };
    const candidate = { startMs, endMs, lengthMs: endMs - startMs };
    sounds.push({
      ...candidate,
      features: soundFeatures(candidate, ctx, [], umConfig),
      cls: "um",
      why: [`um absorbed into the ${found.side} of the stretched word '${w.text}'`],
    });
  });

  return { sounds, report: { expectedMsPerChar: perChar, words: infos } };
}
