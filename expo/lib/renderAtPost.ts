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
