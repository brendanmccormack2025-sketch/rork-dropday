/**
 * Frees the space Tryal's temporary video files take, without touching drafts or anything still in use.
 * The rules (what may be deleted, and when) are in lib/storageCleanupCore.ts; this file only reads the directories,
 * deletes what the plan says, and reports. Never throws.
 *
 * Automatic, no button: at every launch (a few seconds in) it deletes temporary files from EARLIER runs that no saved
 * draft or pending upload mentions. Files of this run are never touched (the editor, camera or a camera-roll save may be
 * using them); a successful post deletes its own staged copies at once (PostsProvider). Drafts are never deleted, and
 * posts and reactions live on the server: only the phone's leftover working copies go.
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
const MAX_DEPTH = 4;

function roots(): Array<{ root: FileEntry["root"]; uri: string }> {
  if (Platform.OS === "web" || !documentDirectory) return [];
  const out: Array<{ root: FileEntry["root"]; uri: string }> = [{ root: "documents", uri: documentDirectory }];
  // Library/Caches/ (the native renderer writes there); expo's cacheDirectory is that folder or inside it
  const libCaches = documentDirectory.replace(/Documents\/?$/, "Library/Caches/");
  out.push({ root: "caches", uri: libCaches !== documentDirectory ? libCaches : cacheDirectory });
  // iOS tmp/ sits next to Documents/ (captions audio, some picker exports)
  const tmp = documentDirectory.replace(/Documents\/?$/, "tmp/");
  if (tmp !== documentDirectory) out.push({ root: "tmp", uri: tmp });
  return out;
}

/** The only folders that can hold deletable files (the cleanup does not walk image caches with thousands of files). */
function deletableDirs(): string[] {
  if (!documentDirectory) return [];
  const caches = cacheDirectory || documentDirectory.replace(/Documents\/?$/, "Library/Caches/");
  return [`${documentDirectory}post_uploads/`, `${documentDirectory}thumbnails/`, `${caches}Camera/`, `${caches}ImagePicker/`, `${caches}VideoThumbnails/`];
}

const PARALLEL = 24;

async function walk(root: FileEntry["root"], base: string, dir: string, depth: number, out: FileEntry[], only?: string[]): Promise<void> {
  let names: string[] = [];
  try {
    names = await readDirectoryAsync(dir);
  } catch {
    return;
  }
  const one = async (name: string): Promise<void> => {
    const uri = `${dir}${encodeURI(name)}`;
    try {
      // expo's camera / picker folders live in expo's cacheDirectory: name them from there ("Camera/…", "ImagePicker/…")
      const from = root === "caches" && cacheDirectory && cacheDirectory !== base && uri.startsWith(cacheDirectory) ? cacheDirectory : base;
      // NO size option: on a folder it makes the system add up everything inside (slow, and the likely crash on
      // system folders); a plain file reports its size anyway.
      const info = await getInfoAsync(uri);
      if (!info.exists) return;
      if (info.isDirectory) {
        const sub = `${uri}/`;
        // with `only`: go into a folder only on the way to (or inside) one of those folders
        const wanted = !only || only.some((d) => d.startsWith(sub) || sub.startsWith(d));
        // the system's own folders (com.apple.*, Snapshots) are never ours to read
        if (!wanted || depth >= MAX_DEPTH || /^(com\.apple|Snapshots$)/.test(name)) return;
        await walk(root, base, sub, depth + 1, out, only);
        return;
      }
      out.push({
        uri,
        rel: decodeURI(uri.slice(from.length)),
        root,
        size: info.size ?? 0,
        modifiedMs: Math.round((info.modificationTime ?? 0) * 1000),
      });
    } catch {
      // unreadable entry: leave it alone
    }
  };
  // a few at a time: one file system call after another was far too slow for folders with many files
  for (let k = 0; k < names.length; k += PARALLEL) await Promise.all(names.slice(k, k + PARALLEL).map(one));
}

/** Every file in the app's Documents, Caches and tmp folders (`deletableOnly`: just where temporary files can be). */
export async function listAppFiles(deletableOnly = false): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const only = deletableOnly ? deletableDirs() : undefined;
  for (const r of roots()) await walk(r.root, r.uri, r.uri, 0, out, only);
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

export type CleanupResult = { removedFiles: number; removedBytes: number; failed: number; keptReferenced: number; keptRecent: number };

let running: Promise<CleanupResult> | null = null;

/** Set while a cleanup runs. Still set at the next launch = the app died during it: that launch skips the cleanup. */
const RUNNING_KEY = "tryal:storageCleanupRunning";

/** Delete temporary files last written before `before` that nothing stored refers to. One run at a time. */
export function cleanUpTemporaryFiles(before: number, reason: "launch"): Promise<CleanupResult> {
  if (running) return running;
  running = (async (): Promise<CleanupResult> => {
    const result: CleanupResult = { removedFiles: 0, removedBytes: 0, failed: 0, keptReferenced: 0, keptRecent: 0 };
    try {
      const unfinished = await AsyncStorage.getItem(RUNNING_KEY).catch(() => null);
      if (unfinished && reason === "launch") {
        // the last one never finished (the app closed or crashed in it): not again at launch; the button still works
        await AsyncStorage.removeItem(RUNNING_KEY).catch(() => {});
        void recordMetric("storageCleanupSkipped", { after: unfinished });
        return result;
      }
      await AsyncStorage.setItem(RUNNING_KEY, `${reason}@${new Date().toISOString()}`).catch(() => {});
      // where it got to, in case the app dies on the way (uploaded at the next launch)
      recordBreadcrumb(`storageCleanup:${reason}:listing`);
      const files = await listAppFiles(true);
      const plan = planCleanup(files, await storedReferences(), before);
      recordBreadcrumb(`storageCleanup:${reason}:deleting`, { files: plan.remove.length, bytes: plan.removeBytes, listed: files.length });
      result.keptReferenced = plan.keptReferenced;
      result.keptRecent = plan.keptRecent;
      for (const f of plan.remove) {
        try {
          await deleteAsync(f.uri, { idempotent: true });
          result.removedFiles++;
          result.removedBytes += f.size;
        } catch {
          result.failed++;
        }
      }
      if (result.removedFiles > 0 || result.failed > 0) void recordMetric("storageCleanup", { reason, ...result });
      await AsyncStorage.removeItem(RUNNING_KEY).catch(() => {});
    } catch {
      // never break the app over cleanup
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Called once from the root layout: tidy up what earlier runs left behind, after the app has settled. */
export function scheduleLaunchCleanup(delayMs = 8000): () => void {
  const t = setTimeout(() => void cleanUpTemporaryFiles(LAUNCHED_AT, "launch"), delayMs);
  return () => clearTimeout(t);
}
