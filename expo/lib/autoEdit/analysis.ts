/**
 * The app's analysis cache (see analysisCache.ts): loudness and transcript, once
 * per source, with a small persistent copy.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { getInfoAsync } from "@/lib/fileSystemCompat";
import { createAnalysisCache } from "@/lib/autoEdit/analysisCache";
import { transcribeClip } from "@/lib/transcription";
import { getLoudnessAsync } from "@/modules/audio-loudness";

/** Same window length the silence detector has always used. */
const LOUDNESS_WINDOW_MS = 20;

export const analysis = createAnalysisCache({
  stat: async (uri) => {
    const info = await getInfoAsync(uri);
    return info.exists ? { uri, size: info.size ?? 0, mtime: info.modificationTime ?? 0 } : null;
  },
  loadLoudness: (uri) => getLoudnessAsync(uri, LOUDNESS_WINDOW_MS),
  transcribe: transcribeClip,
  storage: {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  },
});
