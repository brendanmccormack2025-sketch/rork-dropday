/**
 * The camera-roll export: a dedicated render of the edit with everything burned in (cuts, captions and the
 * Text-button overlays, which the feed otherwise draws live), then an add-only save to Photos.
 *
 * It runs after the post has started uploading and never touches it. One native render at a time: it waits
 * its turn behind any other render (acquireNative).
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
import { textOverlaysToEditOverlays } from "@/lib/textOverlayStyle";
import { supportsCaptionFont, supportsTextBox } from "@/modules/video-render";
import type { DraftClip, Post, TextOverlay } from "@/providers/PostsProvider";

export { SAVE_FAILED_TEXT };

/** What the little message at the top of the screen shows. */
export const saveStatus = createSaveStatus();

const CAPS = () => ({ supportsFont: supportsCaptionFont, supportsTextBox });

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
 * Copy the posted file (cuts and captions burned in) somewhere the upload will not delete, so a failed export
 * render can still save it. Resolves null if there is nothing to copy or the copy failed (never throws).
 */
export async function stageExportFallback(uri: string | null | undefined): Promise<string | null> {
  if (!uri) return null;
  try {
    const dir = cacheDirectory ?? documentDirectory ?? "";
    const to = `${dir}export_fallback_${Date.now()}.mp4`;
    await copyAsync({ from: uri, to });
    return to;
  } catch (e) {
    void recordClientError(e, { kind: "saveToRoll", stage: "stage-fallback" });
    return null;
  }
}

function deps(
  enabled: boolean,
  render: () => Promise<{ uri: string }>,
  kind: string,
  extra: { fallbackUri?: string | null; hasTextOverlays?: boolean } = {},
) {
  return {
    enabled,
    render,
    fallbackUri: extra.fallbackUri ?? null,
    hasTextOverlays: extra.hasTextOverlays ?? false,
    canBurnOverlays: supportsTextBox,
    ensurePermission: ensureAddPermission,
    save: (uri: string) => saveToLibraryAsync(uri),
    cleanup: (uri: string) => deleteAsync(uri, { idempotent: true }),
    onError: (error: unknown, stage: string) => void recordClientError(error, { kind, stage, supportsTextBox, supportsFont: supportsCaptionFont }),
  };
}

/**
 * After Post: save the edit being posted. Cuts come from `clips`, captions from `captionOverlays`, Text-button
 * overlays from `textOverlays`. Fire and forget; a failure shows "Couldn't save to camera roll" with Retry.
 */
export function startPostExport(args: {
  enabled: boolean;
  clips: DraftClip[];
  captionOverlays: EditOverlay[];
  textOverlays: TextOverlay[];
  /** The signed-in user (the owner account sees the real error reason). */
  userId?: string | null;
  /** The file that was posted (cuts and captions), staged by stageExportFallback: saved if the export render fails. */
  fallbackUri?: string | null;
}): Promise<SaveToRollResult> {
  if (!args.enabled || args.clips.some((c) => c.type !== "video")) return Promise.resolve({ status: "off" });
  const overlays = [...args.captionOverlays, ...textOverlaysToEditOverlays(args.textOverlays, CAPS())];
  const run = () =>
    saveToCameraRoll(
      deps(true, () => renderExport(args.clips, overlays), "saveToRoll", {
        fallbackUri: args.fallbackUri,
        hasTextOverlays: args.textOverlays.some((t) => t.text.trim().length > 0),
      }),
    );
  return runSaveWithStatus(saveStatus, run, isDebugOwner(args.userId));
}

/** The "…" menu on the user's own post: download it and save it with its Text-button overlays burned in. */
export function savePostToRoll(post: Post, userId?: string | null): Promise<SaveToRollResult> {
  const run = () =>
    saveToCameraRoll(
      deps(
        true,
        async () => {
          const dir = cacheDirectory ?? documentDirectory ?? "";
          const stamp = Date.now();
          const urls = post.segments && post.segments.length > 0 ? post.segments : [post.media_url];
          const unique = Array.from(new Set(urls));
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
            const overlays = textOverlaysToEditOverlays(post.text_overlays ?? [], CAPS());
            const noTrim = !post.trim_data || post.trim_data.length === 0;
            if (overlays.length === 0 && urls.length === 1 && noTrim) {
              // Nothing to burn in: the posted file itself is the video.
              const only = local.get(urls[0]!)!;
              downloaded.splice(downloaded.indexOf(only), 1);
              return { uri: only };
            }
            const clips: DraftClip[] = urls.map((u, i) => ({
              id: `export_${i}`,
              uri: local.get(u)!,
              type: "video" as const,
              trimStartMs: post.trim_data?.[i]?.trimStartMs ?? 0,
              trimEndMs: post.trim_data?.[i]?.trimEndMs ?? 3_600_000,
              durationMs: post.trim_data?.[i]?.trimEndMs ?? 3_600_000,
            }));
            return await renderExport(clips, overlays);
          } finally {
            for (const f of downloaded) await deleteAsync(f, { idempotent: true }).catch(() => {});
          }
        },
        "saveToRoll",
      ),
    );
  return runSaveWithStatus(saveStatus, run, isDebugOwner(userId));
}
