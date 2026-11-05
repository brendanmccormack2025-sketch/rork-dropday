#!/usr/bin/env node
/**
 * A clip whose stated length is longer than its file (camera-flip recordings): it is measured at the source, and every place
 * that builds or plays an edit clamps to the real length, drops clips that become empty, and never lets one bad clip block
 * playback, posting or saving.
 *   node --experimental-strip-types --no-warnings scripts/test-clip-bounds.mjs
 */
import { readFileSync } from "node:fs";
import { MIN_BOUNDED_CLIP_MS, boundedEnd, fileLengthMs, limitOf, measureAndSanitize, realLengthFromTiming, resetFileLengths, sanitizeClips, setFileLengthMs } from "../lib/clipBounds.ts";
import { renderEditOf, validateEdit } from "../lib/renderEdit.ts";
import { buildSegments, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// The reported case: 5 clips from camera flips; the 3rd claims 4200 ms but the file holds 3000; the 5th is empty (file 40 ms).
const claimed = [
  { id: "a", uri: "a.mov", type: "video", durationMs: 5000, trimStartMs: 0, trimEndMs: 5000 },
  { id: "b", uri: "b.mov", type: "video", durationMs: 2500, trimStartMs: 0, trimEndMs: 2500 },
  { id: "c", uri: "c.mov", type: "video", durationMs: 4200, trimStartMs: 0, trimEndMs: 4200 },
  { id: "d", uri: "d.mov", type: "video", durationMs: 1800, trimStartMs: 0, trimEndMs: 1800 },
  { id: "e", uri: "e.mov", type: "video", durationMs: 900, trimStartMs: 0, trimEndMs: 900 },
];
const real = { "a.mov": 5000, "b.mov": 2500, "c.mov": 3000, "d.mov": 1800, "e.mov": 40 };

eq("timing: end of the video track wins over a longer container", realLengthFromTiming({ durationMs: 4200, videoStartMs: 0, videoDurationMs: 3000, audioDurationMs: 4200 }), 3000);
eq("timing: video track that starts late", realLengthFromTiming({ durationMs: 4000, videoStartMs: 100, videoDurationMs: 3000 }), 3100);
eq("timing: no video track -> the asset duration; nothing -> null", [realLengthFromTiming({ durationMs: 1500, videoDurationMs: -1 }), realLengthFromTiming({ durationMs: -1 }), realLengthFromTiming(null)], [1500, null, null]);

resetFileLengths();
eq("unmeasured: the clip's own durationMs is the limit; a trimEnd past it is clamped", [limitOf(claimed[0]), boundedEnd({ uri: "x", trimStartMs: 0, trimEndMs: 9000, durationMs: 5000 })], [5000, 5000]);
eq("unmeasured and no durationMs: nothing is invented", boundedEnd({ uri: "x", trimStartMs: 0, trimEndMs: 9000 }), 9000);

// measured at the source
const probe = async (uri) => real[uri] ?? null;
resetFileLengths();
const measured = await measureAndSanitize(claimed, probe);
eq("measured: the clip that overstated its length is clamped to its file", measured.find((c) => c.id === "c"), { ...claimed[2], trimEndMs: 3000, durationMs: 3000 });
eq("measured: a clip that holds (almost) nothing is dropped; the others are untouched", [measured.map((c) => c.id), measured.find((c) => c.id === "a") === claimed[0]], [["a", "b", "c", "d"], true]);
eq("the measured lengths are remembered per file", [fileLengthMs("c.mov"), fileLengthMs("e.mov"), fileLengthMs("zzz")], [3000, 40, undefined]);

// clips arriving without durationMs get the measured one
resetFileLengths();
eq("a clip with no duration gets the measured one", (await measureAndSanitize([{ uri: "c.mov", type: "video" }], probe))[0], { uri: "c.mov", type: "video", durationMs: 3000 });

// a probe that fails, throws or hangs never blocks
resetFileLengths();
const t0 = Date.now();
const survivors = await measureAndSanitize(claimed, async (uri) => { if (uri === "a.mov") throw new Error("boom"); if (uri === "b.mov") return new Promise(() => {}); return real[uri] ?? null; }, 60);
eq("a failing or hanging probe leaves that file unmeasured (its own numbers stay); the rest is measured; it returns promptly", [survivors.map((c) => c.id), Date.now() - t0 < 1000, fileLengthMs("a.mov"), fileLengthMs("c.mov")], [["a", "b", "c", "d"], true, undefined, 3000]);

// the edit that is rendered / exported
resetFileLengths();
for (const [u, ms] of Object.entries(real)) setFileLengthMs(u, ms);
const r = renderEditOf(claimed);
eq("render edit: no 'clip beyond the end' problem; the bad clip is clamped, the empty one dropped", [r.problem, r.edit.map((e) => [e.uri, e.trimEndMs]), r.editMs], [null, [["a.mov", 5000], ["b.mov", 2500], ["c.mov", 3000], ["d.mov", 1800]], 12300]);
eq("the raw check is still there for a direct range", validateEdit([{ uri: "c.mov", trimStartMs: 0, trimEndMs: 4200 }], (u) => real[u]), "clip beyond the end of its file");
eq("every clip empty after clamping: an empty edit (the caller reports it), not an exception", renderEditOf([{ uri: "e.mov", type: "video", durationMs: 900, trimStartMs: 0, trimEndMs: 900 }]).problem, "empty edit");
eq("a trim start past the real end is dropped", sanitizeClips([{ uri: "c.mov", type: "video", durationMs: 4200, trimStartMs: 3500, trimEndMs: 4200 }]), []);
eq("a trim that keeps less than the minimum is dropped", sanitizeClips([{ uri: "c.mov", type: "video", trimStartMs: 3000 - MIN_BOUNDED_CLIP_MS + 1, trimEndMs: 4200 }]), []);
eq("images are left alone", sanitizeClips([{ uri: "i.jpg", type: "image" }]).length, 1);
const same = [claimed[0], claimed[1]];
eq("nothing to fix: the same array comes back (no needless re-render)", sanitizeClips(same) === same, true);

// playback: the segment table the gapless players follow never reaches past the file
const segs = buildSegments(claimed);
eq("playback plan: the bad clip ends at its file's end; the empty clip has no piece (indices stay); total is what exists", [segs.map((s) => s.srcEndMs), segs.map((s) => s.index), totalEditedMs(segs)], [[5000, 2500, 3000, 1800], [0, 1, 2, 3], 12300]);

const src = (p) => read(p);
eq("source: the camera measures the files before the editor opens", [/measureClips\(raw\)/.test(src("../app/camera.tsx"))], [true]);
eq("source: the editor probes the real length first and clamps a stale trim end", [/probeFileLengthMs\(clip\.uri\)/.test(src("../app/edit.tsx")), /Math\.min\(c\.trimEndMs, probed\.durationMs\)/.test(src("../app/edit.tsx"))], [true, true]);
eq("source: post, save and captions measure / clamp", [/measureClips\(rawClips\)/.test(src("../lib/renderAtPost.ts")), /measureClips\(rawClips\)/.test(src("../lib/exportEdit.ts")), /sanitizeClips\(rawClips\)/.test(src("../lib/transcription/useCaptions.ts")), /measureClips\(clipsRef\.current\)/.test(src("../app/edit.tsx"))], [true, true, true, true]);
eq("source: a multi-clip post whose render failed is not posted as raw pieces", /if \(!rendered && clips\.length > 1\) \{[\s\S]{0,260}Couldn't prepare your video/.test(src("../app/edit.tsx")), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
