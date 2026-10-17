#!/usr/bin/env node
/**
 * Coming back to the feed never disturbs the video playing: no re-ranked refetch after a short visit elsewhere, and
 * the iPhone's audio session is only reset when the camera changed it.
 *   node scripts/test-feed-return.mjs
 */
import { readFileSync } from "node:fs";
let failed = 0;
const ok = (name, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${name}`); };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const feed = read("../app/(tabs)/index.tsx");
const focus = read("../hooks/useVideoFocus.ts");
const tree = read("../app/post/[id]/reaction-tree.tsx");
const camera = read("../app/camera.tsx");
const audio = read("../lib/audioSession.ts");

ok("a short visit elsewhere: the feed is not refetched (no swap under your finger)", /if \(awayMs < FEED_STALE_AFTER_MS\) return;/.test(feed) && /const FEED_STALE_AFTER_MS = 5 \* 60_000;/.test(feed));
ok("the time away is measured from when the feed went out of view", /lastBlurAtRef\.current = Date\.now\(\);/.test(feed));
ok("the audio session is reset only after the camera changed it", /if \(!recordingMode\) return;/.test(audio) && /restorePlaybackMode\(\);/.test(focus) && /restorePlaybackMode\(\);/.test(tree));
ok("no screen sets the playback audio mode on every focus anymore", !/setAudioModeAsync/.test(focus) && !/setAudioModeAsync/.test(tree));
ok("the camera switches to recording on mount and back when it closes", /enterRecordingMode\(\);\n\s+return \(\) => restorePlaybackMode\(\);/.test(camera));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
