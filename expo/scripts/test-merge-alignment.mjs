#!/usr/bin/env node
/**
 * Merged files: audio on the video's clock, loudness as long as the video, analysis only on the finished merged file.
 *   node --experimental-strip-types scripts/test-merge-alignment.mjs
 */
import { readFileSync } from "node:fs";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { analysisSource, loadLoudnessChecked, loudnessAgrees, mergeTimingReport } from "../lib/mergeTiming.ts";
import { mergeVideoClips } from "../lib/mergeClips.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const t = (o = {}) => ({ durationMs: 55000, videoStartMs: 0, videoDurationMs: 55000, audioStartMs: 0, audioDurationMs: 55000, ...o });

// ── timing report ──
{
  const good = mergeTimingReport([t(), t(), t()], t({ durationMs: 165000, videoDurationMs: 165000, audioDurationMs: 165000 }), 2);
  eq("an aligned merge has no issues; the numbers are reported", [good.issues, good.sourceSumMs, good.mergedDurationMs, good.audioOffsetMs, good.lengthDiffMs], [[], 165000, 165000, 0, 0]);
  const late = mergeTimingReport([t(), t(), t()], t({ durationMs: 165000, videoDurationMs: 165000, audioStartMs: 180, audioDurationMs: 164820 }), 2);
  eq("audio starting 180 ms after the video is an issue (and reported as the offset)", [late.audioOffsetMs, late.issues.length > 0], [180, true]);
  const drift = mergeTimingReport([t(), t(), t()], t({ durationMs: 165900, videoDurationMs: 165900, audioDurationMs: 165900 }), 2);
  eq("a merged length off the sum of the parts is an issue", drift.lengthDiffMs, 900);
  ok("(and flagged)", drift.issues.some((i) => /sum of the parts/.test(i)));
  eq("frame rounding at the joins is not an issue", mergeTimingReport([t(), t()], t({ durationMs: 110040, videoDurationMs: 110040, audioDurationMs: 110040 }), 1).issues, []);
  eq("each source's own audio offset is listed", mergeTimingReport([t({ audioStartMs: 70 }), t(), t({ audioStartMs: -1 })], t({ durationMs: 165000 }), 2).sourceAudioOffsetsMs, [70, 0, null]);
  eq("no probe (older build) = no report", mergeTimingReport([t()], null, 0), null);
}

// ── loudness vs video ──
{
  const windows = (ms) => new Array(Math.round(ms / 20)).fill(-50);
  const L = (ms, fileMs = ms) => ({ durationMs: fileMs, windows: windows(ms) });
  eq("the same length agrees", loudnessAgrees(L(165000), 165000, 20).ok, true);
  eq("within 100 ms agrees", loudnessAgrees(L(165000, 165080), 165000, 20).ok, true);
  eq("150 ms short does not", loudnessAgrees(L(164850), 165000, 20).ok, false);
  eq("a longer file duration does not", loudnessAgrees(L(165000, 165300), 165000, 20).diffMs, 300);

  const reports = [];
  let loads = 0, clears = 0;
  const load = async () => (++loads === 1 ? L(164000) : L(165000));
  const out = await loadLoudnessChecked({ uri: "m.mp4", load, clear: async () => { clears++; }, videoDurationMs: 165000, windowMs: 20, report: (r) => reports.push(r) });
  eq("a mismatch is logged and the analysis runs again", [reports.length, reports[0].diffMs, loads, clears, out.windows.length * 20], [1, 1000, 2, 1, 165000]);
  const reports2 = [];
  let n = 0;
  await loadLoudnessChecked({ uri: "m.mp4", load: async () => { n++; return L(164000); }, clear: async () => {}, videoDurationMs: 165000, windowMs: 20, report: (r) => reports2.push(r) });
  eq("a second failure is logged too, and the run does not loop", [n, reports2.map((r) => r.attempt)], [2, [1, 2]]);
  const reports3 = [];
  let m = 0;
  await loadLoudnessChecked({ uri: "m.mp4", load: async () => { m++; return L(165040); }, clear: async () => {}, videoDurationMs: 165000, windowMs: 20, report: (r) => reports3.push(r) });
  eq("an agreeing analysis is loaded once and logs nothing", [m, reports3.length], [1, 0]);
  eq("no audio stays null", await loadLoudnessChecked({ uri: "m.mp4", load: async () => null, clear: async () => {}, videoDurationMs: 1000, windowMs: 20, report: () => {} }), null);
}

// ── analyze only after the merge completes, on the merged file ──
{
  const parts = [{ uri: "a.mov", type: "video", durationMs: 50000 }, { uri: "b.mov", type: "video", durationMs: 60000 }, { uri: "c.mov", type: "video", durationMs: 55000 }];
  const merged = { uri: "file:///cache/render_x.mp4", durationMs: 165000 };
  const one = [{ uri: merged.uri, type: "video", durationMs: 165000 }];
  eq("while merging: nothing", analysisSource({ merge: "merging", merged: null, clips: parts }), null);
  eq("several parts: nothing, whatever the merge state", [analysisSource({ merge: "idle", merged: null, clips: parts }), analysisSource({ merge: "failed", merged: null, clips: parts })], [null, null]);
  eq("while the merge is still marked running, even the merged clip waits", analysisSource({ merge: "merging", merged, clips: one }), null);
  eq("after the merge: the merged file, not a source clip", analysisSource({ merge: "idle", merged, clips: one }), merged.uri);
  eq("a clip that is not the merged file is refused", analysisSource({ merge: "idle", merged, clips: [{ uri: "a.mov", type: "video", durationMs: 50000 }] }), null);
  eq("a merged file without a verified length is refused", [analysisSource({ merge: "idle", merged: { ...merged, durationMs: 0 }, clips: one }), analysisSource({ merge: "idle", merged, clips: [{ uri: merged.uri, type: "video" }] })], [null, null]);
  eq("a single imported video (no merge) analyses as before", analysisSource({ merge: "idle", merged: null, clips: [{ uri: "a.mov", type: "video", durationMs: 9000 }] }), "a.mov");

  // the merge only reports done after the render resolves
  const order = [];
  const r = await mergeVideoClips({
    clips: parts, newId: () => "m1",
    render: async () => { order.push("render-start"); await new Promise((res) => setTimeout(res, 5)); order.push("render-done"); return { uri: merged.uri, durationMs: 165000 }; },
  });
  order.push("merge-result");
  eq("the merged clip exists only after the render has finished", order, ["render-start", "render-done", "merge-result"]);
  eq("(and carries the verified length)", [r.ok, r.clip.uri, r.clip.durationMs], [true, merged.uri, 165000]);
}

// ── cache key is the merged file ──
{
  const stats = { "a.mov": { size: 10, mtime: 1 }, "m1.mp4": { size: 30, mtime: 5 }, "m2.mp4": { size: 30, mtime: 5 } };
  let loads = [];
  const cache = createAnalysisCache({
    stat: async (uri) => (stats[uri] ? { uri, ...stats[uri] } : null),
    loadLoudness: async (uri) => { loads.push(uri); return { durationMs: 1000, windows: new Array(50).fill(-40) }; },
    transcribe: async () => ({ status: "ok", words: [], removed: { count: 0 } }),
  });
  await cache.loudness("m1.mp4");
  await cache.loudness("m1.mp4");
  await cache.loudness("m2.mp4");
  eq("the cache is per merged file: m1 once, a re-merge (new file, same size) analysed afresh, no source clip involved", loads, ["m1.mp4", "m2.mp4"]);
  await cache.clear("m1.mp4");
  await cache.loudness("m1.mp4");
  eq("clearing re-analyses that file", loads, ["m1.mp4", "m2.mp4", "m1.mp4"]);

  const edit = read("../app/edit.tsx");
  ok("the editor analyses only what analysisSource allows, with the length check", /analysisSource\(\{ merge: mergeUi\.kind, merged: mergedRef\.current, clips \}\) !== clip\.uri/.test(edit) && /loadLoudnessChecked\(/.test(edit));
  ok("a mismatch goes to client_errors", /kind: "loudnessMismatch"/.test(edit) && /kind: "mergeTiming"/.test(edit));
  ok("the merged file is recorded only when the merge has succeeded", /mergedRef\.current = \{ uri: result\.clip\.uri/.test(edit));
  const nat = read("../lib/mergeNative.ts");
  ok("the merge asks for no seam fades and probes the result after the render", /seamFades: false/.test(nat) && /probeTimingAsync/.test(nat));
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("native: tracks are inserted on their own clock (offsets kept), fades optional, probe exposed", /insertAligned\(videoTrack/.test(swift) && /insertAligned\(audioTrack/.test(swift) && /settings\.seamFades/.test(swift) && /AsyncFunction\("probeTimingAsync"\)/.test(swift) && /supportsTimingProbe/.test(swift));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
