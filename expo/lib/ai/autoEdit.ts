/**
 * Auto-edit pipeline: one video in, the edit to apply out.
 *
 * On-device and deterministic: no network calls, no paid APIs. Steps run in
 * order and only the enabled ones (lib/editorFeatures.ts). Any failure is
 * "no change" (the editor must never be blocked or broken by this).
 *
 * The cut and time logic lives in lib/silenceDetection.ts and lib/editModel.ts;
 * this module only wires them together.
 */
import { FEATURES } from "@/lib/editorFeatures";
import { keepRangesToClips, type EditClip } from "@/lib/editModel";
import {
  detectSilences,
  type SilenceDetectionOptions,
  type SilenceDetectionResult,
} from "@/lib/silenceDetection";
import { getLoudnessAsync } from "@/modules/audio-loudness";

/** Loudness window size read from the native module. */
export const AUTO_EDIT_WINDOW_MS = 20;
/** Cuts that save less than this in total are not applied. */
export const AUTO_EDIT_MIN_SAVED_MS = 1000;

/** The editor's current clip, untrimmed: the whole file. */
export type AutoEditInput = { uri: string; durationMs: number };

export type AutoEditResult =
  | { changed: false; reason: "disabled" | "no_audio" | "nothing_found" | "error" }
  | {
      changed: true;
      /** The edit to apply: clips of the SAME source uri, in order. */
      clips: EditClip[];
      /** Loudness windows, kept by the caller so sensitivity can re-run instantly. */
      windows: number[];
      /** Duration the analysis used (the file's real length). */
      durationMs: number;
      detection: SilenceDetectionResult;
    };

/** Silence step: detection plus the clips it implies. Pure; used for instant re-runs. */
export function planSilenceTrim(
  input: AutoEditInput,
  windows: number[],
  options: SilenceDetectionOptions = {},
): { detection: SilenceDetectionResult; clips: EditClip[] } {
  const detection = detectSilences(windows, AUTO_EDIT_WINDOW_MS, {
    durationMs: input.durationMs,
    ...options,
  });
  return { detection, clips: keepRangesToClips(input.uri, detection.keepRanges) };
}

export { mergeKeepRanges } from "@/lib/silenceDetection";

export async function autoEdit(
  input: AutoEditInput,
  options: SilenceDetectionOptions = {},
): Promise<AutoEditResult> {
  try {
    let result: AutoEditResult = { changed: false, reason: "disabled" };

    // ── Step 1: silence trimming ──
    if (FEATURES.autoTrim) {
      const loudness = await getLoudnessAsync(input.uri, AUTO_EDIT_WINDOW_MS);
      if (!loudness) return { changed: false, reason: "no_audio" };
      const plan = planSilenceTrim(
        { uri: input.uri, durationMs: loudness.durationMs },
        loudness.windows,
        options,
      );
      result =
        plan.detection.savedMs >= AUTO_EDIT_MIN_SAVED_MS
          ? {
            changed: true,
            clips: plan.clips,
            windows: loudness.windows,
            durationMs: loudness.durationMs,
            detection: plan.detection,
          }
          : { changed: false, reason: "nothing_found" };
    }

    // ── Step 2: captions (slot, not implemented; gate on FEATURES.captions) ──
    // ── Step 3: sound effects (slot, not implemented; gate on FEATURES.soundEffects) ──

    return result;
  } catch (e) {
    console.warn("[autoEdit] failed, no change:", (e as Error)?.message ?? e);
    return { changed: false, reason: "error" };
  }
}
