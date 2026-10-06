/**
 * Classify method-2 filler candidates ("unexplained sound": loud, but no transcript
 * word) from the cached loudness data:
 *   um     a short, steady, quiet-ish hesitation: cut it
 *   laugh  pulsed, or louder than speech, or next to a loudness jump: never cut it
 *   unsure anything else: not cut, still shown
 * Every threshold is in SOUND_CLASSIFIER_CONFIG so it can be tuned from real clips.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import { detectSilences } from "../silenceDetection.ts";
import { makeDecision, type Decision } from "./decisions.ts";
import { loudnessJumpScorer } from "./emphasisMoments.ts";
import { findUnexplainedSounds, type UnexplainedSound } from "./fillerCuts.ts";

export const SOUND_CLASSIFIER_CONFIG = {
  /** laugh: this many separate loudness pulses inside the candidate or more. */
  laughMinBursts: 3,
  /** laugh: peak at least this far above the median loudness of speech (dB). */
  laughPeakAboveSpeechDb: 3,
  /** laugh: a loudness-jump emphasis moment within this long of the candidate (ms). */
  nearEmphasisMs: 1000,
  /** um: duration range (ms). */
  umMinMs: 150,
  umMaxMs: 800,
  /** um: steady = coefficient of variation of the linear loudness at most this. */
  umMaxCv: 0.35,
  /** um: peak at most this far above the median speech loudness (dB); 0 = "at speech level". */
  umMaxPeakAboveSpeechDb: 1,
  /** um: also require a word just before and just after (off: it is only reported). */
  umRequiresMidSpeech: false,
  /** midSpeech: a word ends this close before, and another starts this close after (ms). */
  midSpeechWindowMs: 400,
  /** ...allowing the word timing to overlap the candidate by this much (ms). */
  midSpeechOverlapSlackMs: 100,
  /** pulses: a window counts as part of a pulse above this fraction of the peak (linear). */
  burstThresholdFraction: 0.5,
  /** pulses closer than this are one pulse (ms). */
  burstMinGapMs: 40,
  /** a pulse is at least this long (ms). */
  burstMinPulseMs: 40,
};
export type SoundClassifierConfig = typeof SOUND_CLASSIFIER_CONFIG;

export type SoundClass = "um" | "laugh" | "unsure";

export type SoundFeatures = {
  durationMs: number;
  /** Peak loudness minus the median loudness during transcript words (dB). */
  peakVsSpeechDb: number;
  /** Coefficient of variation of the linear loudness inside the candidate (0 = flat). */
  steadiness: number;
  burstCount: number;
  nearEmphasis: boolean;
  midSpeech: boolean;
};

export type ClassifiedSound = UnexplainedSound & {
  cls: SoundClass;
  features: SoundFeatures;
  /** Why it got this class, for the debug view. */
  why: string[];
};

export type SoundContext = {
  /** RMS dBFS per window (modules/audio-loudness). */
  windows: number[];
  windowMs: number;
  words: Word[];
};

const SPEECH_FLOOR_DB = -55;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median loudness over the windows that fall inside transcript words. */
export function speechMedianDb(ctx: SoundContext): number {
  const inside: number[] = [];
  for (const w of ctx.words) {
    const from = Math.max(0, Math.floor(w.startMs / ctx.windowMs));
    const to = Math.min(ctx.windows.length, Math.ceil(w.endMs / ctx.windowMs));
    for (let i = from; i < to; i++) if (Number.isFinite(ctx.windows[i]!)) inside.push(ctx.windows[i]!);
  }
  if (inside.length > 0) return median(inside);
  return median(ctx.windows.filter((v) => Number.isFinite(v) && v > SPEECH_FLOOR_DB));
}

function linear(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

/** Separate pulses: runs above a fraction of the peak, runs closer than burstMinGapMs merged. */
function countBursts(amps: number[], windowMs: number, config: SoundClassifierConfig): number {
  const peak = Math.max(0, ...amps);
  if (!(peak > 0)) return 0;
  const limit = peak * config.burstThresholdFraction;
  const minGap = Math.max(1, Math.ceil(config.burstMinGapMs / windowMs));
  const minPulse = Math.max(1, Math.ceil(config.burstMinPulseMs / windowMs));
  const runs: Array<{ from: number; to: number }> = [];
  let start = -1;
  for (let i = 0; i <= amps.length; i++) {
    const on = i < amps.length && amps[i]! >= limit;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const last = runs[runs.length - 1];
      if (last && start - last.to < minGap) last.to = i;
      else runs.push({ from: start, to: i });
      start = -1;
    }
  }
  return runs.filter((r) => r.to - r.from >= minPulse).length;
}

export function soundFeatures(
  candidate: UnexplainedSound,
  ctx: SoundContext,
  emphasisMs: number[],
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): SoundFeatures {
  const from = Math.max(0, Math.floor(candidate.startMs / ctx.windowMs));
  const to = Math.min(ctx.windows.length, Math.ceil(candidate.endMs / ctx.windowMs));
  const dbs = ctx.windows.slice(from, to).filter((v) => Number.isFinite(v));
  const amps = dbs.map(linear);
  const mean = amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : 0;
  const variance = amps.length ? amps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / amps.length : 0;
  const peakDb = dbs.length ? Math.max(...dbs) : -100;

  const nearEmphasis = emphasisMs.some(
    (t) => t >= candidate.startMs - config.nearEmphasisMs && t <= candidate.endMs + config.nearEmphasisMs,
  );
  const slack = config.midSpeechOverlapSlackMs;
  const before = ctx.words.some((w) => {
    const gap = candidate.startMs - w.endMs;
    return gap >= -slack && gap <= config.midSpeechWindowMs;
  });
  const after = ctx.words.some((w) => {
    const gap = w.startMs - candidate.endMs;
    return gap >= -slack && gap <= config.midSpeechWindowMs;
  });

  return {
    durationMs: candidate.lengthMs,
    peakVsSpeechDb: peakDb - speechMedianDb(ctx),
    steadiness: mean > 0 ? Math.sqrt(variance) / mean : 0,
    burstCount: countBursts(amps, ctx.windowMs, config),
    nearEmphasis,
    midSpeech: before && after,
  };
}

export function classifyFeatures(
  f: SoundFeatures,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): { cls: SoundClass; why: string[] } {
  const laughWhy: string[] = [];
  if (f.burstCount >= config.laughMinBursts) laughWhy.push(`${f.burstCount} pulses`);
  if (f.peakVsSpeechDb >= config.laughPeakAboveSpeechDb) laughWhy.push("louder than speech");
  if (f.nearEmphasis) laughWhy.push("near a loudness jump");
  if (laughWhy.length > 0) return { cls: "laugh", why: laughWhy };

  const isUm =
    f.durationMs >= config.umMinMs &&
    f.durationMs <= config.umMaxMs &&
    f.steadiness <= config.umMaxCv &&
    f.peakVsSpeechDb <= config.umMaxPeakAboveSpeechDb &&
    (!config.umRequiresMidSpeech || f.midSpeech);
  if (isUm) return { cls: "um", why: ["short, steady, not louder than speech"] };
  return { cls: "unsure", why: ["fits neither"] };
}

/** Classify one candidate. emphasisMs are the loudness-jump moments (see classifySounds). */
export function classifySound(
  candidate: UnexplainedSound,
  ctx: SoundContext,
  emphasisMs: number[],
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): ClassifiedSound {
  const features = soundFeatures(candidate, ctx, emphasisMs, config);
  return { ...candidate, features, ...classifyFeatures(features, config) };
}

export function classifySounds(
  candidates: UnexplainedSound[],
  ctx: SoundContext,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): ClassifiedSound[] {
  const jumps = loudnessJumpScorer({
    windows: ctx.windows,
    windowMs: ctx.windowMs,
    words: ctx.words,
    durationMs: ctx.windows.length * ctx.windowMs,
  }).map((c) => c.sourceMs);
  return candidates.map((c) => classifySound(c, ctx, jumps, config));
}

/** Method 2 end to end: find the unexplained sounds, then classify each. */
export function analyzeUnexplained(
  windows: number[],
  windowMs: number,
  durationMs: number,
  words: Word[],
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): ClassifiedSound[] {
  const threshold = detectSilences(windows, windowMs, { durationMs }).thresholdDb;
  const found = findUnexplainedSounds(windows, windowMs, words, threshold);
  return classifySounds(found, { windows, windowMs, words }, config);
}

/** Only ums are cut (applied fillerCut decisions); laughs and unsure sounds never are. */
export function planUmCuts(sounds: ClassifiedSound[]): Decision[] {
  return sounds
    .filter((s) => s.cls === "um")
    .map((s) =>
      makeDecision("fillerCut", s.startMs, s.endMs, {
        payload: { text: "um", method: 2, cls: s.cls, features: s.features },
      }),
    );
}

/** "300 ms  peak vs speech -2.1 dB  steadiness 0.18  bursts 1  near emphasis no  mid-speech yes" */
export function formatFeatures(f: SoundFeatures): string {
  const sign = f.peakVsSpeechDb >= 0 ? "+" : "";
  return [
    `${Math.round(f.durationMs)} ms`,
    `peak vs speech ${sign}${f.peakVsSpeechDb.toFixed(1)} dB`,
    `steadiness ${f.steadiness.toFixed(2)}`,
    `bursts ${f.burstCount}`,
    `near emphasis ${f.nearEmphasis ? "yes" : "no"}`,
    `mid-speech ${f.midSpeech ? "yes" : "no"}`,
  ].join("  ");
}
