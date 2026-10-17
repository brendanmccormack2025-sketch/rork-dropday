#!/usr/bin/env node
/**
 * Reactions are posted straight from the camera (no edit choice, no editor, no Post screen), show up at once, and
 * the reaction count on a post is fresh.
 *   node --experimental-strip-types --no-warnings scripts/test-quick-reactions.mjs
 */
import { readFileSync } from "node:fs";
import { postReactionNow, reactionCountOf, REACTION_FAILED_TEXT } from "../lib/postReactionCore.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function fakeDeps(over = {}) {
  const log = [];
  const deps = {
    merge: async (uris) => (log.push(["merge", uris]), { ok: true, uri: "cache/joined.mov" }),
    stage: async (uri) => (log.push(["stage", uri]), `uploads/${uri.split("/").pop()}`),
    thumbnail: async (uri) => (log.push(["thumb", uri]), "thumbs/c.jpg"),
    discard: async (uri) => void log.push(["discard", uri]),
    addOptimistic: (payload, parent) => (log.push(["optimistic", payload, parent]), "opt_1"),
    upload: (u) => void log.push(["upload", u]),
    ...over,
  };
  return { deps, log };
}

{
  const { deps, log } = fakeDeps();
  const r = await postReactionNow([{ uri: "cam/a.mov", type: "video" }], "P", deps);
  eq("one segment: staged, cover taken, shown at once, uploaded (no merge)", [r, log.map((l) => l[0])], [{ ok: true, tempId: "opt_1" }, ["stage", "thumb", "optimistic", "upload"]]);
  eq("the upload is the reaction to the right post", log.find((l) => l[0] === "upload")[1], { uri: "uploads/a.mov", mediaType: "video", parentPostId: "P", thumbnailUri: "thumbs/c.jpg", optimisticTempId: "opt_1" });
}
{
  const { deps, log } = fakeDeps();
  await postReactionNow([{ uri: "cam/a.mov", type: "video" }, { uri: "cam/b.mov", type: "video" }], "P", deps);
  eq("a camera flip (two segments) is joined into one video first, then the joined temp file is removed", log.map((l) => l[0]), ["merge", "stage", "discard", "thumb", "optimistic", "upload"]);
  eq("...in recording order", log[0][1], ["cam/a.mov", "cam/b.mov"]);
}
{
  const { deps, log } = fakeDeps({ merge: async () => ({ ok: false, message: "x" }) });
  eq("a failed join: nothing is posted, a clear message", [await postReactionNow([{ uri: "a", type: "video" }, { uri: "b", type: "video" }], "P", deps), log.length], [{ ok: false, message: REACTION_FAILED_TEXT }, 0]);
}
{
  const { deps, log } = fakeDeps({ stage: async () => { throw new Error("disk"); } });
  eq("a failed copy: nothing shown or uploaded", [(await postReactionNow([{ uri: "a", type: "video" }], "P", deps)).ok, log.filter((l) => l[0] === "optimistic" || l[0] === "upload").length], [false, 0]);
}
{
  const { deps, log } = fakeDeps({ thumbnail: async () => { throw new Error("no frame"); } });
  const r = await postReactionNow([{ uri: "a", type: "video" }], "P", deps);
  eq("no cover frame is not a failure", [r.ok, "thumbnailUri" in log.find((l) => l[0] === "upload")[1]], [true, false]);
}
eq("nothing recorded: not posted", (await postReactionNow([], "P", fakeDeps().deps)).ok, false);

eq("count: the post's own list when cached, plus my uploads", reactionCountOf({ cached: [{ id: "1" }, { id: "2" }], serverCount: 9, recent: [], pending: 1 }), 3);
eq("count: no list cached -> the server count (or the recent list if larger), plus my uploads", reactionCountOf({ cached: undefined, serverCount: 4, recent: [{ id: "a" }], pending: 1 }), 5);
eq("count: nothing known -> my uploads", reactionCountOf({ cached: undefined, serverCount: undefined, recent: undefined, pending: 2 }), 2);

const camera = read("../app/camera.tsx");
const feedItem = read("../components/FeedItem.tsx");
const tree = read("../app/post/[id]/reaction-tree.tsx");
const provider = read("../providers/PostsProvider.tsx");
ok("camera: the check button posts a reaction directly (the editor only for new posts)", /onPress=\{isReaction \? \(\) => void postReaction\(\) : goToEdit\}/.test(camera) && /const isReaction = !!\(reactingTo \|\| rootDropId\);/.test(camera));
ok("camera: one post at a time, spinner while posting", /postingReactionRef\.current\) return;/.test(camera) && /postingReaction \? <ActivityIndicator/.test(camera));
ok("camera: after posting, the reactions of the post open", /router\.replace\(`\/post\/\$\{rootDropId \|\| reactingTo\}\/reaction-tree` as never\);/.test(camera));
ok("camera: a failure keeps the recording and says so", /Alert\.alert\(result\.message/.test(camera));
ok("reactions screen: my uploading reactions show at once (not deletable or reportable yet)", /for \(const reaction of \[\.\.\.pendingTier1, \.\.\.rankedTier1Posts\]\)/.test(tree) && /const isPending = post\.id\.startsWith\("opt_"\);/.test(tree));
ok("reactions screen: a local file is played without the web cache", /useCaching: post\.media_url\.startsWith\("http"\)/.test(tree));
ok("feed: the count follows the post's reactions list and my uploads", /reactionCountOf\(\{\n\s+cached: cachedReactions,/.test(feedItem) && /enabled: false,/.test(feedItem));
ok("a posted reaction never turns an unknown list into a list of one (undercount)", /\/\/ no list cached yet: leave it[^\n]*\n\s+if \(!old\) return old;/.test(provider));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
