/**
 * Emphasis moments: where a zoom could go. Log only for now: planEmphasis returns
 * zoom decisions already marked reverted (proposals) and the editor never stores
 * them.
 *
 * Scoring is a list of scorers, each returning candidates; their scores add up per
 * moment. A face signal can be added later as one more scorer, with no change here.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { sourceToOutputMs, type EditClip } from "../editModel.ts";
import type { Word } from "../transcription/types.ts";
import { makeDecision, type Decision } from "./decisions.ts";

export type EmphasisContext = {
  /** RMS dBFS per window (modules/audio-loudness). */
  windows: number[];
  windowMs: number;
  words: Word[];
  durationMs: number;
  /** Sounds classified as laughs (never cut): a strong zoom signal. */
  laughs?: Array<{ startMs: number; endMs: number }>;
  /** Below this a frame is silence and never counts toward the loudness baseline (dB). */
  silenceThresholdDb?: number;
  /** Removed footage (source time): never counts toward the loudness baseline. */
  cuts?: Array<{ startMs: number; endMs: number }>;
};
export type EmphasisCandidate = {
  sourceMs: number;
  score: number;
  reason: string;
  /** Candidates of one kind count once per moment (the strongest). Defaults to the reason. */
  kind?: string;
};
export type EmphasisScorer = (ctx: EmphasisContext) => EmphasisCandidate[];

export const EMPHASIS_BASELINE_MS = 2000;
export const EMPHASIS_LOOK_MS = 200;
export const EMPHASIS_JUMP_DB = 6;
export const EMPHASIS_PAUSE_MS = 500;
export const EMPHASIS_MIN_GAP_MS = 3500;
export const EMPHASIS_ONE_PER_MS = 5000;
export const EMPHASIS_ZOOM_MS = 1200;
/** A laugh scores this much, on a scale where a loudness jump or a pause is at most 1. */
export const EMPHASIS_LAUGH_SCORE = 2;
/** Windows quieter than this are not speech and do not count toward the baseline. */
const SPEECH_FLOOR_DB = -55;
const STEP_MS = 100;
const MERGE_MS = 400;
/** One moment never spans more than this, however long the loud stretch. */
const MAX_MOMENT_SPAN_MS = 1500;

/** Mean loudness of the windows that count: not silent, not inside removed footage. */
function mean(
  windows: number[],
  windowMs: number,
  from: number,
  to: number,
  floorDb: number,
  cuts: Array<{ startMs: number; endMs: number }>,
): { avg: number; used: number } {
  let sum = 0;
  let used = 0;
  for (let i = Math.max(0, from); i < Math.min(windows.length, to); i++) {
    const v = windows[i]!;
    const t = i * windowMs;
    if (!Number.isFinite(v) || v <= floorDb) continue;
    if (cuts.some((c) => t >= c.startMs && t < c.endMs)) continue;
    sum += v;
    used++;
  }
  return { avg: used ? sum / used : -100, used };
}

/**
 * (a) A jump in loudness against the rolling ~2 s before it. The baseline ignores
 * silent frames and removed footage, so speech starting after silence is not a jump.
 */
export const loudnessJumpScorer: EmphasisScorer = ({ windows, windowMs, silenceThresholdDb, cuts }) => {
  const floorDb = silenceThresholdDb ?? SPEECH_FLOOR_DB;
  const removed = cuts ?? [];
  const out: EmphasisCandidate[] = [];
  const baseN = Math.round(EMPHASIS_BASELINE_MS / windowMs);
  const lookN = Math.max(1, Math.round(EMPHASIS_LOOK_MS / windowMs));
  const stepN = Math.max(1, Math.round(STEP_MS / windowMs));
  for (let i = baseN; i + lookN <= windows.length; i += stepN) {
    const base = mean(windows, windowMs, i - baseN, i, floorDb, removed);
    if (base.used < baseN * 0.3) continue;
    const now = mean(windows, windowMs, i, i + lookN, floorDb, removed);
    const jump = now.avg - base.avg;
    if (now.used >= lookN * 0.5 && jump >= EMPHASIS_JUMP_DB) {
      out.push({
        sourceMs: i * windowMs,
        score: Math.min(1, jump / (EMPHASIS_JUMP_DB * 2)),
        reason: `loudness +${jump.toFixed(1)} dB`,
        kind: "loudness",
      });
    }
  }
  return out;
};

/** (b) A line that starts after a pause longer than 500 ms. */
export const pauseStartScorer: EmphasisScorer = ({ words }) => {
  const out: EmphasisCandidate[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.startMs - words[i - 1]!.endMs;
    if (gap > EMPHASIS_PAUSE_MS) {
      out.push({
        sourceMs: words[i]!.startMs,
        score: 1,
        reason: `line after ${Math.round(gap)} ms pause`,
        kind: "pause",
      });
    }
  }
  return out;
};

/** (c) A laugh the classifier found: strong weight. */
export const laughScorer: EmphasisScorer = ({ laughs }) =>
  (laughs ?? []).map((l) => ({ sourceMs: l.startMs, score: EMPHASIS_LAUGH_SCORE, reason: "laugh", kind: "laugh" }));

export const DEFAULT_EMPHASIS_SCORERS: EmphasisScorer[] = [loudnessJumpScorer, pauseStartScorer, laughScorer];

type Moment = { sourceMs: number; score: number; reasons: string[] };

/**
 * Candidates within 400 ms of each other are one moment. Each reason KIND counts
 * once per moment, using its strongest candidate, so a stretch of loud windows is
 * not scored (or listed) once per window.
 */
export function scoreEmphasis(
  ctx: EmphasisContext,
  scorers: EmphasisScorer[] = DEFAULT_EMPHASIS_SCORERS,
): Moment[] {
  const candidates = scorers.flatMap((s) => s(ctx)).sort((a, b) => a.sourceMs - b.sourceMs);
  const groups: EmphasisCandidate[][] = [];
  for (const c of candidates) {
    const last = groups[groups.length - 1];
    if (
      last &&
      c.sourceMs - last[last.length - 1]!.sourceMs <= MERGE_MS &&
      c.sourceMs - last[0]!.sourceMs <= MAX_MOMENT_SPAN_MS
    ) {
      last.push(c);
    } else groups.push([c]);
  }
  const moments: Moment[] = groups.map((group) => {
    const best = new Map<string, EmphasisCandidate>();
    for (const c of group) {
      const kind = c.kind ?? c.reason;
      const current = best.get(kind);
      if (!current || c.score > current.score) best.set(kind, c);
    }
    const kept = [...best.values()];
    const strongest = kept.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      sourceMs: strongest.sourceMs,
      score: kept.reduce((sum, c) => sum + c.score, 0),
      reasons: kept.map((c) => c.reason),
    };
  });
  const maxCount = Math.floor(ctx.durationMs / EMPHASIS_ONE_PER_MS);
  const chosen: Moment[] = [];
  for (const m of [...moments].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxCount) break;
    if (chosen.every((c) => Math.abs(c.sourceMs - m.sourceMs) >= EMPHASIS_MIN_GAP_MS)) {
      chosen.push({ sourceMs: m.sourceMs, score: m.score, reasons: m.reasons });
    }
  }
  return chosen.sort((a, b) => a.sourceMs - b.sourceMs);
}

export function planEmphasis(ctx: EmphasisContext, scorers?: EmphasisScorer[]): Decision[] {
  return scoreEmphasis(ctx, scorers).map((m) =>
    makeDecision("zoom", m.sourceMs, Math.min(ctx.durationMs, m.sourceMs + EMPHASIS_ZOOM_MS), {
      payload: { scale: 1.15, centerX: 0.5, centerY: 0.5, score: m.score, reasons: m.reasons },
      state: "reverted",
    }),
  );
}

/** The log line's entries: [{sourceMs, outputMs, score, reasons[]}]. */
export function emphasisLogEntries(
  decisions: Decision[],
  clips: EditClip[],
  sourceUri: string,
): Array<{ sourceMs: number; outputMs: number | null; score: number; reasons: string[] }> {
  return decisions.map((d) => {
    const p = d.payload as { score: number; reasons: string[] };
    return {
      sourceMs: d.sourceStartMs,
      outputMs: sourceToOutputMs(clips, d.sourceStartMs, sourceUri),
      score: Math.round(p.score * 100) / 100,
      reasons: p.reasons,
    };
  });
}
