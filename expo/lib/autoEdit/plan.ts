/**
 * The AI's own edit, planned from analysis that is already cached (loudness
 * windows and, when there is one, the transcript). Used by "Reset to AI edit":
 * nothing here reads a file or runs a recognizer.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { SilenceDetectionOptions } from "../silenceDetection.ts";
import type { Word } from "../transcription/types.ts";
import { newEditState, type EditState } from "./decisions.ts";
import { planFillerCuts } from "./fillerCuts.ts";
import { planHookTrim } from "./hookTrim.ts";
import { planSilenceCuts } from "./silenceCuts.ts";

/** Silence cuts that save less than this in total are not applied (as in autoEdit). */
export const AI_EDIT_MIN_SAVED_MS = 1000;
const WINDOW_MS = 20;

export function buildAiEditState(input: {
  uri: string;
  durationMs: number;
  windows: number[];
  silenceOptions?: SilenceDetectionOptions;
  /** The transcript (owner only); without it there are no hook or filler decisions. */
  words?: Word[] | null;
}): EditState {
  const silence = planSilenceCuts(input.windows, WINDOW_MS, input.durationMs, input.silenceOptions);
  const decisions = silence.detection.savedMs >= AI_EDIT_MIN_SAVED_MS ? silence.decisions : [];
  if (input.words) {
    decisions.push(...planHookTrim(input.words, input.durationMs), ...planFillerCuts(input.words));
  }
  return newEditState(input.uri, decisions);
}
