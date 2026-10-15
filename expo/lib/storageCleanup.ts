/**
 * Frees the space Tryal's temporary video files take, without touching drafts or anything still in use.
 * The rules (what may be deleted, and when) are in lib/storageCleanupCore.ts; this file only reads a few known folders,
 * deletes what the plan says, and reports. Never throws.
 *
 * Automatic, no button: some seconds after launch it deletes temporary files from EARLIER runs that no saved draft or
 * pending upload mentions. Files of this run are never touched (the editor, camera or a camera-roll save may be using
 * them); a successful post deletes its own staged copies at once (PostsProvider). Drafts are never deleted, and posts
 * and reactions live on the server: only the phone's leftover working copies go.
 *
 * Gentle by design (an earlier version that walked whole folder trees made the app die):
 *   - only the folders Tryal itself writes to are read, one level deep, and only names that look like Tryal's files are
 *     looked at; nothing else in the app's folders is ever opened
 *   - files are handled a few at a time with pauses, so the feed, camera and picker keep running
 *   - at most MAX_PER_RUN files per launch (the rest next time)
 *   - if a run does not finish (the app was closed or died), the next launch skips it; after two such runs it stops
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import { cacheDirectory, deleteAsync, documentDirectory, getInfoAsync, readDirectoryAsync } from "@/lib/fileSystemCompat";
import { recordBreadcrumb, recordMetric } from "@/lib/clientErrors";
import { planCleanup, type FileEntry } from "@/lib/storageCleanupCore";

/** The stored lists whose files must survive (same keys as providers/PostsProvider.tsx). */
export const DRAFTS_KEY = "dropday:draftProjects:v2";
export const OPTIMISTIC_POSTS_KEY = "dropday:optimisticPosts";

/** When this run of the app started: anything written before it belongs to an earlier run. */
export const LAUNCHED_AT = Date.now();
const MAX_PER_RUN = 300;
const BATCH = 4;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One folder Tryal writes to, read one level deep; `names` picks the entries worth looking at. */
type Target = { root: FileEntry["root"]; dir: string; prefix: string; names?: RegExp };

const MEDIA_NAME = /\.(mov|mp4|m4v|m4a|aac|wav|caf|jpg|jpeg|png|heic|heif)$/i;
const CACHE_WORK_NAME = /^(render_|export_posted_|save_|stitch_|speech_)[^/]*\.(mp4|mov|m4a)$/i;

function targets(): Target[] {
  if (Platform.OS === "web" || !documentDirectory) return [];
  const libCaches = documentDirectory.replace(/Documents\/?$/, "Library/Caches/");
  const tmp = documentDirectory.replace(/Documents\/?$/, "tmp/");
  const expoCache = cacheDirectory || libCaches;
  const out: Target[] = [
    { root: "documents", dir: `${documentDirectory}post_uploads/`, prefix: "post_uploads/" },
    { root: "documents", dir: `${documentDirectory}thumbnails/`, prefix: "thumbnails/" },
    { root: "caches", dir: `${expoCache}Camera/`, prefix: "Camera/" },
    { root: "caches", dir: `${expoCache}ImagePicker/`, prefix: "ImagePicker/" },
    { root: "caches", dir: `${expoCache}VideoThumbnails/`, prefix: "VideoThumbnails/" },
  ];
  // the native renderer's files sit loose in Library/Caches (renders, merges, camera-roll and stitch work files)
  if (libCaches !== documentDirectory) out.push({ root: "caches", dir: libCaches, prefix: "", names: CACHE_WORK_NAME });
  if (expoCache !== libCaches) out.push({ root: "caches", dir: expoCache, prefix: "", names: CACHE_WORK_NAME });
  // tmp/: loose audio/video files only (captions audio, picker exports)
  if (tmp !== documentDirectory) out.push({ root: "tmp", dir: tmp, prefix: "", names: MEDIA_NAME });
  return out;
}

/** The candidate files in one target folder (never goes into sub-folders). */
async function listTarget(t: Target, out: FileEntry[]): Promise<void> {
  let names: string[] = [];
  try {
    names = await readDirectoryAsync(t.dir);
  } catch {
    return; // the folder does not exist
  }
  const wanted = t.names ? names.filter((n) => t.names!.test(n)) : names;
  for (let i = 0; i < wanted.length; i += BATCH) {
    await Promise.all(
      wanted.slice(i, i + BATCH).map(async (name) => {
        const uri = `${t.dir}${encodeURI(name)}`;
        try {
          const info = await getInfoAsync(uri);
          if (!info.exists || info.isDirectory) return;
          out.push({ uri, rel: `${t.prefix}${name}`, root: t.root, size: info.size ?? 0, modifiedMs: Math.round((info.modificationTime ?? 0) * 1000) });
        } catch {
          // unreadable entry: leave it alone
        }
      }),
    );
    if (i % (BATCH * 10) === 0) await pause(5);
  }
}

/** The candidate files Tryal may have left behind (only in the folders it writes to). */
export async function listTemporaryFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const t of targets()) await listTarget(t, out);
  return out;
}

/** The stored drafts and pending uploads, or null when they could not be read (then nothing is deleted). */
async function storedReferences(): Promise<string[] | null> {
  try {
    const [drafts, pending] = await Promise.all([AsyncStorage.getItem(DRAFTS_KEY), AsyncStorage.getItem(OPTIMISTIC_POSTS_KEY)]);
    return [drafts ?? "", pending ?? ""];
  } catch {
    return null;
  }
}

export type CleanupResult = { removedFiles: number; removedBytes: number; failed: number; keptReferenced: number; keptRecent: number; left: number };

let running: Promise<CleanupResult> | null = null;

/** Set while a cleanup runs. Still set at the next launch = the app died during it. */
const RUNNING_KEY = "tryal:storageCleanupRunning:v2";
/** How many runs did not finish; at 2 the cleanup stops for good (a later version can rename the key to retry). */
const FAILURES_KEY = "tryal:storageCleanupFailures:v2";

/** Delete temporary files last written before `before` that nothing stored refers to. One run at a time. */
export function cleanUpTemporaryFiles(before: number): Promise<CleanupResult> {
  if (running) return running;
  running = (async (): Promise<CleanupResult> => {
    const result: CleanupResult = { removedFiles: 0, removedBytes: 0, failed: 0, keptReferenced: 0, keptRecent: 0, left: 0 };
    try {
      const failures = Number((await AsyncStorage.getItem(FAILURES_KEY).catch(() => null)) ?? 0) || 0;
      const unfinished = await AsyncStorage.getItem(RUNNING_KEY).catch(() => null);
      if (unfinished) {
        await AsyncStorage.multiSet([[FAILURES_KEY, String(failures + 1)]]).catch(() => {});
        await AsyncStorage.removeItem(RUNNING_KEY).catch(() => {});
        void recordMetric("storageCleanupSkipped", { after: unfinished, failures: failures + 1 });
        return result;
      }
      if (failures >= 2) return result;
      await AsyncStorage.setItem(RUNNING_KEY, `launch@${new Date().toISOString()}`).catch(() => {});
      recordBreadcrumb("storageCleanup:v2:listing");
      const files = await listTemporaryFiles();
      const plan = planCleanup(files, await storedReferences(), before);
      const batch = plan.remove.slice(0, MAX_PER_RUN);
      result.left = plan.remove.length - batch.length;
      result.keptReferenced = plan.keptReferenced;
      result.keptRecent = plan.keptRecent;
      recordBreadcrumb("storageCleanup:v2:deleting", { files: batch.length, bytes: plan.removeBytes, listed: files.length });
      for (let i = 0; i < batch.length; i++) {
        const f = batch[i]!;
        try {
          await deleteAsync(f.uri, { idempotent: true });
          result.removedFiles++;
          result.removedBytes += f.size;
        } catch {
          result.failed++;
        }
        if (i % 10 === 9) await pause(5);
      }
      await AsyncStorage.removeItem(RUNNING_KEY).catch(() => {});
      await AsyncStorage.removeItem(FAILURES_KEY).catch(() => {});
      void recordMetric("storageCleanup", { ...result, listed: files.length, MB: Math.round(result.removedBytes / 1048576) });
    } catch {
      // never break the app over cleanup
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * OFF while the camera / editor crashes are tracked down: every launch run so far started listing and never finished,
 * and the crashes, heat and freezes began with it. A successful post still deletes its own staged copies.
 */
export const LAUNCH_CLEANUP_ENABLED = false;

/** Called once from the root layout: tidy up what earlier runs left behind, once the app has settled. */
export function scheduleLaunchCleanup(delayMs = 20000): () => void {
  if (!LAUNCH_CLEANUP_ENABLED) return () => {};
  const t = setTimeout(() => void cleanUpTemporaryFiles(LAUNCHED_AT), delayMs);
  return () => clearTimeout(t);
}
