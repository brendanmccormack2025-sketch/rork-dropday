/**
 * Render-at-post: turn the editor's timeline (cuts) into ONE mp4 on this phone
 * before a ROOT post is published. Never blocks posting: every problem here
 * means "post the old way" (segments + trim_data).
 *
 * No network, no paid API: the native VideoRender module (iOS) does the work.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { isInternalTester } from "@/constants/debug";
import type { EditOverlay } from "@/lib/editModel";
import { toRenderJson } from "@/lib/editStyles";
import { supportsCaptionFont, supportsLineBackgrounds, supportsTextBox } from "@/modules/video-render";
import type { DraftClip } from "@/providers/PostsProvider";

export const RENDER_AT_POST_ENABLED = true;
/** When true, only the owner and internal testers render at post time. Off: the AI editor (burned-in captions) is for everyone. */
export const RENDER_INTERNAL_ONLY = false;
/** Base time allowed for a render (ms); longer videos get more (see renderTimeoutMs). */
export const RENDER_TIMEOUT_MS = 20_000;

/** True when this build has the native VideoRender module (iOS builds with it). */
export function isVideoRenderAvailable(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return requireOptionalNativeModule("VideoRender") != null;
  } catch {
    return false;
  }
}

function isTrimmed(c: DraftClip): boolean {
  const end = c.trimEndMs ?? 0;
  const duration = c.durationMs ?? 0;
  return (c.trimStartMs ?? 0) > 0 || (end > 0 && duration > 0 && end < duration - 50);
}

/**
 * Why this timeline is NOT rendered at post time, in fixed wording, or null when
 * it should be: a ROOT post (never a reaction), an internal account, a build with
 * the native module, all clips video with a known length, and something to
 * render (more than one clip, or a trimmed clip). Drafts never get here.
 */
export function renderSkipReason(args: {
  isRoot: boolean;
  userId: string | null | undefined;
  clips: DraftClip[];
  /** Captions (or other overlays) are burned in: render even when nothing is cut. */
  hasOverlays?: boolean;
}): "module missing" | "not an internal account" | "reaction" | "no cuts" | null {
  if (!RENDER_AT_POST_ENABLED) return "no cuts";
  if (!args.isRoot) return "reaction";
  if (RENDER_INTERNAL_ONLY && !isInternalTester(args.userId)) return "not an internal account";
  const { clips } = args;
  if (clips.length === 0) return "no cuts";
  if (clips.some((c) => c.type !== "video" || !(c.durationMs && c.durationMs > 0))) return "no cuts";
  if (!(clips.length > 1 || clips.some(isTrimmed) || args.hasOverlays)) return "no cuts";
  if (!isVideoRenderAvailable()) return "module missing";
  return null;
}

export function shouldRenderAtPost(args: {
  isRoot: boolean;
  userId: string | null | undefined;
  clips: DraftClip[];
  hasOverlays?: boolean;
}): boolean {
  return renderSkipReason(args) === null;
}

/** Longest side of the rendered video; width and height are even. */
const RENDER_MAX_SIDE = 1280;
/** Advisory only (the native exporter cannot enforce a bitrate). */
const RENDER_BITRATE = 3_500_000;
/** The rendered file may be this much shorter than the edit before it counts as a failed render. */
const DURATION_TOLERANCE_MS = 300;

export type RenderedEdit = {
  /** file:// URI of the finished mp4 in the cache directory. */
  uri: string;
  durationMs: number;
  sizeBytes: number;
};

/** Result of renderForPost: the edit, or why there is none (fixed wording for the diagnostics message). */
export type RenderOutcome =
  | { ok: true; edit: RenderedEdit; renderMs: number }
  | { ok: false; reason: string };

/** Time allowed: RENDER_TIMEOUT_MS, or 0.6 x the edit's length if longer, capped at 60 s. */
export function renderTimeoutMs(editDurationMs: number): number {
  return Math.min(60_000, Math.max(RENDER_TIMEOUT_MS, 0.6 * editDurationMs));
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Output size from the first clip's displayed (orientation-corrected) size, long side <= 1280. */
export async function computeRenderSize(first: DraftClip): Promise<{ width: number; height: number }> {
  try {
    const { getThumbnailAsync } = await import("expo-video-thumbnails");
    const thumb = await getThumbnailAsync(first.uri, { time: first.trimStartMs ?? 0 });
    if (thumb.width > 0 && thumb.height > 0) {
      const scale = Math.min(1, RENDER_MAX_SIDE / Math.max(thumb.width, thumb.height));
      return { width: even(thumb.width * scale), height: even(thumb.height * scale) };
    }
  } catch {
    // fall through to the default portrait size
  }
  return { width: 720, height: 1280 };
}

/** The clips as render instructions (cuts only), and the length of the finished video. */
export function buildRenderEdit(clips: DraftClip[]): {
  edit: Array<{ uri: string; trimStartMs: number; trimEndMs: number }>;
  editMs: number;
} {
  const edit = clips.map((c) => ({
    uri: c.uri,
    trimStartMs: c.trimStartMs ?? 0,
    trimEndMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
  }));
  const editMs = edit.reduce((sum, c) => sum + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
  return { edit, editMs };
}

/** The exact instructions JSON and options used for every render (post time and ahead of time). */
export function renderRequest(
  edit: Array<{ uri: string; trimStartMs: number; trimEndMs: number }>,
  width: number,
  height: number,
  overlays: EditOverlay[] = [],
) {
  return {
    json: toRenderJson({ version: 1, clips: edit, overlays }, { supportsFont: supportsCaptionFont, supportsTextBox, supportsLineBackgrounds }),
    options: { width, height, reframe: "fit" as const, bitrate: RENDER_BITRATE, punchIn: false },
  };
}

/** null when the native result is usable; otherwise the reason (fixed wording). */
export function checkRenderResult(
  result: { sizeBytes: number; actualDurationMs: number },
  editMs: number,
): string | null {
  if (!(result.sizeBytes > 0) || result.actualDurationMs < editMs - DURATION_TOLERANCE_MS) {
    return "output too short";
  }
  return null;
}

/**
 * Render the clips (cuts only, no overlays) into one mp4. Resolves `ok: false`
 * with a reason on ANY problem (module missing, ERR_RENDER_*, timeout, cancel,
 * empty or short output); the caller then posts the old way. Never throws.
 */
export async function renderForPost(
  clips: DraftClip[],
  onProgress: (progress: number) => void,
  overlays: EditOverlay[] = [],
): Promise<RenderOutcome> {
  let subscription: { remove(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let timeoutSeconds = 0;
  try {
    const { addRenderProgressListener, cancelRender, renderAsync } = await import("@/modules/video-render");
    const { edit, editMs } = buildRenderEdit(clips);
    if (editMs <= 0) return { ok: false, reason: "no cuts" };

    const { width, height } = await computeRenderSize(clips[0]!);
    subscription = addRenderProgressListener((e) => onProgress(e.progress));

    const started = Date.now();
    const timeoutMs = renderTimeoutMs(editMs);
    timeoutSeconds = Math.round(timeoutMs / 1000);
    timer = setTimeout(() => {
      timedOut = true;
      cancelRender();
    }, timeoutMs);

    const request = renderRequest(edit, width, height, overlays);
    const result = await renderAsync(request.json, request.options);
    if (timedOut) return { ok: false, reason: `timeout after ${timeoutSeconds} s` };
    if (checkRenderResult(result, editMs)) {
      if (__DEV__) {
        console.log(
          `[render] rejected output: ${result.actualDurationMs} ms, ${result.sizeBytes} bytes, expected ${editMs} ms`,
        );
      }
      return { ok: false, reason: "output too short" };
    }
    if (__DEV__) {
      console.log(
        `[render] ok in ${Date.now() - started} ms: ${width}x${height}, ${result.actualDurationMs} ms, ${(result.sizeBytes / 1048576).toFixed(2)} MB`,
      );
    }
    return {
      ok: true,
      edit: { uri: result.uri, durationMs: result.actualDurationMs, sizeBytes: result.sizeBytes },
      renderMs: Date.now() - started,
    };
  } catch (e) {
    if (__DEV__) {
      const code = (e as { code?: string })?.code;
      console.log(`[render] failed, posting the old way: ${code ?? ""} ${(e as Error)?.message ?? e}`);
    }
    const code = (e as { code?: string })?.code;
    if (timedOut) return { ok: false, reason: `timeout after ${timeoutSeconds} s` };
    if (code === "ERR_RENDER_CANCELLED") return { ok: false, reason: "cancelled" };
    if (code === "ERR_RENDER_TRUNCATED") return { ok: false, reason: "output too short" };
    return { ok: false, reason: `render error ${code ?? "unknown"}` };
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.remove();
  }
}
