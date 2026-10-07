/**
 * Classify method-2 filler candidates ("unexplained sound": loud, but no transcript
 * word) from the cached loudness data. Display only: NOTHING here creates a cut
 * decision itself; umCuts.ts turns the 'um' ones into reversible cuts (owner only).
 *   um     a voiced sound between two words, 150-900 ms, not a breath and not louder than
 *          speech: cut by umCuts.ts, else shown as "um?". (With a short transcript the old
 *          rule applies: short, steady, not louder than speech.)
 *   laugh  pulsed (or loud with pulses): never cut; a zoom signal
 *   unsure anything else: shown, never cut
 * Every threshold is in SOUND_CLASSIFIER_CONFIG so it can be tuned from real clips.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import { detectSilences } from "../silenceDetection.ts";
import { loudnessJumpScorer } from "./emphasisMoments.ts";
import { findUnexplainedSounds, type UnexplainedSound } from "./fillerCuts.ts";

export const SOUND_CLASSIFIER_CONFIG = {
  /** laugh: this many separate loudness pulses inside the candidate or more. */
  laughMinBursts: 3,
  /** laugh: ...or a peak at least this far above the median speech loudness (dB)... */
  laughPeakAboveSpeechDb: 6,
  /** ...together with at least this many pulses. */
  laughPeakMinBursts: 2,
  /** Only reported (the nearEmphasis feature); being near a loudness jump never makes a laugh. */
  nearEmphasisMs: 1000,
  /** um: duration range (ms). */
  umMinMs: 150,
  umMaxMs: 900,
  /** um: peak between these two distances from the median speech loudness (dB): quieter is a breath, louder is not an um. */
  umMinPeakVsSpeechDb: -12,
  umMaxPeakVsSpeechDb: 4,
  /** With fewer transcript words than this the old um rule is used (no mid-speech evidence to rely on). */
  umFallbackBelowWords: 10,
  /** Old rule only: steady = coefficient of variation of the linear loudness at most this. */
  umMaxCv: 0.35,
  /** Old rule only: peak at most this far above the median speech loudness (dB). */
  umMaxPeakAboveSpeechDb: 3,
  /** Speech baseline: fewer transcript words than this falls back to all non-silent frames. */
  minWordsForBaseline: 10,
  /** Old rule only: also require a word just before and just after. */
  umRequiresMidSpeech: false,
  /** midSpeech: a word ends this close before, and another starts this close after (ms). */
  midSpeechWindowMs: 400,
  /** ...allowing the word timing to overlap the candidate by this much (ms). */
  midSpeechOverlapSlackMs: 100,
  /** Um cuts (see umCuts.ts): each cut starts this long after the candidate begins and ends this long before it ends (ms). */
  umEdgePaddingMs: 30,
  /** ...and a um shorter than this after padding is skipped (ms). */
  umMinCutMs: 150,
  /** A um cut within this long of a silence cut is merged into it: one seam (ms). */
  umMergeGapMs: 120,
  /** No kept piece between two cuts may be shorter than this once a um is involved (ms). */
  umMinKeepMs: 250,
  /** Safety cap: at most one new seam per this many seconds of edited duration. */
  umSecondsPerNewSeam: 3,
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
  /** How many transcript words the classification had (selects the um rule); unknown = enough. */
  wordCount?: number;
};

/** Which parts of the um rule held, for the debug view. null = not part of the rule that was used. */
export type UmChecks = {
  rule: "transcript" | "fallback";
  midSpeech: boolean | null;
  duration: boolean;
  loudness: boolean;
  steadiness: boolean | null;
  laugh: boolean;
};

export type ClassifiedSound = UnexplainedSound & {
  cls: SoundClass;
  features: SoundFeatures;
  /** Why it got this class, for the debug view. */
  why: string[];
  checks?: UmChecks;
};

export type SoundContext = {
  /** RMS dBFS per window (modules/audio-loudness). */
  windows: number[];
  windowMs: number;
  /** Transcript words. Every time here (words, windows, candidates) is SOURCE time. */
  words: Word[];
  /** The silence detector's threshold (dB); computed from the windows when missing. */
  thresholdDb?: number;
};

/** The silence detector's threshold for these windows: below it a frame is silence. */
export function silenceThresholdDb(windows: number[], windowMs: number, durationMs: number): number {
  return detectSilences(windows, windowMs, { durationMs }).thresholdDb;
}

function thresholdOf(ctx: SoundContext): number {
  return ctx.thresholdDb ?? silenceThresholdDb(ctx.windows, ctx.windowMs, ctx.windows.length * ctx.windowMs);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The typical loudness of speech: the median over the windows inside transcript
 * words (source time), counting only frames above the silence threshold, so word
 * edges that spill into silence never pull it down. With fewer than
 * minWordsForBaseline words (or no sound inside them) it falls back to the median
 * of all non-silent frames.
 */
export function speechMedianDb(
  ctx: SoundContext,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): number {
  const threshold = thresholdOf(ctx);
  const sound = (v: number) => Number.isFinite(v) && v > threshold;
  if (ctx.words.length >= config.minWordsForBaseline) {
    const inside: number[] = [];
    for (const w of ctx.words) {
      const from = Math.max(0, Math.floor(w.startMs / ctx.windowMs));
      const to = Math.min(ctx.windows.length, Math.ceil(w.endMs / ctx.windowMs));
      for (let i = from; i < to; i++) if (sound(ctx.windows[i]!)) inside.push(ctx.windows[i]!);
    }
    if (inside.length > 0) return median(inside);
  }
  return median(ctx.windows.filter(sound));
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
    peakVsSpeechDb: peakDb - speechMedianDb(ctx, config),
    steadiness: mean > 0 ? Math.sqrt(variance) / mean : 0,
    burstCount: countBursts(amps, ctx.windowMs, config),
    nearEmphasis,
    midSpeech: before && after,
    wordCount: ctx.words.length,
  };
}

/**
 * The um rule. With enough transcript words: mid-speech, 150-900 ms, loudness within
 * umMinPeakVsSpeechDb..umMaxPeakVsSpeechDb, and not a laugh (steadiness is only reported).
 * With fewer than umFallbackBelowWords words: the old rule (short, steady, not louder than speech).
 */
export function umChecks(
  f: SoundFeatures,
  isLaugh: boolean,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): UmChecks & { isUm: boolean } {
  const duration = f.durationMs >= config.umMinMs && f.durationMs <= config.umMaxMs;
  const fallback = f.wordCount !== undefined && f.wordCount < config.umFallbackBelowWords;
  const checks: UmChecks = fallback
    ? {
        rule: "fallback",
        midSpeech: config.umRequiresMidSpeech ? f.midSpeech : null,
        duration,
        loudness: f.peakVsSpeechDb <= config.umMaxPeakAboveSpeechDb,
        steadiness: f.steadiness <= config.umMaxCv,
        laugh: !isLaugh,
      }
    : {
        rule: "transcript",
        midSpeech: f.midSpeech,
        duration,
        loudness: f.peakVsSpeechDb >= config.umMinPeakVsSpeechDb && f.peakVsSpeechDb <= config.umMaxPeakVsSpeechDb,
        steadiness: null,
        laugh: !isLaugh,
      };
  const isUm = [checks.midSpeech, checks.duration, checks.loudness, checks.steadiness, checks.laugh].every((c) => c !== false);
  return { ...checks, isUm };
}

export function classifyFeatures(
  f: SoundFeatures,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): { cls: SoundClass; why: string[]; checks: UmChecks } {
  const laughWhy: string[] = [];
  if (f.burstCount >= config.laughMinBursts) laughWhy.push(`${f.burstCount} pulses`);
  if (f.peakVsSpeechDb >= config.laughPeakAboveSpeechDb && f.burstCount >= config.laughPeakMinBursts) {
    laughWhy.push(`louder than speech with ${f.burstCount} pulses`);
  }
  const { isUm, ...checks } = umChecks(f, laughWhy.length > 0, config);
  if (laughWhy.length > 0) return { cls: "laugh", why: laughWhy, checks };
  if (isUm) {
    return {
      cls: "um",
      why: [checks.rule === "transcript" ? "voiced sound between two words, not a breath, not louder than speech" : "short, steady, not louder than speech (short transcript)"],
      checks,
    };
  }
  return { cls: "unsure", why: ["fits neither"], checks };
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
  // Loudness-jump moments only: the laugh scorer is added after classification, never before.
  const jumps = loudnessJumpScorer({
    windows: ctx.windows,
    windowMs: ctx.windowMs,
    words: ctx.words,
    durationMs: ctx.windows.length * ctx.windowMs,
    silenceThresholdDb: thresholdOf(ctx),
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
  const threshold = silenceThresholdDb(windows, windowMs, durationMs);
  const found = findUnexplainedSounds(windows, windowMs, words, threshold);
  return classifySounds(found, { windows, windowMs, words, thresholdDb: threshold }, config);
}

/** "mid-speech PASS, duration PASS, loudness FAIL (-18.2 dB, needs -12..+4), laugh PASS; steadiness 0.41 (not required)" */
export function formatUmChecks(
  c: UmChecks,
  f: SoundFeatures,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): string {
  const pf = (ok: boolean | null) => (ok === null ? "n/a" : ok ? "PASS" : "FAIL");
  const sign = f.peakVsSpeechDb >= 0 ? "+" : "";
  const need =
    c.rule === "transcript"
      ? `needs ${config.umMinPeakVsSpeechDb}..+${config.umMaxPeakVsSpeechDb}`
      : `needs at most +${config.umMaxPeakAboveSpeechDb}`;
  const steady = c.steadiness === null ? `steadiness ${f.steadiness.toFixed(2)} (not required)` : `steadiness ${pf(c.steadiness)} (${f.steadiness.toFixed(2)}, needs at most ${config.umMaxCv})`;
  return (
    `um rule (${c.rule === "transcript" ? "transcript" : `old rule, fewer than ${config.umFallbackBelowWords} words`}): ` +
    `mid-speech ${pf(c.midSpeech)}, duration ${pf(c.duration)} (${Math.round(f.durationMs)} ms, needs ${config.umMinMs}-${config.umMaxMs}), ` +
    `loudness ${pf(c.loudness)} (${sign}${f.peakVsSpeechDb.toFixed(1)} dB, ${need}), laugh ${pf(c.laugh)}; ${steady}`
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
