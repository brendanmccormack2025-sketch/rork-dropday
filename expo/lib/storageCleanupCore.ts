/**
 * Which local files are safe to delete, and how much space each kind uses. Pure (no file system, no React Native) so
 * the Node tests can run it; lib/storageCleanup.ts feeds it the real directory listings.
 *
 * Where Tryal's large files come from (all inside the app's sandbox):
 *   Documents/drafts/<id>/          clips of saved drafts                              NEVER deleted here
 *   Documents/post_uploads/         copies of the clips/render staged for an upload    temporary
 *   Documents/thumbnails/           cover images of posts and drafts                   temporary unless a draft uses it
 *   Caches/Camera/                  the camera's recordings (expo-camera)              temporary
 *   Caches/ImagePicker/             videos/photos picked from the library               temporary
 *   Caches/VideoThumbnails/         frames grabbed for covers                           temporary
 *   Caches/render_*.mp4             merges, previews and renders (native renderer)     temporary
 *   Caches/export_posted_*, save_*, stitch_*   camera-roll and stitching work files     temporary
 *   tmp/                            audio for captions, picker exports                  temporary (media files only)
 * A temporary file is deleted only when (1) no saved draft or pending upload mentions it and (2) it was last written
 * before `before` (at launch: before this launch, so nothing running now can be using it).
 */

export type Area = "drafts" | "uploads" | "thumbnails" | "camera" | "picker" | "renders" | "tmp" | "otherCache" | "otherDocs";

export type FileEntry = {
  /** Absolute file:// uri. */
  uri: string;
  /** Path relative to its root, e.g. "post_uploads/clip_0_1.mov" or "Camera/abc.mov". */
  rel: string;
  root: "documents" | "caches" | "tmp";
  size: number;
  /** Last modified, ms since epoch (0 when unknown: treated as old). */
  modifiedMs: number;
};

const MEDIA = /\.(mov|mp4|m4v|m4a|aac|wav|caf|jpg|jpeg|png|heic|heif|gif|webp)$/i;
const CACHE_WORK = /^(render_|export_posted_|save_|stitch_|speech_)[^/]*\.(mp4|mov|m4a)$/i;

/** Which kind of file this is (decides whether it may be deleted). */
export function areaOf(f: Pick<FileEntry, "rel" | "root">): Area {
  const rel = f.rel.replace(/^\/+/, "");
  if (f.root === "documents") {
    if (rel.startsWith("drafts/")) return "drafts";
    if (rel.startsWith("post_uploads/")) return "uploads";
    if (rel.startsWith("thumbnails/")) return "thumbnails";
    return "otherDocs";
  }
  if (f.root === "tmp") return MEDIA.test(rel) ? "tmp" : "otherCache";
  if (rel.startsWith("Camera/")) return "camera";
  if (rel.startsWith("ImagePicker/") || rel.startsWith("VideoThumbnails/")) return "picker";
  if (!rel.includes("/") && CACHE_WORK.test(rel)) return "renders";
  return "otherCache";
}

/** Areas this cleanup may delete from. Drafts, other app data and other libraries' caches are never touched. */
export const DELETABLE: ReadonlySet<Area> = new Set<Area>(["uploads", "thumbnails", "camera", "picker", "renders", "tmp"]);

/** "file:///a%20b/c.mov" and "/a b/c.mov" compare equal. */
export function normalizePath(uri: string): string {
  let p = uri.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  try {
    p = decodeURI(p);
  } catch {
    // keep as is
  }
  // /private/var and /var are the same place on iOS; the app's container folder changes name when the app is updated,
  // so paths are compared from inside the container (a draft saved before an update still protects its files)
  return p.replace(/^\/private\/var\//, "/var/").replace(/^.*\/Data\/Application\/[^/]+\//, "app:/");
}

/** Every local file path mentioned anywhere in these stored strings (drafts, pending uploads; JSON nested in JSON too). */
export function referencedPaths(stored: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const s of stored) {
    if (!s) continue;
    const text = s.replace(/\\\//g, "/");
    for (const m of text.matchAll(/file:\/\/[^"'\\\s]+/g)) out.add(normalizePath(m[0]));
    // bare absolute sandbox paths ("/var/mobile/…") as well
    for (const m of text.matchAll(/(?:^|["'\s(])(\/(?:private\/)?var\/[^"'\\\s]+)/g)) out.add(normalizePath(m[1]!));
  }
  return out;
}

export type CleanupPlan = {
  remove: FileEntry[];
  removeBytes: number;
  /** Kept although deletable by kind: something references it, or it is too new. */
  keptReferenced: number;
  keptRecent: number;
};

/** The files to delete. Nothing is deleted when `stored` could not be read (pass null): better a full disk than a lost draft. */
export function planCleanup(files: FileEntry[], stored: Array<string | null | undefined> | null, before: number): CleanupPlan {
  const plan: CleanupPlan = { remove: [], removeBytes: 0, keptReferenced: 0, keptRecent: 0 };
  if (stored === null) return plan;
  const refs = referencedPaths(stored);
  for (const f of files) {
    if (!DELETABLE.has(areaOf(f))) continue;
    if (refs.has(normalizePath(f.uri))) {
      plan.keptReferenced++;
      continue;
    }
    if (f.modifiedMs >= before) {
      plan.keptRecent++;
      continue;
    }
    plan.remove.push(f);
    plan.removeBytes += Math.max(0, f.size);
  }
  return plan;
}

export type StorageReport = Record<Area, { files: number; bytes: number }> & { totalBytes: number };

export function summarize(files: FileEntry[]): StorageReport {
  const areas: Area[] = ["drafts", "uploads", "thumbnails", "camera", "picker", "renders", "tmp", "otherCache", "otherDocs"];
  const r = Object.fromEntries(areas.map((a) => [a, { files: 0, bytes: 0 }])) as StorageReport;
  r.totalBytes = 0;
  for (const f of files) {
    const a = r[areaOf(f)];
    a.files++;
    a.bytes += Math.max(0, f.size);
    r.totalBytes += Math.max(0, f.size);
  }
  return r;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** After a post is saved: the staged copies it no longer needs (only files the app made for the upload, never sources). */
export function stagedCopiesToDelete(uris: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const u of uris) {
    if (!u || u.startsWith("http")) continue;
    if (/\/(post_uploads|thumbnails)\/[^/]+$/.test(normalizePath(u))) out.add(u);
  }
  return [...out];
}

/** Files in a draft's own folder that the saved draft no longer uses (clips removed or replaced since the last save). */
export function draftLeftovers(draftDirFiles: string[], projectUris: Array<string | null | undefined>): string[] {
  const used = new Set(projectUris.filter((u): u is string => !!u).map(normalizePath));
  return draftDirFiles.filter((f) => !used.has(normalizePath(f)));
}
