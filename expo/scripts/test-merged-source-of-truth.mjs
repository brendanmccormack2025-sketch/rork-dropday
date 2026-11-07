#!/usr/bin/env node
/**
 * After a merge the merged file is the single source of truth: one clip, the render's verified length, which no player event,
 * clamp or plan can shorten. The device failure: a status event carrying the first clip's length (~6.4 s) rewrote the merged
 * clip's durationMs, the clamp then trusted it, and playback, captions and the render all stopped at 6.4 s.
 *   node --experimental-strip-types --no-warnings scripts/test-merged-source-of-truth.mjs
 */
import { readFileSync } from "node:fs";
import { applyPlayerDuration, boundedEnd, fileLengthMs, resetFileLengths, sanitizeClips, setFileLengthMs } from "../lib/clipBounds.ts";
import { pinMergedLength } from "../lib/mergedSource.ts";
import { cutRangesOf, describeClips, summarizePlan } from "../lib/autoEdit/planSummary.ts";
import { makeDecision, newEditState, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { buildSegments, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";
import { renderEditOf } from "../lib/renderEdit.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// The device case: 4 camera-flip clips (clip 0 is 6.4 s), merged to 18633 ms.
const MERGED = "file:///cache/render_merged.mp4";
const MERGED_MS = 18633;
const merged = { uri: MERGED, durationMs: MERGED_MS };
const mergedClip = { id: "m1", uri: MERGED, type: "video", durationMs: MERGED_MS, trimStartMs: 0, trimEndMs: MERGED_MS };

// The AI plan: hook trim, a long pause cut and an um cut; everything after 6.4 s is in play.
const cut = (type, a, b) => makeDecision(type, a, b, { origin: "ai" });
const state = newEditState(MERGED, [cut("hookTrim", 0, 2703), cut("silenceCut", 6500, 13233), cut("umCut", 14000, 16300)]);
const keep = renderClipsOf(state, MERGED_MS);
const expectedKept = MERGED_MS - (2703 + 6733 + 2300);
const produce = (base) => keep.map((c, i) => ({ ...base, id: `p${i}`, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));

eq("the plan keeps footage after 6.4 s of the merged file", [keep.map((c) => [c.trimStartMs, c.trimEndMs]), summarizePlan(state, MERGED_MS).keptMs], [[[2703, 6500], [13233, 14000], [16300, 18633]], expectedKept]);
eq("the plan's cut ranges are in the merged file's timeline", cutRangesOf(state), [[0, 2703], [6500, 13233], [14000, 16300]]);

// ── the bug, reproduced: the stale length (6400) lands on the merged clip and nothing knows the real length ──
resetFileLengths();
const polluted = produce({ ...mergedClip, durationMs: 6400 });
eq("WITHOUT the fix: a stale durationMs clamps the plan's ranges at 6.4 s (what the device did)", [boundedEnd(polluted[2]), buildSegments(polluted).length], [6400, 1]);

// ── the fix ──
setFileLengthMs(MERGED, MERGED_MS);                  // registered when the merge finishes
eq("the merged length is registered", fileLengthMs(MERGED), MERGED_MS);
eq("a player status event with the FIRST clip's length does not touch the merged clip", applyPlayerDuration(mergedClip, 6400), null);
eq("...nor shrinks a plan's pieces of it", produce(mergedClip).map((c) => applyPlayerDuration(c, 6400)), [null, null, null]);
eq("a file nobody measured still takes the player's number", applyPlayerDuration({ uri: "u.mov", type: "video" }, 5000), { uri: "u.mov", type: "video", durationMs: 5000, trimEndMs: 5000 });
const repaired = pinMergedLength(polluted, merged);
eq("pinMergedLength repairs a clip that carries the wrong length: the verified length, the trim end kept", repaired.map((c) => [c.durationMs, c.trimEndMs]), keep.map((c) => [MERGED_MS, c.trimEndMs]));
eq("pinMergedLength: a trim end past the end comes back; a missing one becomes the end; other files and a null merge are untouched", [pinMergedLength([{ uri: MERGED, trimEndMs: 99999 }], merged)[0].trimEndMs, pinMergedLength([{ uri: MERGED }], merged)[0].trimEndMs, pinMergedLength([{ uri: "o.mov", durationMs: 5 }], merged)[0].durationMs, pinMergedLength(polluted, null) === polluted], [MERGED_MS, MERGED_MS, 5, true]);
const fine = [mergedClip];
eq("pinMergedLength: nothing to fix returns the same array", pinMergedLength(fine, merged) === fine, true);

// ── everything that follows covers the full merged length ──
const produced = pinMergedLength(produce({ ...mergedClip, durationMs: 6400 }), merged);
const segs = buildSegments(produced);
eq("playback plan (virtual timeline / gapless): three pieces ending at the merged file's end, the kept length in full", [segs.map((s) => [s.srcStartMs, s.srcEndMs]), totalEditedMs(segs)], [[[2703, 6500], [13233, 14000], [16300, 18633]], expectedKept]);
const re = renderEditOf(produced);
eq("render edit (post and save): the same three ranges, no problem, the kept length", [re.edit.map((e) => [e.trimStartMs, e.trimEndMs]), re.problem, re.editMs], [[[2703, 6500], [13233, 14000], [16300, 18633]], null, expectedKept]);
eq("captions' clamp (sanitizeClips): nothing is cut short or dropped, the same array", sanitizeClips(produced) === produced, true);
eq("the unedited merged clip also covers the whole file", [buildSegments([mergedClip]).map((s) => s.srcEndMs), renderEditOf([mergedClip]).editMs], [[MERGED_MS], MERGED_MS]);

// ── the breadcrumb data ──
eq("describeClips: uri tail, trims and length", describeClips([mergedClip]), [{ uri: MERGED.slice(-20), trimStart: 0, trimEnd: MERGED_MS, durationMs: MERGED_MS }]);

// ── wiring ──
const ed = read("../app/edit.tsx");
eq("editor: after the merge the length is registered, ONE clip replaces the parts, and the editor's clip list is logged", [/setFileLengthMs\(result\.clip\.uri, result\.clip\.durationMs\)/.test(ed), /replaceClips\(\[result\.clip\]\)/.test(ed), /recordBreadcrumb\("merge: editor clips"/.test(ed)], [true, true, true]);
eq("editor: replaceClips pins the merged length; the status handler uses applyPlayerDuration", [/pinMergedLength\(enforced, mergedRef\.current\)/.test(ed), /applyPlayerDuration\(clip, sourceDur\)/.test(ed)], [true, true]);
eq("editor: both plans log the clips and cut ranges after they are applied", [/recordBreadcrumb\("ai edit: silence plan applied"/.test(ed), /recordBreadcrumb\("ai edit: transcript plan applied"/.test(ed)], [true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
