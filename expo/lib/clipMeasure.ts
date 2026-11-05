/** The native side of lib/clipBounds.ts: the real length of a recorded file, from its track timing (probeTimingAsync). */
import { measureAndSanitize, realLengthFromTiming, type BoundedClip } from "@/lib/clipBounds";
import { probeTimingAsync } from "@/modules/video-render";

/** The playable length of a file in ms, or null when this build cannot measure it (or the probe failed). */
export async function probeFileLengthMs(uri: string): Promise<number | null> {
  try {
    return realLengthFromTiming(await probeTimingAsync(uri));
  } catch {
    return null;
  }
}

/** Clips with their files measured, every end clamped to its file, empty clips dropped. Never throws. */
export function measureClips<T extends BoundedClip>(clips: T[], timeoutMs?: number): Promise<T[]> {
  return measureAndSanitize(clips, probeFileLengthMs, timeoutMs);
}
