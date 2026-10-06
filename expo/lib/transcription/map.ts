/**
 * Native transcription outcome -> TranscriptResult. Pure; erasable TypeScript only so
 * scripts/test-transcript-reliability.mjs can run it with Node's type stripping.
 *
 * A recognizer error is NEVER an empty transcript: it is 'error' with the native
 * error code (denied and unavailable keep their own status, also with the code).
 */
import type { TranscriptResult } from "./types.ts";

const UNAVAILABLE_CODES = new Set([
  "ERR_SPEECH_ON_DEVICE_UNAVAILABLE",
  "ERR_SPEECH_LOCALE_UNSUPPORTED",
  "ERR_SPEECH_UNAVAILABLE",
]);

export type NativeTranscription = {
  words: Array<{ text: string; startMs: number; endMs: number; confidence: number }>;
  onDevice: boolean;
};

/** null = the file has no audio track (the native module's only way to say so). */
export function mapTranscription(result: NativeTranscription | null): TranscriptResult {
  if (!result) return { status: "ok", words: [] };
  if (!result.onDevice) return { status: "unavailable", code: "NOT_ON_DEVICE", message: "not on-device" };
  return {
    status: "ok",
    words: result.words.map((w) => ({
      text: w.text,
      startMs: w.startMs,
      endMs: w.endMs,
      confidence: w.confidence > 0 ? w.confidence : undefined,
    })),
  };
}

export function mapTranscribeError(e: unknown): TranscriptResult {
  const code = (e as { code?: string } | null)?.code ?? "ERR_SPEECH_UNKNOWN";
  const message = e instanceof Error ? e.message : String(e);
  if (code === "ERR_SPEECH_NOT_AUTHORIZED") return { status: "denied", code, message };
  if (UNAVAILABLE_CODES.has(code)) return { status: "unavailable", code, message };
  return { status: "error", code, message };
}
