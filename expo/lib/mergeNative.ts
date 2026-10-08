/**
 * The native side of "merge first": the existing renderer (renderAsync) with no cuts and no overlays. One native
 * render at a time (acquireNative); a render that hangs is cancelled.
 */
import { toRenderJson } from "@/lib/editStyles";
import { acquireNative } from "@/lib/renderAhead";
import { computeRenderSize } from "@/lib/renderAtPost";
import { mergeTimingReport, type MergeTimingReport, type TrackTiming } from "@/lib/mergeTiming";

/** Each clip is read to its end: the renderer clamps a trim end beyond the file's length. */
const WHOLE_FILE_MS = 3_600_000;
/** A merge of a few minutes of video finishes well inside this. */
const MERGE_TIMEOUT_MS = 120_000;

export async function renderMerge(
  uris: string[],
  onProgress: (p: number) => void,
): Promise<{ uri: string; durationMs: number; timing?: MergeTimingReport | null }> {
  const { width, height } = await computeRenderSize({ id: "m0", uri: uris[0]!, type: "video" });
  const release = await acquireNative();
  let subscription: { remove(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    const { addRenderProgressListener, cancelRender, renderAsync, probeTimingAsync } = await import("@/modules/video-render");
    subscription = addRenderProgressListener((e) => onProgress(e.progress));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        cancelRender();
      } catch {
        // best effort
      }
    }, MERGE_TIMEOUT_MS);
    const json = toRenderJson({
      version: 1,
      clips: uris.map((uri) => ({ uri, trimStartMs: 0, trimEndMs: WHOLE_FILE_MS })),
      overlays: [],
    });
    // A plain concatenation: no dip in the audio at the joins (build 1.0.4; older builds ignore the option).
    const result = await renderAsync(json, { width, height, reframe: "fit", bitrate: 3_500_000, punchIn: false, seamFades: false });
    if (timedOut) throw new Error("the merge took too long");
    if (!(result.sizeBytes > 0) || !(result.actualDurationMs > 0)) throw new Error("the merged file is empty");
    // The render has finished writing. Measure the file and the parts (1.0.4 builds): the numbers go to the log
    // and, when something is off, to client_errors by the editor.
    let timing: MergeTimingReport | null = null;
    try {
      const probe = async (u: string): Promise<TrackTiming | null> => (await probeTimingAsync(u).catch(() => null)) as TrackTiming | null;
      const merged = await probe(result.uri);
      const sources = await Promise.all(uris.map(probe));
      timing = mergeTimingReport(sources, merged, uris.length - 1);
      if (timing) console.log("[merge] timing", JSON.stringify(timing));
    } catch {
      timing = null;
    }
    return { uri: result.uri, durationMs: result.actualDurationMs, timing };
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.remove();
    release();
  }
}
