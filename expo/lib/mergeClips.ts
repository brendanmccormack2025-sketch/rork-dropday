/**
 * Merge first: when the editor receives several video clips (camera segments, a multi-select from the
 * camera roll) they are concatenated, in order, into ONE video file before anything else, so the single-source
 * AI pipeline (silence cuts, ums, hook, captions) runs unchanged. The original files are never touched.
 *
 * Pure apart from the injected `render`; erasable TypeScript only so the Node tests can run it.
 */

import { DeadlineError, deadline } from "./deadline.ts";

export type MergeInput = { id?: string; uri: string; type: "image" | "video" };

/** The single clip that replaces the parts. */
export type MergedClip = {
  id: string;
  uri: string;
  type: "video";
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
};

export type MergeResult =
  | { ok: true; clip: MergedClip; mergedFrom: string[]; timing?: unknown }
  | { ok: false; message: string; stage?: string };

export const MERGE_FAILED_TEXT = "Couldn't prepare your video.";
export const MERGE_PREPARING_TEXT = "Preparing your video…";
/** What the creator is told when the merge fails or times out (the editor stays usable). */
export const MERGE_TRY_AGAIN_TEXT = "Couldn't prepare your video. Please try again.";
/** The whole merge (every native step included) gives up after this: there is always a way out of the spinner. */
export const MERGE_TOTAL_TIMEOUT_MS = 150_000;

/** Several clips, all video, and not a saved draft (a draft was merged when it was made). */
export function shouldMerge(clips: ReadonlyArray<Pick<MergeInput, "type">>, opts: { isDraft: boolean }): boolean {
  return !opts.isDraft && clips.length > 1 && clips.every((c) => c.type === "video");
}

/**
 * Concatenate `clips` in order with `render` (the native renderer: no cuts, no overlays). Never throws: any
 * failure (a throw, a rejection, an empty or too-short file) is a result with a message.
 */
export async function mergeVideoClips(args: {
  clips: ReadonlyArray<MergeInput>;
  /** Renders the uris in order into one file; progress is 0..1. */
  render: (uris: string[], onProgress: (p: number) => void, onStage: (stage: string) => void) => Promise<{ uri: string; durationMs: number; timing?: unknown }>;
  onProgress?: (p: number) => void;
  newId: () => string;
  /** Total time limit (ms). */
  timeoutMs?: number;
  /** Called when the limit is hit, to cancel the native work. */
  onTimeout?: () => void;
}): Promise<MergeResult> {
  const uris = args.clips.map((c) => c.uri);
  if (uris.length < 2) return { ok: false, message: "Nothing to merge." };
  let stage = "starting";
  try {
    const out = await deadline(
      Promise.resolve().then(() =>
        args.render(
          uris,
          (p) => {
            try {
              args.onProgress?.(Math.max(0, Math.min(1, p)));
            } catch {
              // progress is cosmetic
            }
          },
          (s) => {
            stage = s;
          },
        ),
      ),
      args.timeoutMs ?? MERGE_TOTAL_TIMEOUT_MS,
      () => stage,
    );
    if (!out || !out.uri || !(out.durationMs > 0)) return { ok: false, message: "The merged video was empty." };
    return {
      ok: true,
      mergedFrom: uris,
      ...(out.timing ? { timing: out.timing } : {}),
      clip: { id: args.newId(), uri: out.uri, type: "video", durationMs: out.durationMs, trimStartMs: 0, trimEndMs: out.durationMs },
    };
  } catch (e) {
    const message = String((e as { message?: unknown } | null)?.message ?? e ?? "unknown error").slice(0, 300);
    const failedStage = e instanceof DeadlineError ? e.stage : ((e as { stage?: unknown } | null)?.stage as string | undefined) ?? stage;
    if (e instanceof DeadlineError) {
      try {
        args.onTimeout?.();
      } catch {
        // best effort
      }
    }
    return { ok: false, message, stage: failedStage };
  }
}
