#!/usr/bin/env node
/**
 * Storage cleanup (lib/storageCleanupCore.ts): what may be deleted, what must survive, and that the app is wired to it.
 *   node --experimental-strip-types --no-warnings scripts/test-storage-cleanup.mjs
 */
import { readFileSync } from "node:fs";
import { areaOf, draftLeftovers, normalizePath, planCleanup, referencedPaths, stagedCopiesToDelete, summarize } from "../lib/storageCleanupCore.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const APP = "file:///var/mobile/Containers/Data/Application/AAAA-1111";
const DOC = `${APP}/Documents/`, CACHE = `${APP}/Library/Caches/`, TMP = `${APP}/tmp/`;
const OLD = 1_000, LAUNCH = 10_000, NEW = 20_000;
const f = (root, rel, size = 100, modifiedMs = OLD) => ({ uri: (root === "documents" ? DOC : root === "caches" ? CACHE : TMP) + rel, rel, root, size, modifiedMs });

// ── what kind of file is it ──
eq("areas", [
  areaOf(f("documents", "drafts/d1/a.mp4")), areaOf(f("documents", "post_uploads/clip_0_1.mov")), areaOf(f("documents", "thumbnails/cover_1.jpg")),
  areaOf(f("caches", "Camera/x.mov")), areaOf(f("caches", "ImagePicker/y.mov")), areaOf(f("caches", "VideoThumbnails/z.jpg")),
  areaOf(f("caches", "render_ABC.mp4")), areaOf(f("caches", "export_posted_1.mp4")), areaOf(f("caches", "save_1_0.mp4")), areaOf(f("caches", "stitch_output_1.mp4")),
  areaOf(f("tmp", "speech_1.m4a")), areaOf(f("tmp", "notes.txt")), areaOf(f("caches", "com.hackemist.SDImageCache/default/abc")), areaOf(f("documents", "something.json")),
], ["drafts", "uploads", "thumbnails", "camera", "picker", "picker", "renders", "renders", "renders", "renders", "tmp", "otherCache", "otherCache", "otherDocs"]);

// ── the plan ──
const files = [
  f("documents", "drafts/d1/a.mp4", 5000),           // a draft: never
  f("documents", "post_uploads/clip_0_1.mov", 900),  // left by a finished upload
  f("documents", "post_uploads/clip_0_2.mov", 800),  // a pending upload still needs it
  f("documents", "thumbnails/cover_1.jpg", 10),      // a draft's cover
  f("documents", "thumbnails/cover_2.jpg", 10),      // nobody's
  f("caches", "Camera/take1.mov", 3000),
  f("caches", "Camera/take2.mov", 3000, NEW),        // recorded in this run
  f("caches", "ImagePicker/pick.mov", 4000),
  f("caches", "render_M.mp4", 2000),
  f("caches", "Camera/fallback.mov", 700),           // a draft kept the original uri (its copy failed)
  f("tmp", "speech_9.m4a", 50),
  f("caches", "com.hackemist.SDImageCache/default/img", 300),
  f("documents", "settings.json", 5),
];
const drafts = JSON.stringify([{ id: "d1", clips: [{ uri: `${DOC}drafts/d1/a.mp4` }, { uri: `${CACHE}Camera/fallback.mov` }], coverThumbnailUri: `${DOC}thumbnails/cover_1.jpg` }]);
const pending = JSON.stringify([{ _optimistic: { retryPayload: JSON.stringify({ uri: `${DOC}post_uploads/clip_0_2.mov` }) } }]);
const plan = planCleanup(files, [drafts, pending], LAUNCH);
const removed = plan.remove.map((x) => x.rel).sort();
eq("deletes leftovers from earlier runs only", removed, ["Camera/take1.mov", "ImagePicker/pick.mov", "post_uploads/clip_0_1.mov", "render_M.mp4", "speech_9.m4a", "thumbnails/cover_2.jpg"].sort());
eq("...and adds up what it frees", plan.removeBytes, 900 + 10 + 3000 + 4000 + 2000 + 50);
ok("never a draft's file, a draft's cover, or a file a draft points at in the cache", !removed.some((r) => r.startsWith("drafts/") || r === "thumbnails/cover_1.jpg" || r === "Camera/fallback.mov"));
ok("never a file a pending upload needs (path inside JSON inside JSON)", !removed.includes("post_uploads/clip_0_2.mov"));
ok("never a file written in this run", !removed.includes("Camera/take2.mov") && plan.keptRecent === 1);
ok("never other libraries' caches or other app data", !removed.some((r) => r.startsWith("com.hackemist") || r === "settings.json"));
eq("the stored lists could not be read: nothing at all is deleted", planCleanup(files, null, LAUNCH).remove.length, 0);
eq("no drafts and no uploads stored: still only temporary kinds", planCleanup(files, ["", ""], LAUNCH).remove.map((x) => x.rel).filter((r) => r.startsWith("drafts/")), []);

// the app's container folder is renamed by iOS on an update: a draft saved before it still protects its files
const afterUpdate = [{ ...f("caches", "Camera/fallback.mov"), uri: "file:///var/mobile/Containers/Data/Application/BBBB-2222/Library/Caches/Camera/fallback.mov" }];
eq("a draft path from before an app update still protects the file", planCleanup(afterUpdate, [drafts], LAUNCH).remove.length, 0);
eq("/private/var and %20 spellings match", normalizePath("file:///private/var/mobile/Containers/Data/Application/X/Library/Caches/a%20b.mov"), normalizePath("/var/mobile/Containers/Data/Application/Y/Library/Caches/a b.mov"));
ok("escaped JSON slashes are read too", referencedPaths(['{"u":"file:\\/\\/\\/var\\/mobile\\/Containers\\/Data\\/Application\\/Z\\/Documents\\/post_uploads\\/c.mov"}']).has("app:/Documents/post_uploads/c.mov"));

// ── after a post is saved ──
eq("only the staged copies go, never the source clips or remote files", stagedCopiesToDelete([`${DOC}post_uploads/clip_0_1.mov`, `${DOC}thumbnails/cover_3.jpg`, `${CACHE}Camera/take1.mov`, `${DOC}drafts/d1/a.mp4`, "https://x/y.mp4", undefined, `${DOC}post_uploads/clip_0_1.mov`]), [`${DOC}post_uploads/clip_0_1.mov`, `${DOC}thumbnails/cover_3.jpg`]);
eq("a re-saved draft drops the files it no longer uses", draftLeftovers([`${DOC}drafts/d1/a.mp4`, `${DOC}drafts/d1/old.mp4`], [`${DOC}drafts/d1/a.mp4`]), [`${DOC}drafts/d1/old.mp4`]);

// ── the report ──
const rep = summarize(files);
eq("the report adds up by kind", [rep.drafts.bytes, rep.camera.bytes, rep.uploads.files, rep.totalBytes], [5000, 6700, 2, files.reduce((n, x) => n + x.size, 0)]);

// ── wiring ──
const posts = read("../providers/PostsProvider.tsx"), cleanup = read("../lib/storageCleanup.ts"), edit = read("../app/edit.tsx"), layout = read("../app/_layout.tsx");
const key = (src, name) => (new RegExp(`${name} = "([^"]+)"`).exec(src) ?? [])[1];
eq("the cleanup reads the same stored lists the app writes", [key(cleanup, "DRAFTS_KEY"), key(cleanup, "OPTIMISTIC_POSTS_KEY")], [key(posts, "DRAFTS_KEY"), key(posts, "OPTIMISTIC_POSTS_KEY")]);
ok("launch cleanup is scheduled from the root layout", /useEffect\(\(\) => scheduleLaunchCleanup\(\), \[\]\)/.test(layout));
ok("a saved post deletes its staged copies", /stagedCopiesToDelete\(\[rawInput\.uri/.test(posts));
ok("deleting a draft deletes its cover", /const cover = draftProjects\.find/.test(posts));
ok("the frame grabber's cache file is deleted after the cover is copied", /await deleteAsync\(result\.uri, \{ idempotent: true \}\)/.test(edit));
ok("saving an opened draft again never copies its own files a second time", /if \(c\.uri\.startsWith\(draftDir\)\) return c\.uri;/.test(edit));
ok("...and drops files it no longer uses, after the new version is stored", edit.indexOf("draftLeftovers(") > edit.indexOf("await saveDraftProject(project);"));
ok("Settings has a Storage screen", /settings\/storage/.test(read("../app/settings.tsx")) && /cleanUpNow/.test(read("../app/settings/storage.tsx")));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
