#!/usr/bin/env node
/**
 * Reactions open instantly: preloaded from the feed, shown without waiting, playback not held back, videos cached.
 *   node scripts/test-reactions-speed.mjs
 */
import { readFileSync } from "node:fs";
let failed = 0;
const ok = (name, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${name}`); };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const tree = read("../app/post/[id]/reaction-tree.tsx");
const list = read("../components/FeedListView.tsx");
const q = read("../lib/reactionsQuery.ts");

ok("the feed preloads the reactions of the post on screen", /prefetchReactions\(qc, activePost\)/.test(list));
ok("no reactions: known empty without a request", /reaction_count === 0/.test(q) && /setQueryData<Post\[\]>\(reactionsKey\(post\.id\), \[\]\)/.test(q));
ok("the post's own row comes from the feed (no request)", /setQueryData<RootDrop>\(rootDropKey\(post\.id\)/.test(q));
ok("the screen and the preload share the same keys and fetch", /queryKey: reactionsKey\(id \?\? ""\)/.test(tree) && /queryFn: \(\) => fetchReactions\(id!\)/.test(tree) && /queryFn: \(\) => fetchRootDrop\(id!\)/.test(tree));
ok("cached reactions show at once and refresh in the background", /refetchOnMount: "always"/.test(tree) && /const isLoading = tier1Query\.isPending && !tier1Query\.data && pendingTier1\.length === 0;/.test(tree));
ok("playback is not held back until 'interactions' finish", !/runAfterInteractions/.test(tree) && /setScreenFocused\(true\);/.test(tree));
ok("reaction videos are cached on the phone", /uri: post\.media_url, useCaching: post\.media_url\.startsWith\("http"\)/.test(tree));
ok("cover images of the first reactions are preloaded", /Image\.prefetch\(covers\)/.test(q));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
