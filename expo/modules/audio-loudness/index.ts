import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { LoudnessResult } from "./src/AudioLoudness.types";

export type { LoudnessResult } from "./src/AudioLoudness.types";

type AudioLoudnessNative = {
  getLoudnessAsync(uri: string, windowMs: number): Promise<LoudnessResult | null>;
};

// iOS only. Android and web have no native module, so it resolves to null and
// getLoudnessAsync returns null there.
const native: AudioLoudnessNative | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<AudioLoudnessNative>("AudioLoudness") : null;

/**
 * Loudness over time of a local video/audio file's first audio track.
 *
 * Resolves null when there is no audio track, or on platforms without the
 * native module. Rejects with an ERR_LOUDNESS_* code on bad input, a file
 * that is missing, longer than 4 minutes, or unreadable.
 */
export async function getLoudnessAsync(
  uri: string,
  windowMs: number,
): Promise<LoudnessResult | null> {
  if (!native) return null;
  return native.getLoudnessAsync(uri, windowMs);
}
