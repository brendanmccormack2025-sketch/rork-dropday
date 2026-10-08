#!/usr/bin/env node
/**
 * TikTok-style camera: tap/pause/continue segments, delete last, 60 s cap, Next -> merge -> transcription + planning.
 *   node --experimental-strip-types scripts/test-camera-segments.mjs
 */
import { readFileSync } from "node:fs";
import {
  MAX_CAMERA_MS, barSegments, canProceed, canRecordMore, deleteLastRun, maxDurationSeconds, remainingMs, runsOf, tapAction, totalMs,
} from "../lib/cameraSegments.ts";
import { mergeVideoClips, shouldMerge } from "../lib/mergeClips.ts";
import { analysisSource } from "../lib/mergeTiming.ts";
import { AUTO_EDIT_STALL_MS, transcriptionGate } from "../lib/captionsGate.ts";
import { distinctSources } from "../lib/transcription/multiSource.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// A run = one start-to-pause stretch. A camera flip inside a run makes two files with the same run id.
const seg = (id, runId, ms, type = "video") => ({ id, uri: `file:///${id}.mov`, type, runId, measuredMs: ms });

// ── pause / continue produces segments ──
{
  // record 4 s, pause, continue 3 s, pause, continue 5 s (with a flip in the middle: two files)
  const segs = [seg("a", "r1", 4000), seg("b", "r2", 3000), seg("c", "r3", 2000), seg("d", "r3", 3000)];
  const runs = runsOf(segs);
  eq("each record-to-pause run is a segment; a flip stays in its run", runs.map((r) => [r.runId, r.ids, r.startMs, r.durationMs]), [["r1", ["a"], 0, 4000], ["r2", ["b"], 4000, 3000], ["r3", ["c", "d"], 7000, 5000]]);
  eq("the total is the sum of the segments", totalMs(segs), 12000);
  eq("tap: start when stopped, pause when recording, nothing while stopping", [tapAction("idle"), tapAction("recording"), tapAction("stopping")], ["start", "pause", "ignore"]);
  const bar = barSegments(segs);
  eq("the bar has one filled stretch per run, starting where the run starts", bar.map((b) => [Math.round(b.startFrac * 60000), Math.round(b.widthFrac * 60000)]), [[0, 4000], [4000, 3000], [7000, 5000]]);
  const live = barSegments(segs, { ms: 2500 });
  eq("the run in progress is drawn after them", [live.length, live[3].live, Math.round(live[3].startFrac * 60000), Math.round(live[3].widthFrac * 60000)], [4, true, 12000, 2500]);

  const cam = read("../app/camera.tsx");
  ok("tap on the button: start when stopped, pause when recording", /tapAction\(recordStateRef\.current\)/.test(cam) && /action === "start"[\s\S]{0,80}startRecording\(\)/.test(cam) && /action === "pause"[\s\S]{0,40}stopRecording\(\)/.test(cam));
  ok("hold still records and release pauses", /LONG_PRESS_THRESHOLD_MS/.test(cam) && /didLongPress\.current \? "pause"/.test(cam));
  ok("a tap no longer takes a photo, and there is no lock gesture", !/takePicture/.test(cam) && !/lockRecording|Slide up to lock/.test(cam));
  ok("flip works while paused (and still while recording)", /onPress=\{handleFlip\}/.test(cam) && /flipCamera\(\)/.test(cam));
  ok("segmented bar at the top with notches", /styles\.segBar/.test(cam) && /styles\.segNotch/.test(cam) && /barSegments\(/.test(cam));
}

// ── delete last ──
{
  const segs = [seg("a", "r1", 4000), seg("b", "r2", 3000), seg("c", "r3", 2000), seg("d", "r3", 3000)];
  const first = deleteLastRun(segs);
  eq("delete last removes the whole last run (both files of a flipped run), nothing else", [first.removed.map((s) => s.id), first.kept.map((s) => s.id)], [["c", "d"], ["a", "b"]]);
  const second = deleteLastRun(first.kept);
  eq("it is repeatable", [second.removed.map((s) => s.id), second.kept.map((s) => s.id)], [["b"], ["a"]]);
  eq("the removed files are the ones to delete from disk", second.removed.map((s) => s.uri), ["file:///b.mov"]);
  eq("nothing to delete when empty", deleteLastRun([]), { kept: [], removed: [] });
  eq("the total shrinks accordingly", totalMs(second.kept), 4000);

  const hook = read("../hooks/useCameraRecorder.ts");
  const cam = read("../app/camera.tsx");
  ok("the hook removes the clips of the last run and deletes their files", /deleteLastRun\(clipsRef\.current\)/.test(hook) && /deleteAsync\(c\.uri/.test(hook));
  ok("it cannot run while recording", /recordStateRef\.current !== "idle"\) return;\s*const \{ kept, removed \}/.test(hook));
  ok("the screen asks first: Delete last clip?", /Alert\.alert\("Delete last clip\?"/.test(cam) && /onPress: deleteLastClip/.test(cam));
  ok("the button sits beside record and is hidden while recording", /clips\.length > 0 && !isRecording[\s\S]{0,200}confirmDeleteLast/.test(cam));
}

// ── 60 s cap ──
{
  eq("the cap is 60 s", MAX_CAMERA_MS, 60000);
  const half = [seg("a", "r1", 30000)];
  eq("what is left counts the recorded runs and the live run", [remainingMs(half), remainingMs(half, 12000), remainingMs(half, 99999)], [30000, 18000, 0]);
  eq("the recorder is told to stop by itself at the cap (whole seconds, at least 1)", [maxDurationSeconds([]), maxDurationSeconds(half), maxDurationSeconds(half, 12000), maxDurationSeconds([seg("a", "r1", 59800)])], [60, 30, 18, 1]);
  eq("no recording past 60 s", [canRecordMore(half), canRecordMore([seg("a", "r1", 60000)]), canRecordMore([seg("a", "r1", 59900)])], [true, false, false]);
  eq("deleting a run frees the time again", canRecordMore(deleteLastRun([seg("a", "r1", 30000), seg("b", "r2", 30000)]).kept), true);
  const hook = read("../hooks/useCameraRecorder.ts");
  ok("recordAsync gets the remaining time as maxDuration (also after a flip), and a full take refuses to start", /maxDuration: maxDurationSeconds\(clipsRef\.current, spentThisRun\)/.test(hook) && /!canRecordMore\(clipsRef\.current\)/.test(hook));
  ok("each file's recorded length is kept for the bar and the cap", /measuredMs: accumulatedSegmentMsRef\.current\[i\]/.test(hook));
}

// ── Next: >= 1 s, then merge, then transcription + planning ──
{
  eq("Next needs at least 1 s", [canProceed([seg("a", "r1", 900)]), canProceed([seg("a", "r1", 1000)]), canProceed([])], [false, true, false]);
  const cam = read("../app/camera.tsx");
  ok("Next is disabled below 1 s and the editor never gets the recorder's timing", /disabled=\{!canProceed\(clips\)\}/.test(cam) && /measuredMs: _m/.test(cam) && /if \(!canProceed\(clips\)\) return;/.test(cam));
  ok("no per-segment camera-roll saves", !/saveToLibraryAsync|saveToGallery/.test(read("../hooks/useCameraRecorder.ts")));

  // What the editor does with three runs (clips arrive without durations, as the camera sends them).
  const clips = [{ id: "a", uri: "a.mov", type: "video" }, { id: "b", uri: "b.mov", type: "video" }, { id: "c", uri: "c.mov", type: "video" }];
  ok("three runs are merged first", shouldMerge(clips, { isDraft: false }));
  const calls = [];
  const merged = await mergeVideoClips({ clips, newId: () => "m", render: async (uris) => { calls.push(uris); return { uri: "file:///render_x.mp4", durationMs: 30000 }; } });
  eq("the merge is called once with the runs in order", calls, [["a.mov", "b.mov", "c.mov"]]);
  const one = [merged.clip];
  const mergedInfo = { uri: merged.clip.uri, durationMs: merged.clip.durationMs };

  // The gate: no transcription while merging; then after the silence-cut step; a stalled step does not block it.
  const base = { merge: "idle", autoEditPossible: true, autoEditRunning: false, autoEditFinished: false, autoEditStalled: false };
  eq("while merging: not ready", transcriptionGate({ ...base, merge: "merging" }), { ready: false, waitingFor: "the merge" });
  eq("merged, silence cuts not done yet: waits for them", transcriptionGate(base), { ready: false, waitingFor: "the silence-cut step" });
  eq("silence cuts running: waits", transcriptionGate({ ...base, autoEditRunning: true }).ready, false);
  eq("silence cuts done: transcribes", transcriptionGate({ ...base, autoEditFinished: true }), { ready: true, waitingFor: null });
  eq("silence cuts produced several clips of the merged file (not 'possible' any more): transcribes", transcriptionGate({ ...base, autoEditPossible: false }).ready, true);
  eq("a stalled silence-cut step stops blocking (even if it still says running)", transcriptionGate({ ...base, autoEditRunning: true, autoEditStalled: true }).ready, true);
  eq("the stall limit is generous (45 s)", AUTO_EDIT_STALL_MS, 45000);
  eq("a failed merge keeps everything waiting", transcriptionGate({ ...base, merge: "failed" }).ready, false);

  // Transcription runs on the merged file as a single source, so planning (hook trim, fillers, ums) applies.
  eq("analysis may use the merged file, once", analysisSource({ merge: "idle", merged: mergedInfo, clips: one }), "file:///render_x.mp4");
  eq("after the silence cuts the timeline is several clips of the ONE merged file: a single source (transcribedUri set, planning runs)", distinctSources([{ uri: "file:///render_x.mp4" }, { uri: "file:///render_x.mp4" }]), ["file:///render_x.mp4"]);
  ok("the sources of the unmerged runs would be several (captions only): that is why the merge comes first", distinctSources(clips).length === 3);

  const edit = read("../app/edit.tsx");
  ok("the editor uses the gate for transcription", /transcriptionGate\(\{ merge: mergeUi\.kind, autoEditPossible, autoEditRunning, autoEditFinished, autoEditStalled \}\)\.ready/.test(edit));
  ok("a stalled step is logged with what the editor knew", /kind: "autoEditStalled"/.test(edit) && /AUTO_EDIT_STALL_MS/.test(edit));
  ok("planning starts from the transcript of the merged single source", /captions\.words/.test(edit) && /const uri = captions\.transcribedUri;[\s\S]{0,80}if \(!words \|\| !uri \|\| planDone\) return;/.test(edit));

  const dbg = (extra) => formatAiDebug({ sourceDurationMs: 30000, clips: [], sourceUri: "x", proposals: [], candidates: [], transcription: null, hookTrims: [], fillers: [], userCuts: [], protection: { ranges: [], affected: [] }, ...extra }).split("\n").find((l) => l.startsWith("Transcription"));
  eq("the debug says what transcription is waiting for", dbg({ transcriptionWaitingFor: "the merge" }), "Transcription: not run (waiting for the merge)");
  eq("(and is unchanged without a reason)", dbg({}), "Transcription: not run");
}

// ── camera roll accepts only one video ──
{
  const sheet = read("../components/PostChoiceSheet.tsx");
  ok("one pick only; no Arrange step; the existing single-video limit stays", /allowsMultipleSelection: false/.test(sheet) && !/orderedSelection|selectionLimit|Arrange/.test(sheet) && /\(asset\.duration \?\? 0\) > MAX_VIDEO_SECONDS \* 1000/.test(sheet));
  ok("the library limit is not the camera's 60 s", /MAX_VIDEO_SECONDS = 300/.test(read("../hooks/useCameraRecorder.ts")));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
