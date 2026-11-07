#!/usr/bin/env node
/**
 * The merge of a mixed front/back camera recording: what is checked about the result (every clip's picture AND sound in
 * the file, each with its own orientation), the plan summary breadcrumb, and the guard that stops the AI cutting a
 * merged multi-clip video down to a fraction. The native renderer itself cannot run here, so its source is checked for the
 * structure that matters (both tracks inserted for every clip, own transform and instruction per clip, full coverage).
 *   node --experimental-strip-types --no-warnings scripts/test-merge-result.mjs
 */
import { readFileSync } from "node:fs";
import { mergeTimingReport } from "../lib/mergeTiming.ts";
import { MAX_AUTO_CUT_FRACTION, blocksAutoCuts, summarizePlan } from "../lib/autoEdit/planSummary.ts";
import { makeDecision, newEditState, setDecisionState } from "../lib/autoEdit/decisions.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── the 4-clip front/back merge (the device log: 4433 / 3265 / 4998 / 2332 ms) ──
const clipsMs = [4433, 3265, 4998, 2332];
const total = clipsMs.reduce((a, b) => a + b, 0);
const front = { rotationDeg: 90, mirrored: true, naturalWidth: 1080, naturalHeight: 1920 };
const back = { rotationDeg: 90, mirrored: false, naturalWidth: 1080, naturalHeight: 1920 };
const part = (i, o = {}) => ({ index: i, durationMs: clipsMs[i], hasAudio: true, videoInsertedMs: clipsMs[i], audioInsertedMs: clipsMs[i], ...(i % 2 === 0 ? front : back), appliedTransform: [0, 1, -1, 0, 1080, 0], ...o });
const timingOf = (ms) => ({ durationMs: ms, videoStartMs: 0, videoDurationMs: ms, audioStartMs: 0, audioDurationMs: ms });
const sources = clipsMs.map(timingOf);
const merged = { ...timingOf(total), videoSegments: 4, audioSegments: 4 };

{
  const r = mergeTimingReport(sources, merged, 3, { parts: clipsMs.map((_, i) => part(i)) });
  eq("front/back merge, every clip's picture and sound in: no issues, 4 pieces of each, the orientation per clip is reported", [r.issues, r.mergedVideoSegments, r.mergedAudioSegments, r.parts.map((p) => [p.mirrored, p.rotationDeg])], [[], 4, 4, [[true, 90], [false, 90], [true, 90], [false, 90]]]);
  eq("...and the length is the sum of the clips", [r.sourceSumMs, r.mergedDurationMs, r.lengthDiffMs], [total, total, 0]);
}
{
  const parts = clipsMs.map((_, i) => part(i, i > 0 ? { audioInsertedMs: 0 } : {}));
  const r = mergeTimingReport(sources, { ...merged, audioDurationMs: clipsMs[0], audioSegments: 1 }, 3, { parts });
  eq("clips 2-4 without sound: each is named, and the short merged sound is flagged", [r.issues.filter((x) => /clip \d: only 0 of/.test(x)).length, r.issues.some((x) => /merged sound is/.test(x))], [3, true]);
}
{
  const parts = clipsMs.map((_, i) => part(i, i > 0 ? { videoInsertedMs: 0 } : {}));
  const r = mergeTimingReport(sources, merged, 3, { parts });
  eq("clips 2-4 without picture: each is named", r.issues.filter((x) => /of picture went in/.test(x)).length, 3);
}
eq("no sound at all in the merged file (the clips had sound): flagged", mergeTimingReport(sources, { ...merged, audioDurationMs: -1, audioSegments: 0 }, 3, { parts: clipsMs.map((_, i) => part(i)) }).issues.some((x) => /no sound/.test(x)), true);
eq("an older build (no parts, no segments) still reports as before", mergeTimingReport(sources, timingOf(total), 3).issues, []);

// ── the AI plan in numbers, and the guard ──
const SOURCE = total;   // the merged file
const cut = (type, a, b) => makeDecision(type, a, b, { origin: "ai" });
const state = newEditState("merged.mp4", [cut("silenceCut", 1000, 2000), cut("silenceCut", 5000, 5600), cut("hookTrim", 0, 400), cut("umCut", 9000, 9200), cut("fillerCut", 12000, 12100)]);
{
  const s = summarizePlan(state, SOURCE);
  eq("plan summary: kept ms, cuts, and how much each rule removes", [s.sourceMs, s.keptMs, s.removedMs, s.cuts, s.rules.silenceCut, s.rules.hookTrim, s.rules.umCut, s.rules.fillerCut], [SOURCE, SOURCE - 2300, 2300, 5, { cuts: 2, ms: 1600 }, { cuts: 1, ms: 400 }, { cuts: 1, ms: 200 }, { cuts: 1, ms: 100 }]);
  const reverted = setDecisionState(state, state.decisions[0].id, "reverted");
  eq("a reverted cut is not counted", summarizePlan(reverted, SOURCE).cuts, 4);
  eq("the removed share", summarizePlan(state, SOURCE).removedFraction, Math.round((2300 / SOURCE) * 1000) / 1000);
}
{
  // the plan that removes clips 2-4 as silence: everything after the first clip
  const eatsRest = newEditState("merged.mp4", [cut("silenceCut", clipsMs[0], SOURCE)]);
  const s = summarizePlan(eatsRest, SOURCE);
  eq("a plan that removes clips 2-4 keeps only the first clip", [s.keptMs, s.removedFraction > 0.7], [clipsMs[0], true]);
  eq("guard: that plan is NOT applied automatically to a merged multi-clip video", blocksAutoCuts({ sourceMs: SOURCE, keptMs: s.keptMs, multiClip: true }), true);
  eq("guard: the same plan on a single recording is left to the existing rules", blocksAutoCuts({ sourceMs: SOURCE, keptMs: s.keptMs, multiClip: false }), false);
  const edge = (frac) => blocksAutoCuts({ sourceMs: 10000, keptMs: Math.round(10000 * (1 - frac)), multiClip: true });
  eq("guard threshold: exactly 60% is allowed, a little over is not", [MAX_AUTO_CUT_FRACTION, edge(0.6), edge(0.61), edge(0.3), edge(0)], [0.6, false, true, false, false]);
  eq("guard: nothing to guard on an empty source", blocksAutoCuts({ sourceMs: 0, keptMs: 0, multiClip: true }), false);
}

// ── the native renderer's structure (its source; it cannot run here) ──
const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
const loop = swift.slice(swift.indexOf("for clip in clips {"), swift.indexOf("guard !segments.isEmpty"));
eq("renderer: every clip's picture AND sound are inserted inside the one loop over the clips", [/insertAligned\(videoTrack, from: sourceVideo/.test(loop), /insertAligned\(audioTrack, from: sourceAudio/.test(loop)], [true, true]);
eq("renderer: each clip records its own orientation (rotation, mirrored), the matrix applied and how much picture / sound went in", [/"mirrored": \(pt\.a \* pt\.d - pt\.b \* pt\.c\) < 0/.test(loop), /"rotationDeg"/.test(loop), /"appliedTransform"/.test(loop), /"videoInsertedMs"/.test(loop), /"audioInsertedMs"/.test(loop)], [true, true, true, true, true]);
const instr = swift.slice(swift.indexOf("// ── Video: one instruction per clip"), swift.indexOf("videoComposition.instructions = instructions"));
eq("renderer: one layer instruction per clip with its OWN transform, the last one reaching the end of the composition", [/for \(i, seg\) in segments\.enumerated\(\)/.test(instr), /layer\.setTransform\(segmentTransform\(seg, index: i, settings: settings\), at: seg\.compStart\)/.test(instr), /isLast \? totalDuration/.test(instr)], [true, true, true]);
eq("renderer: the result carries the parts and the pieces of each composition track; the probe counts pieces too", [/"parts": partInfo/.test(swift), /"videoSegments": videoTrack\.segments/.test(swift), /"audioSegments": audioTrack\?\.segments/.test(swift), /"videoSegments": video\.map/.test(swift)], [true, true, true, true]);

// ── wiring ──
const mn = read("../lib/mergeNative.ts"), ed = read("../app/edit.tsx");
eq("merge: the result is probed and one breadcrumb carries video/audio ms, segment counts and per-clip orientation", [/crumb\("result"/.test(mn), /videoSegments/.test(mn), /audioSegments/.test(mn), /mirrored: p\.mirrored/.test(mn), /rot: p\.rotationDeg/.test(mn)], [true, true, true, true, true]);
eq("editor: both AI plans leave a summary breadcrumb and are guarded for merged videos", [/recordBreadcrumb\("ai edit: silence plan"/.test(ed), /recordBreadcrumb\("ai edit: transcript plan"/.test(ed), (ed.match(/blocksAutoCuts\(/g) ?? []).length, /kind: "autoCutGuard"/.test(ed)], [true, true, 2, true]);
eq("editor: a player event never rewrites a file whose length is known (merged included)", [/applyPlayerDuration\(clip, sourceDur\)/.test(ed), /setFileLengthMs\(result\.clip\.uri/.test(ed)], [true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
