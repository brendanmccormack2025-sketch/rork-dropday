/**
 * Conservative silence detection over a loudness-over-time reading
 * (RMS dBFS per window, from modules/audio-loudness).
 *
 * Pure function: no React, no native modules. Cuts are returned as instructions
 * (keep ranges in source-clip milliseconds); nothing is ever re-rendered.
 *
 * Erasable TypeScript only (no enums / parameter properties) so
 * scripts/test-silence-detection.mjs can run it with Node's type stripping.
 */

// ── Tunable constants ───────────────────────────────────────────────────────

/** Percentile of window loudness taken as the room's noise floor (0–1). */
export const NOISE_FLOOR_PERCENTILE = 0.1;
/** How far above the noise floor (dB) a window must be to count as sound. */
export const THRESHOLD_MARGIN_DB = 8;
/** Threshold never goes above this (dBFS): loud backgrounds are never "silence". */
export const ABSOLUTE_CEILING_DB = -35;
/** If even the loud end of the clip is quieter than this (dBFS), do nothing. */
export const MIN_ACTIVITY_DB = -45;
/** Percentile used for the activity check above (0–1). */
export const ACTIVITY_PERCENTILE = 0.9;
/** Silent stretches separated by a sound shorter than this are one silence. */
export const MERGE_GAP_MS = 100;
/** Only silences at least this long are considered. */
export const MIN_SILENCE_MS = 900;
/** Silence kept after speech ends, before the cut starts. */
export const PAD_AFTER_SPEECH_MS = 100;
/** Silence kept before speech resumes, after the cut ends. */
export const PAD_BEFORE_SPEECH_MS = 150;
/** A cut result may never leave less video than this. */
export const MIN_RESULT_MS = 5000;
/** At most this many cuts; the longest silences win. */
export const MAX_CUTS = 5;
/** Videos longer than this are skipped entirely. */
export const MAX_VIDEO_MS = 180_000;

// ── Sensitivity presets (Review sheet) ──────────────────────────────────────

export type Sensitivity = "gentle" | "normal" | "tight";
export const DEFAULT_SENSITIVITY: Sensitivity = "normal";
/**
 * Minimum silence length and loudness margin per preset. Tighter cuts shorter
 * pauses and counts slightly louder audio as silence. Normal equals the
 * defaults above.
 */
export const SENSITIVITY_PRESETS: Record<
  Sensitivity,
  { minSilenceMs: number; thresholdMarginDb: number }
> = {
  gentle: { minSilenceMs: 1200, thresholdMarginDb: 6 },
  normal: { minSilenceMs: MIN_SILENCE_MS, thresholdMarginDb: THRESHOLD_MARGIN_DB },
  tight: { minSilenceMs: 600, thresholdMarginDb: 10 },
};

// ── Types ───────────────────────────────────────────────────────────────────

export type TimeRange = { startMs: number; endMs: number; lengthMs: number };

export type Silence = TimeRange & {
  /** True when this silence became one of the proposed cuts. */
  cut: boolean;
};

export type SkipReason =
  | "no_windows"
  | "too_long"
  | "too_short"
  | "no_activity";

export type SilenceDetectionOptions = {
  /** Real clip duration; defaults to windows.length * windowMs. */
  durationMs?: number;
  noiseFloorPercentile?: number;
  thresholdMarginDb?: number;
  absoluteCeilingDb?: number;
  minActivityDb?: number;
  activityPercentile?: number;
  mergeGapMs?: number;
  minSilenceMs?: number;
  padAfterSpeechMs?: number;
  padBeforeSpeechMs?: number;
  minResultMs?: number;
  maxCuts?: number;
  maxVideoMs?: number;
};

export type SilenceDetectionResult = {
  /** Every silence of at least minSilenceMs, in time order. */
  silences: Silence[];
  /** The proposed cuts (silence minus padding), in time order. */
  cuts: TimeRange[];
  /** Ranges to keep, in time order. One full-length range when nothing is cut. */
  keepRanges: TimeRange[];
  /** Total milliseconds removed by the cuts. */
  savedMs: number;
  noiseFloorDb: number;
  thresholdDb: number;
  /** Why nothing was analyzed or proposed, or null. */
  skipReason: SkipReason | null;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function range(startMs: number, endMs: number): TimeRange {
  return { startMs, endMs, lengthMs: endMs - startMs };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1));
  return sorted[idx]!;
}

function empty(
  durationMs: number,
  noiseFloorDb: number,
  thresholdDb: number,
  skipReason: SkipReason | null,
): SilenceDetectionResult {
  return {
    silences: [],
    cuts: [],
    keepRanges: durationMs > 0 ? [range(0, durationMs)] : [],
    savedMs: 0,
    noiseFloorDb,
    thresholdDb,
    skipReason,
  };
}

// ── Detection ───────────────────────────────────────────────────────────────

export function detectSilences(
  windows: number[],
  windowMs: number,
  options: SilenceDetectionOptions = {},
): SilenceDetectionResult {
  const noiseFloorPercentile = options.noiseFloorPercentile ?? NOISE_FLOOR_PERCENTILE;
  const thresholdMarginDb = options.thresholdMarginDb ?? THRESHOLD_MARGIN_DB;
  const absoluteCeilingDb = options.absoluteCeilingDb ?? ABSOLUTE_CEILING_DB;
  const minActivityDb = options.minActivityDb ?? MIN_ACTIVITY_DB;
  const activityPercentile = options.activityPercentile ?? ACTIVITY_PERCENTILE;
  const mergeGapMs = options.mergeGapMs ?? MERGE_GAP_MS;
  const minSilenceMs = options.minSilenceMs ?? MIN_SILENCE_MS;
  const padAfterSpeechMs = options.padAfterSpeechMs ?? PAD_AFTER_SPEECH_MS;
  const padBeforeSpeechMs = options.padBeforeSpeechMs ?? PAD_BEFORE_SPEECH_MS;
  const minResultMs = options.minResultMs ?? MIN_RESULT_MS;
  const maxCuts = options.maxCuts ?? MAX_CUTS;
  const maxVideoMs = options.maxVideoMs ?? MAX_VIDEO_MS;

  const values = windows.filter((v) => Number.isFinite(v));
  if (values.length === 0 || !(windowMs > 0)) {
    return empty(0, 0, 0, "no_windows");
  }

  const durationMs = options.durationMs ?? windows.length * windowMs;

  const sorted = [...values].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, noiseFloorPercentile);
  const thresholdDb = Math.min(absoluteCeilingDb, noiseFloorDb + thresholdMarginDb);

  if (durationMs > maxVideoMs) {
    return empty(durationMs, noiseFloorDb, thresholdDb, "too_long");
  }
  if (durationMs <= minResultMs) {
    return empty(durationMs, noiseFloorDb, thresholdDb, "too_short");
  }
  // Nothing loud anywhere (muted or near-silent audio track): cutting
  // "silence" would remove almost the whole video.
  if (percentile(sorted, activityPercentile) < minActivityDb) {
    return empty(durationMs, noiseFloorDb, thresholdDb, "no_activity");
  }

  // 1. Runs of consecutive quiet windows.
  const runs: Array<{ startMs: number; endMs: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= windows.length; i++) {
    const quiet = i < windows.length && Number.isFinite(windows[i]!) && windows[i]! < thresholdDb;
    if (quiet && runStart < 0) {
      runStart = i;
    } else if (!quiet && runStart >= 0) {
      runs.push({ startMs: runStart * windowMs, endMs: Math.min(i * windowMs, durationMs) });
      runStart = -1;
    }
  }

  // 2. Merge runs separated by a very short sound (a click or a breath).
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.startMs - last.endMs <= mergeGapMs) {
      last.endMs = run.endMs;
    } else {
      merged.push({ ...run });
    }
  }

  // 3. Keep only long silences; the cut is the silence minus the padding at each end.
  const candidates = merged
    .filter((r) => r.endMs - r.startMs >= minSilenceMs)
    .map((r) => ({
      silence: range(r.startMs, r.endMs),
      cut: range(r.startMs + padAfterSpeechMs, r.endMs - padBeforeSpeechMs),
    }))
    .filter((c) => c.cut.lengthMs > 0);

  // 4. At most maxCuts, longest silences first.
  let chosen = [...candidates]
    .sort((a, b) => b.cut.lengthMs - a.cut.lengthMs)
    .slice(0, Math.max(0, maxCuts));

  // 5. Never leave less than minResultMs: drop the smallest cuts first.
  const remainingFor = (list: typeof chosen) =>
    durationMs - list.reduce((sum, c) => sum + c.cut.lengthMs, 0);
  while (chosen.length > 0 && remainingFor(chosen) < minResultMs) {
    let smallest = 0;
    for (let i = 1; i < chosen.length; i++) {
      if (chosen[i]!.cut.lengthMs < chosen[smallest]!.cut.lengthMs) smallest = i;
    }
    chosen = chosen.filter((_, i) => i !== smallest);
  }
  chosen.sort((a, b) => a.cut.startMs - b.cut.startMs);

  // 6. Keep ranges are the complement of the cuts.
  const keepRanges: TimeRange[] = [];
  let cursor = 0;
  for (const c of chosen) {
    if (c.cut.startMs > cursor) keepRanges.push(range(cursor, c.cut.startMs));
    cursor = c.cut.endMs;
  }
  if (cursor < durationMs) keepRanges.push(range(cursor, durationMs));

  const chosenStarts = new Set(chosen.map((c) => c.silence.startMs));
  return {
    silences: candidates
      .map((c) => ({ ...c.silence, cut: chosenStarts.has(c.silence.startMs) }))
      .sort((a, b) => a.startMs - b.startMs),
    cuts: chosen.map((c) => c.cut),
    keepRanges,
    savedMs: chosen.reduce((sum, c) => sum + c.cut.lengthMs, 0),
    noiseFloorDb,
    thresholdDb,
    skipReason: null,
  };
}
