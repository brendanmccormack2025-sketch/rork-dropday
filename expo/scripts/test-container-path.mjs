#!/usr/bin/env node
/**
 * Drafts survive an app update: iOS renames the app's data folder on every update, so saved absolute paths are rebased.
 *   node --experimental-strip-types --no-warnings scripts/test-container-path.mjs
 */
import { readFileSync } from "node:fs";
import { containerIdOf, draftFileCandidates, healDraftFiles, rebaseToContainer } from "../lib/containerPath.ts";

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

// ── healing: the file is found where it really is ──
const files = new Set([`${docsNow}drafts/draft_1/c1.mov`, `${docsNow}thumbnails/cover_1.jpg`]);
const exists = async (u) => files.has(u);
const odd = [{
  id: "draft_1",
  clips: [{ id: "c1", type: "video", uri: `file:///private/var/mobile/Containers/Data/Application/${OLD}/Documents/drafts/draft_1/c1.mov` }],
  coverThumbnailUri: `/var/mobile/Containers/Data/Application/${OLD}/Documents/thumbnails/cover_1.jpg`,
  editState: { state: { sourceUri: `file:///var/mobile/Containers/Data/Application/${OLD}/Documents/drafts/draft_1/c1.mov` } },
}];
const healed = await healDraftFiles(odd, docsNow, exists);
eq("heal: a clip in any old path form is found under Documents now", healed.drafts[0].clips[0].uri, `${docsNow}drafts/draft_1/c1.mov`);
eq("heal: the cover (bare path form) too", healed.drafts[0].coverThumbnailUri, `${docsNow}thumbnails/cover_1.jpg`);
eq("heal: the edit's source too", healed.drafts[0].editState.state.sourceUri, `${docsNow}drafts/draft_1/c1.mov`);
ok("heal: reports a change (so it is saved back)", healed.changed);
const moved = await healDraftFiles([{ id: "draft_1", clips: [{ uri: "file:///somewhere/else/c1.mov" }] }], docsNow, exists);
eq("heal: found by name in the draft's own folder", moved.drafts[0].clips[0].uri, `${docsNow}drafts/draft_1/c1.mov`);
const fine = [{ id: "draft_1", clips: [{ uri: `${docsNow}drafts/draft_1/c1.mov` }] }];
const same = await healDraftFiles(fine, docsNow, exists);
ok("heal: a draft whose files are there is untouched", !same.changed && same.drafts === fine);
const gone = await healDraftFiles([{ id: "d2", clips: [{ uri: "file:///x/Library/Caches/Camera/a.mov" }] }], docsNow, exists);
ok("heal: a file that is nowhere is left as it was", !gone.changed && gone.drafts[0].clips[0].uri === "file:///x/Library/Caches/Camera/a.mov");
eq("candidates for a Documents path", draftFileCandidates(`file:///old/Documents/drafts/d/c.mov`, "d", docsNow), [`${docsNow}drafts/d/c.mov`, `${docsNow}thumbnails/c.mov`]);

const provider = readFileSync(new URL("../providers/PostsProvider.tsx", import.meta.url), "utf8");
ok("drafts are rebased and healed when loaded (and saved back)", /rebaseToContainer\(stored, documentDirectory\)/.test(provider) && /healDraftFiles\(loaded, documentDirectory/.test(provider) && /if \(raw !== stored \|\| healed\.changed\) void AsyncStorage\.setItem\(DRAFTS_KEY/.test(provider));
ok("pending uploads are rebased when loaded", /rebaseToContainer\(storedPosts, documentDirectory\)/.test(provider));
const cleanup = readFileSync(new URL("../lib/storageCleanupCore.ts", import.meta.url), "utf8");
ok("the launch cleanup never deletes draft files", /DELETABLE[^\n]*new Set<Area>\(\[(?![^\]]*"drafts")/.test(cleanup));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
