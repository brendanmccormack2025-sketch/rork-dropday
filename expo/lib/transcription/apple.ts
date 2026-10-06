/**
 * Apple implementation of transcribeClip: the local speech-captions module
 * (SFSpeechRecognizer with requiresOnDeviceRecognition = true; it fails instead of
 * falling back to server recognition). It reads the video file itself and exports
 * its audio to a temporary m4a on the phone.
 */
import { Platform } from "react-native";

import { speechCaptionsInBuild, transcribeAsync } from "@/modules/speech-captions";
import type { TranscriptResult } from "./types";

const UNAVAILABLE_CODES = new Set([
  "ERR_SPEECH_ON_DEVICE_UNAVAILABLE",
  "ERR_SPEECH_LOCALE_UNSUPPORTED",
  "ERR_SPEECH_UNAVAILABLE",
]);

export async function transcribeWithApple(sourceUri: string): Promise<TranscriptResult> {
  if (Platform.OS !== "ios") return { status: "unavailable", message: "iOS only" };
  if (!speechCaptionsInBuild) {
    return { status: "unavailable", message: "speech-captions not in this build" };
  }
  try {
    const result = await transcribeAsync(sourceUri);
    // With the module present, null means the clip has no audio track: genuinely silent.
    if (!result) return { status: "ok", words: [] };
    if (!result.onDevice) return { status: "unavailable", message: "not on-device" };
    return {
      status: "ok",
      words: result.words.map((w) => ({
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs,
        confidence: w.confidence > 0 ? w.confidence : undefined,
      })),
    };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    const message = e instanceof Error ? e.message : String(e);
    if (code === "ERR_SPEECH_NOT_AUTHORIZED") return { status: "denied", message };
    if (UNAVAILABLE_CODES.has(code)) return { status: "unavailable", message };
    return { status: "error", message };
  }
}
