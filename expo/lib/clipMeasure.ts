/** The native side of lib/clipBounds.ts: the real length of a recorded file, from its track timing (probeTimingAsync). */
import { fileLengthMs, measureAndSanitize, measureFiles, realLengthFromTiming, type BoundedClip } from "@/lib/clipBounds";
import { recordBreadcrumb } from "@/lib/clientErrors";
import { probeTimingAsync } from "@/modules/video-render";

/** All files are measured at once; one that does not answer by then is left unmeasured (its own numbers stay). */
export const MEASURE_TIMEOUT_MS = 2_500;

let crumbs = 0;

/** The playable length of a file in ms, or null when this build cannot measure it (or the probe failed). */
export async function probeFileLengthMs(uri: string): Promise<number | null> {
  try {
    return realLengthFromTiming(await probeTimingAsync(uri));
  } catch {
    return null;
  }
}

/** A prober that leaves a breadcrumb per clip (index, ms it took, length found). */
function loggedProbe(clips: BoundedClip[]): (uri: string) => Promise<number | null> {
  const index = new Map<string, number>();
  clips.forEach((c, i) => {
    if (c.uri && !index.has(c.uri)) index.set(c.uri, i);
  });
  return async (uri) => {
    const t0 = Date.now();
    const len = await probeFileLengthMs(uri);
    recordBreadcrumb(`measure clip ${index.get(uri) ?? "?"} #${++crumbs}`, { ms: Date.now() - t0, lengthMs: len });
    return len;
  };
}

/** Clips with their files measured (in parallel, each file once), every end clamped, empty clips dropped. Never throws. */
export function measureClips<T extends BoundedClip>(clips: T[], timeoutMs: number = MEASURE_TIMEOUT_MS): Promise<T[]> {
  return measureAndSanitize(clips, loggedProbe(clips), timeoutMs);
}

/** Start measuring in the background (the camera does this as each take ends), so the editor opens at once. */
export function warmFileLengths(clips: BoundedClip[]): void {
  if (clips.every((c) => c.type === "image" || !c.uri || fileLengthMs(c.uri) !== undefined)) return;
  void measureFiles(clips, loggedProbe(clips), MEASURE_TIMEOUT_MS).catch(() => {});
}
