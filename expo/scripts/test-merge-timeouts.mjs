#!/usr/bin/env node
/**
 * The merge and the clip measurement never hang: every native call has a time limit, the merge ends in a result (never an
 * endless spinner), a clamped clip that ends exactly at its file's end is kept, and the 4-clip flip recording is measured in
 * parallel (once per file) and merged in order.
 *   node --experimental-strip-types --no-warnings scripts/test-merge-timeouts.mjs
 */
import { readFileSync } from "node:fs";
import { DeadlineError, createNativeLock, deadline } from "../lib/deadline.ts";
import { MERGE_TRY_AGAIN_TEXT, mergeVideoClips } from "../lib/mergeClips.ts";
import { boundedEnd, fileLengthMs, measureAndSanitize, resetFileLengths, sanitizeClips, setFileLengthMs } from "../lib/clipBounds.ts";
import { renderEditOf } from "../lib/renderEdit.ts";
import { buildSegments, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

// ── deadline ──
eq("deadline: a quick promise passes through", await deadline(Promise.resolve(7), 50, "x"), 7);
{
  let err = null;
  const t0 = Date.now();
  try { await deadline(never(), 40, () => "stage B"); } catch (e) { err = e; }
  eq("deadline: a promise that never settles ends in a DeadlineError naming the stage", [err instanceof DeadlineError, err?.stage, Date.now() - t0 < 500], [true, "stage B", true]);
  let rej = null;
  try { await deadline(Promise.reject(new Error("native said no")), 50, "x"); } catch (e) { rej = e.message; }
  eq("deadline: a rejection is passed on as it is", rej, "native said no");
}

// ── the native lock ──
{
  const lock = createNativeLock();
  const first = await lock.acquire();            // a render that never lets go
  let err = null;
  const t0 = Date.now();
  try { await lock.acquireWithin(40, "waiting for the native renderer"); } catch (e) { err = e; }
  eq("lock: waiting for a render that never ends gives up with a DeadlineError", [err?.stage, Date.now() - t0 < 500], ["waiting for the native renderer", true]);
  let third = false;
  const pending = lock.acquire().then((rel) => { third = true; return rel; });
  await sleep(10);
  eq("lock: still held", third, false);
  first();                                       // the first render finally ends
  await sleep(20);
  eq("lock: the caller that gave up passes its turn on, the queue does not stall", third, true);
}

// ── the merge ──
{
  let stageSeen = "";
  let cancelled = 0;
  const t0 = Date.now();
  const r = await mergeVideoClips({
    clips: [{ uri: "a", type: "video" }, { uri: "b", type: "video" }],
    render: (_u, _p, onStage) => { onStage("rendering"); return never(); },   // the native call never resolves
    newId: () => "m",
    timeoutMs: 60,
    onTimeout: () => { cancelled++; },
  });
  stageSeen = r.stage;
  eq("merge: a native call that never resolves ends cleanly: not ok, the stage it was in, the native render told to stop, promptly", [r.ok, stageSeen, /timed out/.test(r.message ?? ""), cancelled, Date.now() - t0 < 1000], [false, "rendering", true, 1, true]);
}
eq("merge: a render that throws synchronously is a result, not an exception", (await mergeVideoClips({ clips: [{ uri: "a", type: "video" }, { uri: "b", type: "video" }], render: () => { throw new Error("boom"); }, newId: () => "m" })).ok, false);
eq("merge: a rejected render keeps its message", (await mergeVideoClips({ clips: [{ uri: "a", type: "video" }, { uri: "b", type: "video" }], render: async () => { throw new Error("ERR_RENDER_X"); }, newId: () => "m" })).message, "ERR_RENDER_X");
eq("the text the creator sees", MERGE_TRY_AGAIN_TEXT, "Couldn't prepare your video. Please try again.");

// ── the 4-clip flip recording ──
const flip = [
  { id: "a", uri: "a.mov", type: "video", durationMs: 3100, trimStartMs: 0, trimEndMs: 3100 },
  { id: "b", uri: "b.mov", type: "video", durationMs: 2900, trimStartMs: 0, trimEndMs: 2900 },
  { id: "c", uri: "c.mov", type: "video", durationMs: 4200, trimStartMs: 0, trimEndMs: 4200 },   // claims more than its file holds
  { id: "d", uri: "d.mov", type: "video", durationMs: 2600, trimStartMs: 0, trimEndMs: 2600 },
];
const files = { "a.mov": 3100, "b.mov": 2900, "c.mov": 3000, "d.mov": 2600 };
resetFileLengths();
let probeCalls = 0;
const probe = async (uri) => { probeCalls++; await sleep(120); return files[uri]; };
const t1 = Date.now();
const measured = await measureAndSanitize(flip, probe);
const took = Date.now() - t1;
eq("flip case: 4 files measured in parallel (about one probe, not four) and each file once", [took < 400, probeCalls], [true, 4]);
eq("flip case: the overlong clip is clamped, the other three untouched (same objects)", [measured.map((c) => c.trimEndMs), measured[0] === flip[0], measured[1] === flip[1], measured[3] === flip[3]], [[3100, 2900, 3000, 2600], true, true, true]);
const t2 = Date.now();
const again = await measureAndSanitize(flip, probe);
eq("flip case: a second look is served from the cache (no probe, no wait)", [probeCalls, Date.now() - t2 < 50, again.map((c) => c.trimEndMs)], [4, true, [3100, 2900, 3000, 2600]]);
const merged = await mergeVideoClips({
  clips: measured,
  render: async (uris, onProgress) => { onProgress(0.5); return { uri: "merged.mp4", durationMs: 11600 }; },
  newId: () => "m1",
});
eq("flip case: the merge takes the four clips in order and succeeds", [merged.ok, merged.ok && merged.mergedFrom, merged.ok && merged.clip.durationMs], [true, ["a.mov", "b.mov", "c.mov", "d.mov"], 11600]);

// ── a clamped clip that ends exactly at the end of its file ──
resetFileLengths();
setFileLengthMs("e.mov", 3000);
const exact = [{ id: "e", uri: "e.mov", type: "video", durationMs: 3000, trimStartMs: 0, trimEndMs: 3000 }];
eq("exact end: nothing to clamp, the same array comes back", sanitizeClips(exact) === exact, true);
eq("exact end: the end stays, the plan has the piece, the render edit is valid", [boundedEnd(exact[0]), buildSegments(exact).map((s) => [s.srcStartMs, s.srcEndMs]), totalEditedMs(buildSegments(exact)), renderEditOf(exact).problem, renderEditOf(exact).editMs], [3000, [[0, 3000]], 3000, null, 3000]);
const overBy1 = [{ id: "e", uri: "e.mov", type: "video", durationMs: 3001, trimStartMs: 0, trimEndMs: 3001 }];
eq("one ms past the end: clamped to the end exactly, not dropped", [sanitizeClips(overBy1)[0].trimEndMs, sanitizeClips(overBy1)[0].durationMs, fileLengthMs("e.mov")], [3000, 3000, 3000]);
eq("a piece that ends exactly at the end of the file and starts inside it is kept", sanitizeClips([{ id: "f", uri: "e.mov", type: "video", durationMs: 3000, trimStartMs: 2000, trimEndMs: 3000 }]).length, 1);

// ── wiring ──
const mn = read("../lib/mergeNative.ts"), ed = read("../app/edit.tsx"), cam = read("../app/camera.tsx"), cm = read("../lib/clipMeasure.ts");
eq("mergeNative: every await is a step with a time limit and breadcrumbs", [/step\("reading the first frame"/.test(mn), /step\("waiting for the native renderer"/.test(mn), /step\("loading the renderer"/.test(mn), /step\("rendering"/.test(mn), /recordBreadcrumb/.test(mn), /acquireNativeWithin/.test(mn)], [true, true, true, true, true, true]);
eq("mergeNative: the result probes run in parallel with limits", [/Promise\.all\(\[probe\(result\.uri\)/.test(mn), /PROBE_MS/.test(mn)], [true, true]);
eq("editor: a failed or timed-out merge closes the overlay, shows the message and logs the stage and clips", [/setMergeUi\(\{ kind: "idle" \}\);\s*setError\(MERGE_TRY_AGAIN_TEXT\)/.test(ed), /stage: result\.stage/.test(ed), /fileMs: fileLengthMs/.test(ed)], [true, true, true]);
eq("camera: takes are measured in the background; measurement logs each clip", [/warmFileLengths\(clips\)/.test(cam), /measure clip \$\{/.test(cm), /MEASURE_TIMEOUT_MS = 2_500/.test(cm)], [true, true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
