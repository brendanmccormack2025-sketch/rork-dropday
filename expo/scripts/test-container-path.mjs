#!/usr/bin/env node
/**
 * Drafts survive an app update: iOS renames the app's data folder on every update, so saved absolute paths are rebased.
 *   node --experimental-strip-types --no-warnings scripts/test-container-path.mjs
 */
import { readFileSync } from "node:fs";
import { containerIdOf, rebaseToContainer } from "../lib/containerPath.ts";

let failed = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`}`); }
const ok = (n, c) => eq(n, !!c, true);

const OLD = "F66C1C18-1375-4A2B-9C3D-1234567890AB";
const NEW = "0B7E2D41-AAAA-4BBB-8CCC-FEDCBA098765";
const docsNow = `file:///var/mobile/Containers/Data/Application/${NEW}/Documents/`;

eq("reads the current folder name", containerIdOf(docsNow), NEW);
eq("no folder name on web / unknown", containerIdOf(undefined), null);

const draft = JSON.stringify([{
  id: "draft_1",
  clips: [{ id: "c1", type: "video", uri: `file:///var/mobile/Containers/Data/Application/${OLD}/Documents/drafts/draft_1/c1.mov` }],
  editState: { state: { sourceUri: `file:///var/mobile/Containers/Data/Application/${OLD}/Documents/drafts/draft_1/c1.mov` } },
  coverThumbnailUri: `file:///private/var/mobile/Containers/Data/Application/${OLD}/Documents/thumbnails/cover_1.jpg`,
}]);
const fixed = JSON.parse(rebaseToContainer(draft, docsNow))[0];
eq("a draft clip saved before the update points at the new folder", fixed.clips[0].uri, `${docsNow}drafts/draft_1/c1.mov`);
eq("the saved edit's source too", fixed.editState.state.sourceUri, `${docsNow}drafts/draft_1/c1.mov`);
eq("the cover too (/private/var form)", fixed.coverThumbnailUri, `file:///private/var/mobile/Containers/Data/Application/${NEW}/Documents/thumbnails/cover_1.jpg`);
eq("already current: unchanged", rebaseToContainer(JSON.stringify(fixed), docsNow), JSON.stringify(fixed));
eq("web / Android: unchanged", rebaseToContainer(draft, "file:///data/user/0/app/files/"), draft);
eq("remote urls untouched", rebaseToContainer('{"u":"https://x.supabase.co/storage/v1/a.mp4"}', docsNow), '{"u":"https://x.supabase.co/storage/v1/a.mp4"}');

const provider = readFileSync(new URL("../providers/PostsProvider.tsx", import.meta.url), "utf8");
ok("drafts are rebased when loaded (and saved back)", /rebaseToContainer\(stored, documentDirectory\)/.test(provider) && /if \(raw !== stored\) void AsyncStorage\.setItem\(DRAFTS_KEY, raw\)/.test(provider));
ok("pending uploads are rebased when loaded", /rebaseToContainer\(storedPosts, documentDirectory\)/.test(provider));
const cleanup = readFileSync(new URL("../lib/storageCleanupCore.ts", import.meta.url), "utf8");
ok("the launch cleanup never deletes draft files", /DELETABLE[^\n]*new Set<Area>\(\[(?![^\]]*"drafts")/.test(cleanup));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
