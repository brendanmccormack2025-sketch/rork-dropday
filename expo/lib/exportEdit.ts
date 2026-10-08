/**
 * The camera-roll export: the video that was posted (cuts and captions burned in), saved to Photos with an
 * add-only permission. Text-button overlays are NOT part of it: creators add their own text in TikTok or
 * Instagram. When the post went out as source clips (nothing was rendered) the cuts and captions are
 * rendered for the save.
 *
 * It runs alongside the upload and never touches it. One native render at a time: it waits its turn behind
 * any other render (acquireNative).
 */
import { documentDirectory, cacheDirectory, copyAsync, deleteAsync, downloadAsync } from "@/lib/fileSystemCompat";
import { recordClientError } from "@/lib/clientErrors";
import type { EditOverlay } from "@/lib/editModel";
import { getLegacyMediaLibrary, saveToLibraryAsync } from "@/lib/mediaLibraryCompat";
import { isDebugOwner } from "@/constants/debug";
import { acquireNative } from "@/lib/renderAhead";
import { buildRenderEdit, checkRenderResult, computeRenderSize, renderRequest, renderTimeoutMs } from "@/lib/renderAtPost";
import {
  SAVE_FAILED_TEXT,
  createSaveStatus,
  runSaveWithStatus,
  saveToCameraRoll,
  type SaveToRollResult,
} from "@/lib/saveToRoll";
import { supportsCaptionFont, supportsTextBox } from "@/modules/video-render";
import type { DraftClip, Post } from "@/providers/PostsProvider";

export { SAVE_FAILED_TEXT };

/** What the little message at the top of the screen shows. */
export const saveStatus = createSaveStatus();

/** Add-only photo permission: asked when needed, never read access. */
async function ensureAddPermission(): Promise<boolean> {
  const ml = getLegacyMediaLibrary();
  if (!ml) return false;
  const current = await ml.getPermissionsAsync(true);
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await ml.requestPermissionsAsync(true)).granted;
}

/** Render `clips` with the overlays burned in. Throws on any problem (the caller reports it). */
async function renderExport(clips: DraftClip[], overlays: EditOverlay[]): Promise<{ uri: string }> {
  const { edit, editMs } = buildRenderEdit(clips);
  if (editMs <= 0) throw new Error("export: nothing to render");
  const { width, height } = await computeRenderSize(clips[0]!);
  const release = await acquireNative();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    const { cancelRender, renderAsync } = await import("@/modules/video-render");
    timer = setTimeout(() => {
      timedOut = true;
      try {
        cancelRender();
      } catch {
        // best effort
      }
    }, renderTimeoutMs(editMs) * 2);
    const request = renderRequest(edit, width, height, overlays);
    const result = await renderAsync(request.json, request.options);
    if (timedOut) throw new Error("export: render timed out");
    const bad = checkRenderResult(result, editMs);
    if (bad) throw new Error(`export: ${bad}`);
    return { uri: result.uri };
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

/**
 * Copy the posted file (cuts and captions burned in) somewhere the upload will not delete. Resolves null if
 * there is nothing to copy or the copy failed (never throws); the export then renders instead.
 */
export async function stageExportFallback(uri: string | null | undefined): Promise<string | null> {
  if (!uri) return null;
  try {
    const dir = cacheDirectory ?? documentDirectory ?? "";
    const to = `${dir}export_posted_${Date.now()}.mp4`;
    await copyAsync({ from: uri, to });
    return to;
  } catch (e) {
    void recordClientError(e, { kind: "saveToRoll", stage: "stage-posted" });
    return null;
  }
}

function deps(enabled: boolean, render: () => Promise<{ uri: string }>, postedUri: string | null | undefined) {
  return {
    enabled,
    render,
    postedUri: postedUri ?? null,
    ensurePermission: ensureAddPermission,
    save: (uri: string) => saveToLibraryAsync(uri),
    cleanup: (uri: string) => deleteAsync(uri, { idempotent: true }),
    onError: (error: unknown, stage: string) =>
      void recordClientError(error, { kind: "saveToRoll", stage, supportsTextBox, supportsFont: supportsCaptionFont }),
  };
}

/**
 * After Post: save the video being posted. `postedUri` is the staged copy of the posted file; without it the
 * cuts and captions are rendered. Fire and forget; a failure shows "Couldn't save to camera roll" with Retry.
 */
export function startPostExport(args: {
  enabled: boolean;
  clips: DraftClip[];
  captionOverlays: EditOverlay[];
  /** The signed-in user (the owner account sees the real error reason). */
  userId?: string | null;
  /** The file that was posted (cuts and captions), staged by stageExportFallback. */
  postedUri?: string | null;
}): Promise<SaveToRollResult> {
  if (!args.enabled || args.clips.some((c) => c.type !== "video")) return Promise.resolve({ status: "off" });
  const run = () => saveToCameraRoll(deps(true, () => renderExport(args.clips, args.captionOverlays), args.postedUri));
  return runSaveWithStatus(saveStatus, run, isDebugOwner(args.userId));
}

/**
 * The "…" menu on the user's own post: download the posted video and save it (cuts and captions are in the
 * file). A post that went out as several source clips with trim data is rendered into one video first.
 */
export function savePostToRoll(post: Post, userId?: string | null): Promise<SaveToRollResult> {
  let posted: string | null = null;
  const run = async () => {
    const dir = cacheDirectory ?? documentDirectory ?? "";
    const stamp = Date.now();
    const urls = post.segments && post.segments.length > 0 ? post.segments : [post.media_url];
    const unique = Array.from(new Set(urls));
    const noTrim = !post.trim_data || post.trim_data.length === 0;
    if (!posted && urls.length === 1 && noTrim) {
      const to = `${dir}save_${stamp}.mp4`;
      const res = await downloadAsync(urls[0]!, to).catch(() => null);
      if (!res || (res.status && res.status >= 400)) {
        return saveToCameraRoll(deps(true, () => Promise.reject(new Error(`download failed (${res?.status ?? "none"})`)), null));
      }
      posted = to;
    }
    return saveToCameraRoll(
      deps(
        true,
        async () => {
          const local = new Map<string, string>();
          const downloaded: string[] = [];
          try {
            for (const [i, url] of unique.entries()) {
              const to = `${dir}save_${stamp}_${i}.mp4`;
              const res = await downloadAsync(url, to);
              if (!res || (res.status && res.status >= 400)) throw new Error(`download failed (${res?.status ?? "none"})`);
              downloaded.push(to);
              local.set(url, to);
            }
            const clips: DraftClip[] = urls.map((u, i) => ({
              id: `export_${i}`,
              uri: local.get(u)!,
              type: "video" as const,
              trimStartMs: post.trim_data?.[i]?.trimStartMs ?? 0,
              trimEndMs: post.trim_data?.[i]?.trimEndMs ?? 3_600_000,
              durationMs: post.trim_data?.[i]?.trimEndMs ?? 3_600_000,
            }));
            return await renderExport(clips, []);
          } finally {
            for (const f of downloaded) await deleteAsync(f, { idempotent: true }).catch(() => {});
          }
        },
        posted,
      ),
    );
  };
  return runSaveWithStatus(saveStatus, run, isDebugOwner(userId));
}
