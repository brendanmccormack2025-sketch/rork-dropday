#!/usr/bin/env node
/**
 * The camera's recording state machine with a fake camera: start/stop, no auto-restart, double-tap guard,
 * flip while recording, 60 s auto-stop, facing memory, and the screen wiring.
 *   node --experimental-strip-types scripts/test-recording-controller.mjs
 */
import { readFileSync } from "node:fs";
import { RecordingController } from "../lib/recordingController.ts";
import { barSegments, canProceed, deleteLastRun, totalMs } from "../lib/cameraSegments.ts";
import { mergeVideoClips } from "../lib/mergeClips.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake camera + clock. record() stays pending until stopNative() (or the limit) ends it. */
function rig(opts = {}) {
  let t = 0;
  const log = [];
  const segments = [];
  const states = [];
  const errors = [];
  const gaps = [];
  const discarded = [];
  let failStarts = opts.failStarts ?? 0;
  let pending = null;
  let n = 0;
  let facing = "front";
  let readyResolvers = [];
  const deps = {
    record: (max) => {
      log.push(`record(${max})`);
      if (failStarts > 0 && log.includes("settled")) { failStarts--; return opts.refuseWithNull ? Promise.resolve(null) : Promise.reject(new Error("camera busy")); }
      return new Promise((resolve) => {
        pending = { resolve, max };
        if (opts.autoEndAfterMs !== undefined) setTimeout(() => { if (pending) { t += opts.autoEndAfterMs; const p = pending; pending = null; p.resolve({ uri: `file:///seg${++n}.mov` }); } }, 1);
      });
    },
    stopNative: () => {
      log.push("stopNative");
      if (pending) { const p = pending; pending = null; t += opts.runMs ?? 2000; p.resolve({ uri: `file:///seg${++n}.mov` }); }
    },
    ensureReady: async () => { log.push("ready?"); return opts.notReady ? false : true; },
    switchFacing: () => { facing = facing === "front" ? "back" : "front"; log.push(`facing=${facing}`); },
    afterFlipSettled: async () => { log.push("settling"); await tick(); await tick(); t += 180; log.push("settled"); },
    getSegments: () => segments,
    onSegment: (s) => { segments.push(s); log.push(`segment:${s.uri.split("/").pop()}`); },
    discardFile: (u) => { discarded.push(u); },
    onState: (s) => states.push(s),
    onError: (m) => { if (m) errors.push(m); },
    onSwitching: (b) => log.push(`switching=${b}`),
    onFlipGap: (ms, info) => { gaps.push({ ms, retries: info.retries }); },
    onTakeStart: (id) => log.push(`take:${id}`),
    now: () => t,
    newId: () => `id${++n}`,
    delay: (ms) => (ms >= 1000 ? new Promise(() => {}) : new Promise((r) => setTimeout(r, Math.min(ms, 5)))),
  };
  return { deps, log, segments, states, errors, gaps, discarded, get facing() { return facing; }, get pending() { return pending; }, advance: (ms) => { t += ms; } };
}

// ── start / stop / no auto-restart ──
{
  const r = rig();
  const c = new RecordingController(r.deps);
  eq("starts idle", c.state, "idle");
  eq("a tap starts", c.toggle(), "started");
  eq("the state is recording", c.state, "recording");
  await tick(); await tick();
  eq("exactly one native recording started", r.log.filter((l) => l.startsWith("record(")).length, 1);
  eq("a second tap stops", c.toggle(), "stopped");
  eq("stopping", c.state, "stopping");
  await c.settled();
  eq("back to idle with one segment", [c.state, r.segments.length], ["idle", 1]);
  await tick(); await tick();
  eq("nothing restarts by itself: still exactly one recording", r.log.filter((l) => l.startsWith("record(")).length, 1);
  eq("the states went idle -> recording -> stopping -> idle", r.states, ["recording", "stopping", "idle"]);
}

// ── double-tap guard ──
{
  const r = rig();
  const c = new RecordingController(r.deps);
  c.toggle(); c.toggle();           // start, then stop immediately (before the camera even started recording)
  eq("a tap while stopping is ignored (no second stop, no start)", [c.toggle(), c.toggle()], ["ignored", "ignored"]);
  await c.settled();
  eq("a stop before the camera started records nothing (no leftover recording that keeps going)", [r.log.filter((l) => l.startsWith("record(")).length, r.segments.length, c.state], [0, 0, "idle"]);
  const r2 = rig();
  const d = new RecordingController(r2.deps);
  eq("two quick start taps: only one run", [d.toggle(), d.start()], ["started", false]);
  await tick(); await tick();
  eq("(one native recording)", r2.log.filter((l) => l.startsWith("record(")).length, 1);
  d.stop(); await d.settled();
}

// ── a stop that arrives just after the native recording began still ends it (and is repeated) ──
{
  const r = rig();
  const stubborn = { ...r.deps };
  let calls = 0;
  stubborn.stopNative = () => { calls++; r.log.push("stopNative"); if (calls >= 3 && r.pending) { const p = r.pending; r.pending = null; } };
  // The first two stop requests are ignored by the (fake) camera; the third works.
  let resolveRec; let started = false;
  stubborn.record = () => { started = true; return new Promise((res) => { resolveRec = res; }); };
  stubborn.stopNative = () => { calls++; if (calls >= 3 && resolveRec) { const f = resolveRec; resolveRec = null; r.advance(2000); f({ uri: "file:///x.mov" }); } };
  const c = new RecordingController(stubborn);
  c.start(); await tick(); await tick();
  ok("the native recording is running", started);
  c.stop(); await c.settled();
  eq("the stop was asked again until the camera really stopped", [calls >= 3, c.state, r.segments.length], [true, "idle", 1]);
}

// ── camera not ready: nothing records, an error is shown, back to idle ──
{
  const r = rig({ notReady: true });
  const c = new RecordingController(r.deps);
  c.start(); await c.settled();
  eq("not ready: idle, no recording, a message", [c.state, r.log.some((l) => l.startsWith("record(")), r.errors.length], ["idle", false, 1]);
}

// ── 60 s auto-stop ──
{
  const r = rig({ autoEndAfterMs: 60000 });
  const c = new RecordingController(r.deps);
  c.start(); await c.settled();
  eq("a full minute: the recorder is given 60 s and the segment ends by itself", [r.log.find((l) => l.startsWith("record(")), c.state, totalMs(r.segments)], ["record(60)", "idle", 60000]);
  eq("then a new tap is refused with a message", [c.start(), r.errors.length], [false, 1]);
  const r2 = rig({ autoEndAfterMs: 20000 });
  const d = new RecordingController(r2.deps);
  d.start(); await d.settled();
  d.start(); await tick(); await tick();
  eq("the next segment only gets what is left (40 s)", r2.log.filter((l) => l.startsWith("record(")), ["record(60)", "record(40)"]);
  d.stop(); await d.settled();
}

// ── flip ──
{
  const r = rig();
  const c = new RecordingController(r.deps);
  eq("flip while idle: just switches", [c.flip(), r.facing, c.state], [true, "back", "idle"]);

  const r2 = rig();
  const d = new RecordingController(r2.deps);
  d.start(); await tick(); await tick();
  eq("flip while recording is accepted", d.flip(), true);
  eq("the UI state stays 'recording' during the flip (no stop, no pause)", d.state, "recording");
  eq("a second flip while one is switching is ignored", d.flip(), false);
  for (let i = 0; i < 12; i++) { await tick(); if (d.state !== "recording") break; }
  eq("still recording after the handoff", d.state, "recording");
  eq("the state never left 'recording' for the whole flip", r2.states, ["recording"]);
  const iSeg1 = r2.log.indexOf(`segment:${r2.segments[0].uri.split("/").pop()}`);
  const iFace = r2.log.indexOf("facing=back");
  const iSettled = r2.log.indexOf("settled");
  const iRec2 = r2.log.findIndex((l, i) => l.startsWith("record(") && i > iSettled);
  ok("the segment ends, the camera switches, the new camera is ready, THEN the next recording starts", iSeg1 >= 0 && iFace > iSeg1 && iSettled > iFace && iRec2 > iSettled);
  eq("one finished segment, and a second recording under way on the other camera", [r2.segments.length, r2.facing], [1, "back"]);
  d.stop(); await d.settled();
  eq("two segments after the user stops; the state went recording -> stopping -> idle only once", [r2.segments.length, r2.states], [2, ["recording", "stopping", "idle"]]);
  eq("both parts are ONE take (same take id)", new Set(r2.segments.map((s) => s.runId)).size, 1);
  eq("the blur switched on and off exactly once", r2.log.filter((l) => l.startsWith("switching=")).slice(0, 2), ["switching=true", "switching=false"]);

  // the take is one deletable unit
  const del = deleteLastRun(r2.segments);
  eq("Delete last removes both parts of a take that had a flip, as one", [del.removed.length, del.kept.length], [2, 0]);
  const later = [...r2.segments, { id: "n", uri: "n", type: "video", runId: "take2", measuredMs: 1500 }];
  eq("a later take is deleted on its own, then the flipped take (two parts) as one", [deleteLastRun(later).removed.map((x) => x.id), deleteLastRun(deleteLastRun(later).kept).removed.length], [["n"], 2]);
  eq("the bar shows ONE stretch for the flipped take (no notch at the flip)", barSegments(r2.segments).length, 1);
  eq("and keeps advancing through the flip: the live part joins the take's stretch", barSegments([r2.segments[0]], { ms: 500, runId: r2.segments[0].runId }).map((b) => [b.live, Math.round(b.widthFrac * 60000)]), [[true, 2500]]);

  // the handoff is measured
  eq("the gap (previous segment resolved -> next recording accepted) is reported once, with no retries", [r2.gaps.length, r2.gaps[0].retries, r2.gaps[0].ms], [1, 0, 180]);
  eq("(the report carries gapMs and retries, as logged to client_errors)", Object.keys(r2.gaps[0]).sort(), ["ms", "retries"]);

  // the camera refuses the first tries: retried at once, still one take, gap reported with the retries
  const r4 = rig({ failStarts: 2 });
  const f = new RecordingController(r4.deps);
  f.start(); await tick(); await tick(); f.flip();
  for (let i = 0; i < 40 && r4.gaps.length === 0; i++) await tick();
  eq("a camera that is still settling is retried immediately", [r4.gaps.length, r4.gaps[0]?.retries, r4.log.filter((l) => l.startsWith("record(")).length], [1, 2, 4]);
  f.stop(); await f.settled();
  eq("(and the take still has both parts, no error shown, no extra segment)", [r4.segments.length, r4.errors.length], [2, 0]);

  // a refusal that comes back as 'no file' is retried the same way, with no segment and no message
  const r5 = rig({ failStarts: 3, refuseWithNull: true });
  const g = new RecordingController(r5.deps);
  g.start(); await tick(); await tick(); g.flip();
  for (let i = 0; i < 40 && r5.gaps.length === 0; i++) await tick();
  eq("an early 'nothing recorded' answer counts as refused: retried, no error toast, no empty segment", [r5.gaps[0]?.retries, r5.errors.length, r5.segments.length], [3, 0, 1]);
  g.stop(); await g.settled();
  eq("(finally two real segments)", r5.segments.length, 2);

  // the camera never accepts: after 15 tries the take ends with ONE message, the first part is kept
  const r6 = rig({ failStarts: 99 });
  const h = new RecordingController(r6.deps);
  h.start(); await tick(); await tick(); h.flip(); await h.settled();
  eq("15 retries, then it gives up cleanly: first part kept, one message, idle", [r6.log.filter((l) => l.startsWith("record(")).length, r6.segments.length, r6.errors.length, h.state], [17, 1, 1, "idle"]);

  // a segment cut off at once (shorter than 200 ms) is dropped and its file deleted, so it never reaches the merge
  const r7 = rig({ runMs: 80 });
  const k = new RecordingController(r7.deps);
  k.start(); await tick(); await tick(); k.stop(); await k.settled();
  eq("an empty segment is discarded (file deleted, nothing added, no message)", [r7.segments.length, r7.discarded.length, r7.errors.length, k.state], [0, 1, 0, "idle"]);

  // tap during the switch ends the take; no new segment starts
  const r3 = rig();
  const e = new RecordingController(r3.deps);
  e.start(); await tick(); await tick(); e.flip();
  eq("a stop tap during the switch is honoured", e.toggle(), "stopped");
  await e.settled();
  eq("(first part kept, nothing new recorded, idle)", [r3.segments.length, e.state, r3.log.filter((l) => l.startsWith("record(")).length], [1, "idle", 1]);

  // the merge gets both parts, in order, nothing in between
  const calls = [];
  const merged = await mergeVideoClips({
    clips: r2.segments.map((sg) => ({ id: sg.id, uri: sg.uri, type: "video" })), newId: () => "m",
    render: async (uris) => { calls.push(uris); return { uri: "file:///merged.mp4", durationMs: 4000 }; },
  });
  eq("the merge receives both segments in recording order, with no inserted gap clip", [calls.length, calls[0], merged.ok], [1, r2.segments.map((sg) => sg.uri), true]);
  const nat = read("../lib/mergeNative.ts");
  ok("the native merge lays the files back to back: just those files, no black or silent filler", /clips: uris\.map\(\(uri\) => \(\{ uri, trimStartMs: 0, trimEndMs: WHOLE_FILE_MS \}\)\)/.test(nat) && /overlays: \[\]/.test(nat) && /seamFades: false/.test(nat));
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("(native: each clip starts where the previous ended)", /cursor = CMTimeAdd\(cursor, range\.duration\)/.test(swift));
}

// ── delete last / Next ──
{
  const segs = [
    { id: "a", uri: "a", type: "video", runId: "r1", measuredMs: 600 },
    { id: "b", uri: "b", type: "video", runId: "r2", measuredMs: 700 },
  ];
  eq("Next needs 1 s in total (600 + 700 ms is enough, 600 alone is not)", [canProceed(segs), canProceed(segs.slice(0, 1))], [true, false]);
  const d = deleteLastRun(segs);
  eq("delete last removes the most recent segment only, repeatable", [d.removed.map((s) => s.id), deleteLastRun(d.kept).removed.map((s) => s.id)], [["b"], ["a"]]);
}

// ── the screen and the hook ──
{
  const cam = read("../app/camera.tsx");
  const hook = read("../hooks/useCameraRecorder.ts");
  const layout = read("../app/_layout.tsx");
  ok("no restart loop in the hook: no while loop around recordAsync, the controller does the work", !/while \(keepRecording\)|keepRecording/.test(hook) && /new RecordingController\(/.test(hook));
  ok("the controller records again only for a flip made while recording (never after a stop)", !/while \(true\)/.test(read("../lib/recordingController.ts")) && (read("../lib/recordingController.ts").match(/this\.deps\.record\(/g) ?? []).length === 2 && /if \(continuation\)/.test(read("../lib/recordingController.ts")));
  ok("the camera view is created once, with the facing prop, and is not keyed", (cam.match(/<CameraView/g) ?? []).length === 1 && /facing=\{facing\}/.test(cam) && !/<CameraView[^>]*key=/.test(cam));
  ok("no white overlays or flashes: no #fff full-screen fills, no front flash", !/backgroundColor: "#fff"[\s\S]{0,40}opacity/.test(cam) && !/frontFlash|flipFlash/.test(cam) && /fullscreen: \{ flex: 1, backgroundColor: "#000" \}/.test(cam));
  ok("the camera screen's own background is black (the light app background never shows through)", /contentStyle: \{ backgroundColor: "#000" \}/.test(layout));
  ok("a dark blur (not white) covers the preview while a flip switches", /<BlurView[^>]*tint="dark"/.test(cam) && /switching/.test(cam));
  ok("circle record button, 72 pt+ target, red with a pulse while recording", /RECORD_TOUCH = 88/.test(cam) && /RECORD_SIZE = 76/.test(cam) && /recordDiscRecording/.test(cam) && /Animated\.loop/.test(cam) && /borderRadius: \(RECORD_SIZE - 12\) \/ 2/.test(cam));
  ok("haptic on start and stop", /onState: \(s\) =>[\s\S]{0,300}Haptics\.ImpactFeedbackStyle\.Medium/.test(hook));
  ok("delete-last (backspace icon) left, Next (check) right, both outside recording", /<Delete /.test(cam) && /<Check /.test(cam) && /sideSlot/.test(cam));
  ok("flip and flash in a right-side column of 48 pt buttons; flash on both cameras (torch on the back, screen light on the front)", /styles\.toolColumn/.test(cam) && /TOOL_SIZE = 48/.test(cam) && /onPress=\{toggleFlash\}/.test(cam) && !/facing === "back" && \(\s*<Pressable\s+onPress=\{toggleTorch\}/.test(cam));
  ok("the flip icon spins and gives a light haptic", /rotate: spinDeg/.test(cam) && /hapticLight\(\)/.test(cam));
  ok("double-tap flip only on the preview zone, clear of the controls and tools; single taps do nothing", /numberOfTaps\(2\)/.test(cam) && /styles\.previewZone, \{ bottom: insets\.bottom \+ CONTROLS_ZONE, right: TOOLS_ZONE \}/.test(cam) && !/numberOfTaps\(1\)/.test(cam));
  ok("the hint text", /Tap to record  ·  Tap again to stop/.test(cam));
  ok("the last used camera is remembered, the default is the front camera", /trial:cameraFacing/.test(hook) && /useState<"back" \| "front">\("front"\)/.test(hook) && /AsyncStorage\.setItem\(FACING_KEY/.test(hook));
  ok("the view waits for the remembered camera, then stays mounted (no remount on a flip)", /\{facingLoaded && \(\s*<CameraView/.test(cam));
  ok("a flip while recording waits for onCameraReady only (a timeout just covers a camera that never says), no fixed delay", /afterFlipSettled/.test(hook) && /readyWaitersRef/.test(hook) && /FLIP_FIRST_TRY_MS = 150/.test(hook) && !/FLIP_READY_TIMEOUT_MS|FLIP_AFTER_SETTLE_MS|FLIP_SETTLE_MS/.test(hook));
  const ctl2 = read("../lib/recordingController.ts");
  ok("after a flip: first try ~150 ms (earlier on onCameraReady), then a retry every 50 ms, up to 15 tries", /MAX_START_RETRIES = 15/.test(ctl2) && /RETRY_SPACING_MS = 50/.test(ctl2) && /setTimeout\(resolve, FLIP_FIRST_TRY_MS\)/.test(hook) && /readyWaitersRef\.current\.push/.test(hook));
  ok("empty segments never reach the merge (dropped at the recorder and filtered again before Next)", /MIN_SEGMENT_MS = 200/.test(ctl2) && /discardFile\?\.\(result\.uri\)/.test(ctl2) && /usableSegments\(clips\)/.test(cam));
  ok("the gap is logged in dev and to client_errors as flipGap", /kind: "flipGap"/.test(hook) && /__DEV__/.test(hook) && /gapMs/.test(hook));
  ok("the bar and timer follow the take, so they keep advancing through a flip", /takeLiveMs/.test(cam) && /runId: takeRef\.current\?\.id/.test(cam));
  ok("the blur is brief and subtle", /intensity=\{22\}/.test(cam) && /duration: switching \? 60 : 90/.test(cam));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
