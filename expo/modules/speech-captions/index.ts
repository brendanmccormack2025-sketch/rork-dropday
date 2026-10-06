import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { TranscriptionResult } from "./src/SpeechCaptions.types";

export type { TranscribedWord, TranscriptionResult } from "./src/SpeechCaptions.types";

type SpeechCaptionsNative = {
  transcribeAsync(uri: string, locale?: string | null): Promise<TranscriptionResult | null>;
};

// iOS only. Android and web have no native module, so it resolves to null and
// transcribeAsync returns null there.
const native: SpeechCaptionsNative | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<SpeechCaptionsNative>("SpeechCaptions") : null;

/** False when this build has no SpeechCaptions native module (and always on Android and web). */
export const speechCaptionsInBuild: boolean = native !== null;

/**
 * On-device speech-to-text with word timings for a local video/audio file.
 *
 * Resolves null when there is no audio track, or on platforms without the
 * native module. Rejects with an ERR_SPEECH_* code when the locale has no
 * on-device recognizer, permission is denied, or the audio cannot be read.
 * Never uses server recognition; nothing leaves the phone.
 */
export async function transcribeAsync(
  uri: string,
  locale?: string,
): Promise<TranscriptionResult | null> {
  if (!native) return null;
  return native.transcribeAsync(uri, locale ?? null);
}
