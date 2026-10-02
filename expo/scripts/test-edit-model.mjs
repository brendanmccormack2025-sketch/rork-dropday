#!/usr/bin/env node
/**
 * Tests lib/editModel.ts. No test framework needed:
 *
 *   node --experimental-strip-types scripts/test-edit-model.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import {
  keepRangesToClips,
  clipsToSegments,
  outputDurationMs,
  sourceToOutputMs,
  outputToSourceMs,
  getOutputTimeMs,
} from "../lib/editModel.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

const URI = "file:///a.mov";

// 0 cuts: one keep range = whole video
const c0 = keepRangesToClips(URI, [{ startMs: 0, endMs: 10000 }]);
eq("0 cuts: one clip", c0, [{ uri: URI, trimStartMs: 0, trimEndMs: 10000 }]);
eq("0 cuts: duration", outputDurationMs(c0), 10000);
eq("0 cuts: source->output identity", sourceToOutputMs(c0, 4000), 4000);
eq("0 cuts: output->source identity", outputToSourceMs(c0, 4000), 4000);

// 1 cut: remove 3000-5000 of a 10000ms video
const c1 = keepRangesToClips(URI, [
  { startMs: 5000, endMs: 10000 },
  { startMs: 0, endMs: 3000 },
]);
eq("1 cut: sorted clips", c1.map((c) => [c.trimStartMs, c.trimEndMs]), [[0, 3000], [5000, 10000]]);
eq("1 cut: duration", outputDurationMs(c1), 8000);
eq("1 cut: before cut", sourceToOutputMs(c1, 2000), 2000);
eq("1 cut: after cut", sourceToOutputMs(c1, 6000), 4000);
eq("1 cut: inside cut -> null", sourceToOutputMs(c1, 4000), null);
eq("1 cut: output->source before seam", outputToSourceMs(c1, 2999), 2999);
eq("1 cut: output->source at seam", outputToSourceMs(c1, 3000), 5000);
eq("1 cut: output->source after seam", outputToSourceMs(c1, 4000), 6000);

// Boundaries
eq("boundary: cut start belongs to the cut -> null", sourceToOutputMs(c1, 3000), null);
eq("boundary: cut end is the next clip start", sourceToOutputMs(c1, 5000), 3000);
eq("boundary: source 0", sourceToOutputMs(c1, 0), 0);
eq("boundary: very end of last clip", sourceToOutputMs(c1, 10000), 8000);
eq("boundary: past the end -> null", sourceToOutputMs(c1, 10001), null);
eq("boundary: negative -> null", sourceToOutputMs(c1, -1), null);
eq("boundary: output end", outputToSourceMs(c1, 8000), 10000);
eq("boundary: output past end -> null", outputToSourceMs(c1, 8001), null);
eq("boundary: output negative -> null", outputToSourceMs(c1, -1), null);

// 5 cuts -> 6 clips from a 60000ms video
const keeps5 = [
  [0, 8000], [10000, 20000], [22000, 30000], [33000, 45000], [47000, 55000], [56000, 60000],
].map(([startMs, endMs]) => ({ startMs, endMs }));
const c5 = keepRangesToClips(URI, keeps5);
eq("5 cuts: six clips", c5.length, 6);
eq("5 cuts: duration", outputDurationMs(c5), 8000 + 10000 + 8000 + 12000 + 8000 + 4000);
eq("5 cuts: start of clip 4", sourceToOutputMs(c5, 33000), 8000 + 10000 + 8000);
eq("5 cuts: inside 2nd cut", sourceToOutputMs(c5, 21000), null);
eq("5 cuts: inside 5th cut", sourceToOutputMs(c5, 55500), null);
eq("5 cuts: round trip", sourceToOutputMs(c5, outputToSourceMs(c5, 37000)), 37000);
const { segments, trimData } = clipsToSegments(c5);
eq("5 cuts: segments repeat the one URI", new Set(segments).size, 1);
eq("5 cuts: segments length", segments.length, 6);
eq("5 cuts: trim_data first", trimData[0], { trimStartMs: 0, trimEndMs: 8000 });
eq("5 cuts: trim_data last", trimData[5], { trimStartMs: 56000, trimEndMs: 60000 });

// Empty / degenerate ranges
eq("empty range dropped", keepRangesToClips(URI, [{ startMs: 5, endMs: 5 }]), []);
eq("no clips: duration 0", outputDurationMs([]), 0);
eq("no clips: source->output null", sourceToOutputMs([], 0), null);
eq("no clips: output->source null", outputToSourceMs([], 0), null);

// Several source files: sourceUri disambiguates
const multi = [
  { uri: "a", trimStartMs: 0, trimEndMs: 1000 },
  { uri: "b", trimStartMs: 0, trimEndMs: 1000 },
];
eq("multi source: b at 500", sourceToOutputMs(multi, 500, "b"), 1500);
eq("multi source: a at 500", sourceToOutputMs(multi, 500, "a"), 500);

// getOutputTimeMs (playback)
eq("playback: seg 0 start", getOutputTimeMs(0, 0, trimData), 0);
eq("playback: seg 1 at its trimStart", getOutputTimeMs(1, 10000, trimData), 8000);
eq("playback: seg 1 mid", getOutputTimeMs(1, 15000, trimData), 13000);
eq("playback: position before trimStart clamps", getOutputTimeMs(2, 21000, trimData), 18000);
eq("playback: position past trimEnd clamps", getOutputTimeMs(0, 8120, trimData), 8000);
eq("playback: last seg end", getOutputTimeMs(5, 60000, trimData), outputDurationMs(c5));
eq("playback: no trims", getOutputTimeMs(0, 500, []), 0);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
