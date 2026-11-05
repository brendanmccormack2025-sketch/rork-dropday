/**
 * The native side of "merge first": the existing renderer (renderAsync) with no cuts and no overlays. One native
 * render at a time; EVERY step has a time limit and leaves a breadcrumb (start, end, ms), so a step that never
 * comes back is both survived and visible in client_errors. A render that hangs is cancelled.
 */
import { recordBreadcrumb } from "@/lib/clientErrors";
import { DeadlineError, deadline } from "@/lib/deadline";
import { toRenderJson } from "@/lib/editStyles";
import { acquireNativeWithin } from "@/lib/renderAhead";
import { computeRenderSize } from "@/lib/renderAtPost";
import { mergeTimingReport, type MergeTimingReport, type TrackTiming } from "@/lib/mergeTiming";

/** Each clip is read to its end: the renderer clamps a trim end beyond the file's length. */
const WHOLE_FILE_MS = 3_600_000;
/** A merge of a few minutes of video finishes well inside this (then it is cancelled). */
const MERGE_TIMEOUT_MS = 100_000;
/** After the cancel, the native call gets this long to come back before we stop waiting for it. */
const CANCEL_GRACE_MS = 8_000;
/** The other render (ahead of time) gets this long to finish before the merge gives up waiting for its turn. */
const NATIVE_WAIT_MS = 30_000;
const SIZE_MS = 6_000;
const MODULE_MS = 10_000;
const PROBE_MS = 6_000;

let crumbs = 0;
/** A breadcrumb for one step (names are unique per call: breadcrumbs are otherwise recorded once per session). */
function crumb(name: string, data: Record<string, unknown> = {}): void {
  recordBreadcrumb(`merge: ${name} #${++crumbs}`, data);
}

/** Run one step with its own limit and breadcrumbs. */
async function step<T>(name: string, ms: number, onStage: (s: string) => void, fn: () => Promise<T>, data: Record<string, unknown> = {}): Promise<T> {
  onStage(name);
  const t0 = Date.now();
  crumb(`${name} start`, data);
  try {
    const out = await deadline(Promise.resolve().then(fn), ms, name);
    crumb(`${name} end`, { ...data, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    crumb(`${name} FAILED`, { ...data, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 160) });
    throw e;
  }
}

export async function renderMerge(
  uris: string[],
  onProgress: (p: number) => void,
  onStage: (stage: string) => void = () => {},
): Promise<{ uri: string; durationMs: number; timing?: MergeTimingReport | null }> {
  crumb("begin", { clips: uris.length });
  // the size comes from the first frame; if that never answers, a portrait default is used
  const { width, height } = await step("reading the first frame", SIZE_MS, onStage, () => computeRenderSize({ id: "m0", uri: uris[0]!, type: "video" })).catch(() => ({ width: 720, height: 1280 }));
  const release = await step("waiting for the native renderer", NATIVE_WAIT_MS, onStage, () => acquireNativeWithin(NATIVE_WAIT_MS, "waiting for the native renderer"));
  let subscription: { remove(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let cancel: () => void = () => {};
  try {
    const mod = await step("loading the renderer", MODULE_MS, onStage, () => import("@/modules/video-render"));
    cancel = () => {
      try {
        mod.cancelRender();
      } catch {
        // best effort
      }
    };
    subscription = mod.addRenderProgressListener((e) => onProgress(e.progress));
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, MERGE_TIMEOUT_MS);
    const json = toRenderJson({
      version: 1,
      clips: uris.map((uri) => ({ uri, trimStartMs: 0, trimEndMs: WHOLE_FILE_MS })),
      overlays: [],
    });
    // A plain concatenation: no dip in the audio at the joins (build 1.0.4; older builds ignore the option).
    let result: { uri: string; sizeBytes: number; actualDurationMs: number };
    try {
      result = await step("rendering", MERGE_TIMEOUT_MS + CANCEL_GRACE_MS, onStage, () => mod.renderAsync(json, { width, height, reframe: "fit", bitrate: 3_500_000, punchIn: false, seamFades: false }), { clips: uris.length });
    } catch (e) {
      if (e instanceof DeadlineError) cancel();   // the native call never came back: tell it to stop
      throw e;
    }
    if (timedOut) throw new Error("the merge took too long");
    if (!(result.sizeBytes > 0) || !(result.actualDurationMs > 0)) throw new Error("the merged file is empty");
    // The render has finished writing. Measure the file and the parts (1.0.4 builds): the numbers go to the log
    // and, when something is off, to client_errors by the editor. All probes run at once, each with its own limit.
    let timing: MergeTimingReport | null = null;
    try {
      onStage("measuring the result");
      const probe = async (u: string): Promise<TrackTiming | null> =>
        (await deadline(Promise.resolve(mod.probeTimingAsync(u)), PROBE_MS, "measuring the result").catch(() => null)) as TrackTiming | null;
      const [merged, ...sources] = await Promise.all([probe(result.uri), ...uris.map(probe)]);
      timing = mergeTimingReport(sources, merged ?? null, uris.length - 1);
      if (timing) console.log("[merge] timing", JSON.stringify(timing));
    } catch {
      timing = null;
    }
    crumb("done", { ms: result.actualDurationMs });
    return { uri: result.uri, durationMs: result.actualDurationMs, timing };
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.remove();
    release();
  }
}
