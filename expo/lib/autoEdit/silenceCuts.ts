/**
 * Silence planner: the existing detector (lib/silenceDetection.ts) wrapped so each
 * cut becomes one silenceCut decision. Same cuts as before, so the keep ranges
 * derived from the decisions equal detection.keepRanges.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import {
  detectSilences,
  type SilenceDetectionOptions,
  type SilenceDetectionResult,
} from "../silenceDetection.ts";
import { makeDecision, type Decision } from "./decisions.ts";

/** One applied silenceCut per detected cut, in time order. */
export function silenceCutsFromDetection(detection: SilenceDetectionResult): Decision[] {
  return detection.cuts.map((c) =>
    makeDecision("silenceCut", c.startMs, c.endMs, {
      payload: { lengthMs: c.lengthMs, ...(c.edge ? { edge: c.edge } : {}) },
    }),
  );
}

export function planSilenceCuts(
  windows: number[],
  windowMs: number,
  durationMs: number,
  options: SilenceDetectionOptions = {},
): { decisions: Decision[]; detection: SilenceDetectionResult } {
  const detection = detectSilences(windows, windowMs, { durationMs, ...options });
  return { decisions: silenceCutsFromDetection(detection), detection };
}
