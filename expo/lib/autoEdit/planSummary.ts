/**
 * What the AI's plan does to a video, in numbers (for the breadcrumbs), and the guard that keeps it from eating a merged
 * multi-clip recording: a plan that would cut more than MAX_AUTO_CUT_FRACTION of it is not applied automatically.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { effectiveCutRanges, isActiveCut, keepRangesOf, type DecisionType, type EditState } from "./decisions.ts";

/** More than this share removed from a merged multi-clip video is not applied automatically. */
export const MAX_AUTO_CUT_FRACTION = 0.6;

const RULES: DecisionType[] = ["silenceCut", "hookTrim", "fillerCut", "umCut"];

export type PlanSummary = {
  sourceMs: number;
  /** What stays after every applied cut. */
  keptMs: number;
  removedMs: number;
  /** removedMs / sourceMs (0..1). */
  removedFraction: number;
  /** Applied cut decisions (all rules, user cuts included). */
  cuts: number;
  /** Per rule: how many cuts and how much each removes on its own (rules can overlap, so these may add up to more than removedMs). */
  rules: Record<string, { cuts: number; ms: number }>;
};

export function summarizePlan(state: EditState, sourceMs: number): PlanSummary {
  const keptMs = keepRangesOf(state, sourceMs).reduce((n, k) => n + (k.endMs - k.startMs), 0);
  const removedMs = Math.max(0, sourceMs - keptMs);
  const rules: PlanSummary["rules"] = {};
  for (const type of RULES) {
    const ranges = effectiveCutRanges(state, type);
    rules[type] = {
      cuts: state.decisions.filter((d) => d.type === type && isActiveCut(state, d)).length,
      ms: Math.round(ranges.reduce((n, r) => n + Math.max(0, Math.min(sourceMs, r.endMs) - Math.max(0, r.startMs)), 0)),
    };
  }
  return {
    sourceMs: Math.round(sourceMs),
    keptMs: Math.round(keptMs),
    removedMs: Math.round(removedMs),
    removedFraction: sourceMs > 0 ? Math.round((removedMs / sourceMs) * 1000) / 1000 : 0,
    cuts: state.decisions.filter((d) => isActiveCut(state, d)).length,
    rules,
  };
}

/** True when the plan must not be applied automatically: a merged multi-clip video of which it would cut too much. */
export function blocksAutoCuts(args: { sourceMs: number; keptMs: number; multiClip: boolean; maxFraction?: number }): boolean {
  if (!args.multiClip || !(args.sourceMs > 0)) return false;
  const removed = (args.sourceMs - args.keptMs) / args.sourceMs;
  return removed > (args.maxFraction ?? MAX_AUTO_CUT_FRACTION);
}

/** The clips as the breadcrumbs show them: the end of the uri, the trim and the length each carries. */
export function describeClips(clips: ReadonlyArray<{ uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number }>): Array<{ uri: string; trimStart: number; trimEnd: number | null; durationMs: number | null }> {
  return clips.map((c) => ({ uri: c.uri.slice(-20), trimStart: Math.round(c.trimStartMs ?? 0), trimEnd: c.trimEndMs === undefined ? null : Math.round(c.trimEndMs), durationMs: c.durationMs === undefined ? null : Math.round(c.durationMs) }));
}

/** The source ranges the plan cuts, [start, end] in ms of the file the plan was made on (merged ranges, sorted). */
export function cutRangesOf(state: EditState): Array<[number, number]> {
  const sorted = effectiveCutRanges(state).map((r) => [Math.round(r.startMs), Math.round(r.endMs)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
