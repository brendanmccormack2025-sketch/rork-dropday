#!/usr/bin/env node
/**
 * A clip is never dropped because a measurement says it is tiny while the recorder / player / container say it is long.
 * The video track's end is start + duration (a track may start after 0); when the probe is bogus the safest real value
 * (min of container and player) is used and both values are reported; a clip is dropped only if the FILE is empty by every
 * measure. The 4-clip flip recording (clips 2-4 with a non-zero track start) keeps all four, in order.
 *   node --experimental-strip-types --no-warnings scripts/test-clip-length.mjs
 */
import { readFileSync } from "node:fs";
import { decideLength, fileLengthMs, measureAndSanitize, realLengthFromTiming, resetFileLengths, resolveLength } from "../lib/clipBounds.ts";
import { buildSegments, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";
import { renderEditOf } from "../lib/renderEdit.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

// ── the decision ──
eq("track starting after 0: the end is start + duration", realLengthFromTiming({ durationMs: 3650, videoStartMs: 650, videoDurationMs: 3000 }), 3650);
eq("a clean file: the video end", decideLength({ containerMs: 3000, videoStartMs: 0, videoDurationMs: 3000 }).lengthMs, 3000);
eq("audio longer than video (moderately): the video track end is used", realLengthFromTiming({ durationMs: 4200, videoStartMs: 0, videoDurationMs: 3000 }), 3000);
{
  const d = decideLength({ containerMs: 3200, videoStartMs: 0, videoDurationMs: 12 });
  eq("a bogus tiny video duration with a long container: the container is used, flagged, NOT empty", [d.lengthMs, d.disagree, d.empty], [3200, true, false]);
}
{
  const d = decideLength({ containerMs: 3200, playerMs: 3000, videoStartMs: 0, videoDurationMs: 12 });
  eq("...with a player too: the safest real value, min(container, player)", d.lengthMs, 3000);
}
{
  const d = decideLength({ containerMs: null, videoDurationMs: 12, recorderMs: 3000 });
  eq("tiny measure, only the recorder says long: nothing reliable -> unknown (the clip is kept as it is), not empty", [d.lengthMs, d.empty], [null, false]);
}
{
  const d = decideLength({ containerMs: 40, videoStartMs: 0, videoDurationMs: 30 });
  eq("empty by every measure: empty", [d.empty, d.lengthMs], [true, 40]);
}
eq("empty container but the recorder says it ran for seconds: NOT empty", decideLength({ containerMs: 30, videoDurationMs: -1, recorderMs: 2500 }).empty, false);
eq("nothing known at all: unknown, not empty", decideLength({}), { lengthMs: null, empty: false, disagree: false, videoEndMs: null });

// ── what is reported when the measures disagree ──
{
  const reports = [];
  const io = {
    timing: async () => ({ durationMs: 3200, videoStartMs: 0, videoDurationMs: 12, audioDurationMs: 3200 }),
    playerMs: async () => 3000,
    fileSize: async () => 456789,
    recorderMs: () => 3100,
    report: (i) => reports.push(i),
  };
  const len = await resolveLength("f.mov", io);
  eq("resolveLength: uses min(container, player) and reports both values with the file size", [len, reports.length, reports[0]?.containerMs, reports[0]?.playerMs, reports[0]?.videoEndMs, reports[0]?.fileSize, reports[0]?.recorderMs, reports[0]?.usedMs], [3000, 1, 3200, 3000, 12, 456789, 3100, 3000]);
  const quiet = [];
  await resolveLength("g.mov", { timing: async () => ({ durationMs: 3000, videoStartMs: 0, videoDurationMs: 3000 }), report: (i) => quiet.push(i) });
  eq("resolveLength: agreeing measures report nothing", quiet.length, 0);
  eq("resolveLength: a probe that throws is just unknown", await resolveLength("h.mov", { timing: async () => { throw new Error("x"); } }), null);
}

// ── the 4-clip flip recording with non-zero track starts ──
const startOf = { "c1.mov": 0, "c2.mov": 400, "c3.mov": 650, "c4.mov": 900 };
const durOf = { "c1.mov": 3100, "c2.mov": 2500, "c3.mov": 4000, "c4.mov": 1800 };
const timing = (uri) => ({ durationMs: startOf[uri] + durOf[uri], videoStartMs: startOf[uri], videoDurationMs: durOf[uri], audioStartMs: 0, audioDurationMs: startOf[uri] + durOf[uri] });
const truth = Object.fromEntries(Object.keys(startOf).map((u) => [u, startOf[u] + durOf[u]]));
const flip = Object.keys(truth).map((u, i) => ({ id: `c${i + 1}`, uri: u, type: "video", durationMs: truth[u] + (i === 2 ? 1200 : 0), trimStartMs: 0, trimEndMs: truth[u] + (i === 2 ? 1200 : 0) }));   // clip 3 overstates its length
resetFileLengths();
const ioFor = (bogus) => ({ timing: async (u) => (bogus && u !== "c1.mov" ? { ...timing(u), videoDurationMs: 9 } : timing(u)), playerMs: async (u) => truth[u], recorderMs: (u) => truth[u] });
for (const [label, bogus] of [["real timing", false], ["a probe that reports ~0 for the flipped clips", true]]) {
  resetFileLengths();
  const reports = [];
  const probe = (uri) => resolveLength(uri, { ...ioFor(bogus), report: (i) => reports.push(i) });
  const out = await measureAndSanitize(flip, probe);
  eq(`flip, ${label}: all 4 clips survive, in order`, out.map((c) => c.id), ["c1", "c2", "c3", "c4"]);
  eq(`flip, ${label}: every clip ends at its file's real length (clip 3's overstated length is clamped)`, out.map((c) => c.trimEndMs), Object.values(truth));
  eq(`flip, ${label}: nothing is reported when the measures agree; both values are when they do not`, reports.length, bogus ? 3 : 0);
  const segs = buildSegments(out);
  eq(`flip, ${label}: the playback plan and the render edit have four pieces and the real total`, [segs.length, totalEditedMs(segs), renderEditOf(out).edit.length, renderEditOf(out).problem], [4, Object.values(truth).reduce((a, b) => a + b, 0), 4, null]);
}

// ── only an empty FILE drops its clip ──
resetFileLengths();
const mixed = [
  { id: "a", uri: "c1.mov", type: "video", durationMs: 3100, trimStartMs: 0, trimEndMs: 3100 },
  { id: "e", uri: "empty.mov", type: "video", durationMs: 900, trimStartMs: 0, trimEndMs: 900 },
];
const out2 = await measureAndSanitize(mixed, (u) => resolveLength(u, { timing: async () => (u === "empty.mov" ? { durationMs: 30, videoStartMs: 0, videoDurationMs: 20 } : timing(u)) }));
eq("a file that is empty by every measure loses its clip; the other stays", out2.map((c) => c.id), ["a"]);
resetFileLengths();
const out3 = await measureAndSanitize(mixed, (u) => resolveLength(u, { timing: async () => (u === "empty.mov" ? { durationMs: 20, videoStartMs: 0, videoDurationMs: 20 } : timing(u)), recorderMs: (u) => (u === "empty.mov" ? 900 : null) }));
eq("...but not when the recorder says it ran for 900 ms (kept with its own numbers)", [out3.map((c) => c.id), fileLengthMs("empty.mov")], [["a", "e"], undefined]);

// ── wiring ──
const cm = readFileSync(new URL("../lib/clipMeasure.ts", import.meta.url), "utf8"), cam = readFileSync(new URL("../app/camera.tsx", import.meta.url), "utf8");
eq("clipMeasure: cross-checks with the player and the recorder, reports both values with the file size", [/playerMs: playerDurationMs/.test(cm), /recorderMs: \(uri\) => hint\.get\(uri\)/.test(cm), /kind: "clipLength"/.test(cm), /fileSize/.test(cm)], [true, true, true, true]);
eq("camera: the recorder's timing is a cross-check only (stripped before the editor)", [/const raw = usableSegments\(clips\);/.test(cam), /measuredMs: _m/.test(cam)], [true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
