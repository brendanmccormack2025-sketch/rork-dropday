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
export const MIN_SILENCE_MS = 500;
/** Silence kept after speech ends, before the cut starts. */
export const PAD_AFTER_SPEECH_MS = 30;
/** Silence kept before speech resumes, after the cut ends. */
export const PAD_BEFORE_SPEECH_MS = 50;
/** A cut result may never leave less video than this. */
export const MIN_RESULT_MS = 3000;
/** At most this many cuts; the longest silences win. */
export const MAX_CUTS = 14;
/** No kept piece may be shorter than this; the cut that created it is dropped. */
export const MIN_KEEP_MS = 350;
/** A leading or trailing silence qualifies from this length (no seam, so lower than MIN_SILENCE_MS). */
export const EDGE_MIN_SILENCE_MS = 250;
/** Videos longer than this are skipped entirely. */
export const MAX_VIDEO_MS = 180_000;
/** Soft onsets: when speech resumes, the cut end steps back at most this far. */
export const ONSET_LOOKBACK_MS = 40;
/** ...while loudness is still rising and above the noise floor by more than this. */
export const ONSET_MARGIN_DB = 3;

// ── Sensitivity presets (Review sheet) ──────────────────────────────────────

export type Sensitivity = "gentle" | "normal" | "tight";
export const DEFAULT_SENSITIVITY: Sensitivity = "tight";
/**
 * Minimum silence length and loudness margin per preset. Tighter cuts shorter
 * pauses and counts slightly louder audio as silence. Normal equals the
 * defaults above.
 */
export const SENSITIVITY_PRESETS: Record<
  Sensitivity,
  { minSilenceMs: number; thresholdMarginDb: number }
> = {
  gentle: { minSilenceMs: 800, thresholdMarginDb: 6 },
  normal: { minSilenceMs: MIN_SILENCE_MS, thresholdMarginDb: THRESHOLD_MARGIN_DB },
  tight: { minSilenceMs: 300, thresholdMarginDb: 10 },
};

// ── Types ───────────────────────────────────────────────────────────────────

export type TimeRange = { startMs: number; endMs: number; lengthMs: number };

/** A proposed cut. `edge` marks the head ("start") and tail ("end") trims: they make no seam. */
export type Cut = TimeRange & { edge?: "start" | "end" };

export type Silence = TimeRange & {
  /** True when this silence became one of the proposed cuts. */
  cut: boolean;
  edge?: "start" | "end";
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
  minKeepMs?: number;
  edgeMinSilenceMs?: number;
  maxVideoMs?: number;
  /** 0 turns the soft-onset look-back off. */
  onsetLookBackMs?: number;
};

export type SilenceDetectionResult = {
  /** Every silence of at least minSilenceMs, in time order. */
  silences: Silence[];
  /** The proposed cuts (silence minus padding), in time order. Head and tail trims have `edge` set. */
  cuts: Cut[];
  /**
   * Ranges to keep, in time order. One full-length range when nothing is cut.
   * There are cuts.length + 1 of them, minus one for a head trim and one for a tail trim.
   */
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

/**
 * Median of each window and its two neighbours: one noisy window can no longer
 * split a silence, and edges stay where they are. Non-finite windows are kept.
 */
function smooth3(w: number[]): number[] {
  return w.map((v, i) => {
    if (!Number.isFinite(v)) return v;
    const a = Number.isFinite(w[i - 1]) ? w[i - 1]! : v;
    const b = Number.isFinite(w[i + 1]) ? w[i + 1]! : v;
    return Math.max(Math.min(a, v), Math.min(Math.max(a, v), b));
  });
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
  const minKeepMs = options.minKeepMs ?? MIN_KEEP_MS;
  const edgeMinSilenceMs = options.edgeMinSilenceMs ?? EDGE_MIN_SILENCE_MS;
  const maxVideoMs = options.maxVideoMs ?? MAX_VIDEO_MS;
  const onsetLookBackMs = options.onsetLookBackMs ?? ONSET_LOOKBACK_MS;

  // All timing below is in ms, from the window length: windowMs may be 20 or 50.
  const sm = smooth3(windows);
  const values = sm.filter((v) => Number.isFinite(v));
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

  // 1. Runs of consecutive quiet windows. A run starts at the first window below
  //    the threshold and ends at the first window above it; if speech resumes,
  //    the end steps back over a soft consonant onset (still rising, still above
  //    the noise floor + ONSET_MARGIN_DB) so it is kept.
  const lookBackWindows = Math.floor(onsetLookBackMs / windowMs);
  const runs: Array<{ startMs: number; endMs: number; atEnd: boolean }> = [];
  let runStart = -1;
  for (let i = 0; i <= sm.length; i++) {
    const quiet = i < sm.length && Number.isFinite(sm[i]!) && sm[i]! < thresholdDb;
    if (quiet && runStart < 0) {
      runStart = i;
    } else if (!quiet && runStart >= 0) {
      let endIdx = i;
      if (i < sm.length && Number.isFinite(sm[i]!)) {
        let steps = 0;
        while (
          steps < lookBackWindows &&
          endIdx - 1 > runStart &&
          sm[endIdx - 1]! > noiseFloorDb + ONSET_MARGIN_DB &&
          sm[endIdx - 1]! <= sm[endIdx]!
        ) {
          endIdx--;
          steps++;
        }
      }
      runs.push({
        startMs: runStart * windowMs,
        endMs: Math.min(endIdx * windowMs, durationMs),
        atEnd: i === sm.length,
      });
      runStart = -1;
    }
  }

  // 2. Merge runs separated by a very short sound (a click or a breath).
  const merged: Array<{ startMs: number; endMs: number; atEnd: boolean }> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.startMs - last.endMs <= mergeGapMs) {
      last.endMs = run.endMs;
      last.atEnd = run.atEnd;
    } else {
      merged.push({ ...run });
    }
  }

  // 3. Keep only long silences; the cut is the silence minus the padding at each end.
  //    A silence at the very start (head) or end (tail) of the clip makes no seam:
  //    it qualifies from edgeMinSilenceMs, the first clip then starts
  //    padBeforeSpeechMs before the first speech and the last ends padAfterSpeechMs
  //    after the last. A silence covering the whole clip is never cut.
  const candidates = merged
    .filter((r) => !(r.startMs === 0 && r.atEnd))
    .map((r) => {
      const edge: "start" | "end" | undefined = r.startMs === 0 ? "start" : r.atEnd ? "end" : undefined;
      const cutStart = edge === "start" ? 0 : r.startMs + padAfterSpeechMs;
      const cutEnd = edge === "end" ? durationMs : r.endMs - padBeforeSpeechMs;
      return {
        silence: range(r.startMs, r.endMs),
        cut: range(cutStart, cutEnd),
        edge,
      };
    })
    .filter((c) => c.silence.lengthMs >= (c.edge ? edgeMinSilenceMs : minSilenceMs))
    .filter((c) => c.cut.lengthMs > 0);

  // 4. At most maxCuts interior cuts, longest silences first. Head and tail trims
  //    are extra: they do not count toward maxCuts.
  let chosen = [
    ...candidates
      .filter((c) => !c.edge)
      .sort((a, b) => b.cut.lengthMs - a.cut.lengthMs)
      .slice(0, Math.max(0, maxCuts)),
    ...candidates.filter((c) => c.edge),
  ];

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

  // 5b. Never keep a piece shorter than minKeepMs: drop the cut that created it
  //     (the shorter of its two neighbours), which merges it into the next piece.
  //     Head and tail trims make no seam, so they are never dropped by this rule.
  for (;;) {
    let dropIndex = -1;
    let cursorMs = 0;
    for (let i = 0; i <= chosen.length; i++) {
      const pieceEnd = i < chosen.length ? chosen[i]!.cut.startMs : durationMs;
      if (pieceEnd - cursorMs < minKeepMs && pieceEnd > cursorMs) {
        const neighbours = [i - 1, i].filter((n) => n >= 0 && n < chosen.length && !chosen[n]!.edge);
        if (neighbours.length > 0) {
          dropIndex = neighbours.reduce((best, n) =>
            chosen[n]!.cut.lengthMs < chosen[best]!.cut.lengthMs ? n : best,
          );
          break;
        }
      }
      if (i < chosen.length) cursorMs = chosen[i]!.cut.endMs;
    }
    if (dropIndex < 0) break;
    chosen = chosen.filter((_, i) => i !== dropIndex);
  }

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
      .map((c) => ({ ...c.silence, cut: chosenStarts.has(c.silence.startMs), edge: c.edge }))
      .sort((a, b) => a.startMs - b.startMs),
    cuts: chosen.map((c) => (c.edge ? { ...c.cut, edge: c.edge } : c.cut)),
    keepRanges,
    savedMs: chosen.reduce((sum, c) => sum + c.cut.lengthMs, 0),
    noiseFloorDb,
    thresholdDb,
    skipReason: null,
  };
}

/**
 * Keep ranges after switching some cuts off: a disabled cut merges its two
 * neighbouring keep ranges back into one; a disabled head trim brings the first
 * range back to 0 and a disabled tail trim brings the last range to the end.
 * Pass the detection's `cuts` so edge cuts are understood: keepRanges then has
 * cuts.length + 1 entries minus one per edge cut. Without `cuts` every cut is
 * interior (cuts.length + 1 ranges).
 */
export function mergeKeepRanges(
  keepRanges: Array<{ startMs: number; endMs: number }>,
  cutEnabled: boolean[],
  cuts?: Cut[],
): Array<{ startMs: number; endMs: number }> {
  const edges = cuts ?? [];
  const startEdge = edges[0]?.edge === "start";
  const endEdge = edges[edges.length - 1]?.edge === "end";
  const expected = cutEnabled.length + 1 - (startEdge ? 1 : 0) - (endEdge ? 1 : 0);
  if (keepRanges.length !== expected || keepRanges.length === 0) return keepRanges;

  const out = [{ startMs: keepRanges[0]!.startMs, endMs: keepRanges[0]!.endMs }];
  let next = 1;
  for (let i = 0; i < cutEnabled.length; i++) {
    const edge = edges[i]?.edge;
    if (edge === "start") {
      if (!cutEnabled[i]) out[0]!.startMs = edges[i]!.startMs;
    } else if (edge === "end") {
      if (!cutEnabled[i]) out[out.length - 1]!.endMs = edges[i]!.endMs;
    } else {
      const piece = keepRanges[next++]!;
      if (cutEnabled[i]) out.push({ startMs: piece.startMs, endMs: piece.endMs });
      else out[out.length - 1]!.endMs = piece.endMs;
    }
  }
  return out;
}
