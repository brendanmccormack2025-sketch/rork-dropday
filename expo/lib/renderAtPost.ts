/**
 * Render-at-post: turn the editor's timeline (cuts) into ONE mp4 on this phone
 * before a ROOT post is published. Never blocks posting: every problem here
 * means "post the old way" (segments + trim_data).
 *
 * No network, no paid API: the native VideoRender module (iOS) does the work.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { OWNER_USER_ID } from "@/constants/debug";
import type { DraftClip } from "@/providers/PostsProvider";

export const RENDER_AT_POST_ENABLED = true;
/** When true, only the owner account renders at post time. */
export const RENDER_OWNER_ONLY = true;
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
 * Whether to render this timeline at post time: a ROOT post (never a reaction),
 * not a draft save, all clips are video with a known length, and there is
 * something to render (more than one clip, or a trimmed clip).
 */
export function shouldRenderAtPost(args: {
  isRoot: boolean;
  userId: string | null | undefined;
  clips: DraftClip[];
}): boolean {
  if (!RENDER_AT_POST_ENABLED || !args.isRoot) return false;
  if (RENDER_OWNER_ONLY && (!args.userId || args.userId !== OWNER_USER_ID)) return false;
  const { clips } = args;
  if (clips.length === 0) return false;
  if (clips.some((c) => c.type !== "video" || !(c.durationMs && c.durationMs > 0))) return false;
  if (!(clips.length > 1 || clips.some(isTrimmed))) return false;
  return isVideoRenderAvailable();
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

/** Time allowed: RENDER_TIMEOUT_MS, or 0.6 x the edit's length if longer, capped at 60 s. */
export function renderTimeoutMs(editDurationMs: number): number {
  return Math.min(60_000, Math.max(RENDER_TIMEOUT_MS, 0.6 * editDurationMs));
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Output size from the first clip's displayed (orientation-corrected) size, long side <= 1280. */
async function renderSizeFor(first: DraftClip): Promise<{ width: number; height: number }> {
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

/**
 * Render the clips (cuts only, no overlays) into one mp4. Resolves null on ANY
 * problem (module missing, ERR_RENDER_*, timeout, cancel, empty or short
 * output); the caller then posts the old way. Never throws.
 */
export async function renderForPost(
  clips: DraftClip[],
  onProgress: (progress: number) => void,
): Promise<RenderedEdit | null> {
  let subscription: { remove(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const { addRenderProgressListener, cancelRender, renderAsync } = await import("@/modules/video-render");
    const edit = clips.map((c) => ({
      uri: c.uri,
      trimStartMs: c.trimStartMs ?? 0,
      trimEndMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
    }));
    const editMs = edit.reduce((sum, c) => sum + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
    if (editMs <= 0) return null;

    const { width, height } = await renderSizeFor(clips[0]!);
    subscription = addRenderProgressListener((e) => onProgress(e.progress));

    const started = Date.now();
    const timeoutMs = renderTimeoutMs(editMs);
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      cancelRender();
    }, timeoutMs);

    const result = await renderAsync(JSON.stringify({ version: 1, clips: edit, overlays: [] }), {
      width,
      height,
      reframe: "fit",
      bitrate: RENDER_BITRATE,
      punchIn: false,
    });
    if (timedOut) return null;
    if (!(result.sizeBytes > 0) || result.actualDurationMs < editMs - DURATION_TOLERANCE_MS) {
      if (__DEV__) {
        console.log(
          `[render] rejected output: ${result.actualDurationMs} ms, ${result.sizeBytes} bytes, expected ${editMs} ms`,
        );
      }
      return null;
    }
    if (__DEV__) {
      console.log(
        `[render] ok in ${Date.now() - started} ms: ${width}x${height}, ${result.actualDurationMs} ms, ${(result.sizeBytes / 1048576).toFixed(2)} MB`,
      );
    }
    return { uri: result.uri, durationMs: result.actualDurationMs, sizeBytes: result.sizeBytes };
  } catch (e) {
    if (__DEV__) {
      const code = (e as { code?: string })?.code;
      console.log(`[render] failed, posting the old way: ${code ?? ""} ${(e as Error)?.message ?? e}`);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    subscription?.remove();
  }
}
