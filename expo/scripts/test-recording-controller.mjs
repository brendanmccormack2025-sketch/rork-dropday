#!/usr/bin/env node
/**
 * The camera's recording state machine with a fake camera: start/stop, no auto-restart, double-tap guard,
 * flip while recording, 60 s auto-stop, facing memory, and the screen wiring.
 *   node --experimental-strip-types scripts/test-recording-controller.mjs
 */
import { readFileSync } from "node:fs";
import { RecordingController } from "../lib/recordingController.ts";
import { canProceed, deleteLastRun, totalMs } from "../lib/cameraSegments.ts";

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
  let pending = null;
  let n = 0;
  let facing = "front";
  let readyResolvers = [];
  const deps = {
    record: (max) => {
      log.push(`record(${max})`);
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
    afterFlipSettled: async () => { log.push("settling"); await tick(); await tick(); log.push("settled"); },
    getSegments: () => segments,
    onSegment: (s) => { segments.push(s); log.push(`segment:${s.uri.split("/").pop()}`); },
    onState: (s) => states.push(s),
    onError: (m) => { if (m) errors.push(m); },
    onSwitching: (b) => log.push(`switching=${b}`),
    now: () => t,
    newId: () => `id${++n}`,
    delay: (ms) => (ms >= 1000 ? new Promise(() => {}) : new Promise((r) => setTimeout(r, Math.min(ms, 5)))),
  };
  return { deps, log, segments, states, errors, get facing() { return facing; }, get pending() { return pending; }, advance: (ms) => { t += ms; } };
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
  stubborn.stopNative = () => { calls++; if (calls >= 3 && resolveRec) { const f = resolveRec; resolveRec = null; f({ uri: "file:///x.mov" }); } };
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
  eq("(taps are ignored while it switches)", [d.toggle(), d.flip()], ["ignored", false]);
  // let the switch finish, then the new segment records
  for (let i = 0; i < 10; i++) await tick();
  const order = r2.log.filter((l) => /^(record|segment|facing|settling|settled|ready\?)/.test(l.split("(")[0] + (l.startsWith("record") ? "" : "")) || l.startsWith("record("));
  const iSeg1 = r2.log.indexOf("segment:seg1.mov");
  const iFace = r2.log.indexOf("facing=back");
  const iSettled = r2.log.indexOf("settled");
  const iRec2 = r2.log.findIndex((l, i) => l.startsWith("record(") && i > iSettled);
  ok("the segment ends first, then the camera switches, then the new camera settles, THEN a new segment starts", iSeg1 >= 0 && iFace > iSeg1 && iSettled > iFace && iRec2 > iSettled);
  eq("one segment so far and a second recording under way, on the other camera", [r2.segments.length, r2.facing, d.state], [1, "back", "recording"]);
  d.stop(); await d.settled();
  eq("two segments after stopping; the preview blur went on and off", [r2.segments.length, r2.log.filter((l) => l.startsWith("switching=")).slice(0, 2)], [2, ["switching=true", "switching=false"]]);
  eq("each flip made its own segment (own run id), so the bar shows a notch", new Set(r2.segments.map((s) => s.runId)).size, 2);

  // stop during the switch ends the take: no new segment
  const r3 = rig();
  const e = new RecordingController(r3.deps);
  e.start(); await tick(); await tick(); e.flip();
  for (let i = 0; i < 10; i++) await tick();
  e.stop(); await e.settled();
  eq("(flip then stop: exactly two segments, idle)", [r3.segments.length, e.state], [2, "idle"]);
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
  ok("the controller has no loop that records again after a stop (only the explicit flip restart)", !/while \(true\)/.test(read("../lib/recordingController.ts")) && (read("../lib/recordingController.ts").match(/this\.deps\.record\(/g) ?? []).length === 1);
  ok("the camera view is created once, with the facing prop, and is not keyed", (cam.match(/<CameraView/g) ?? []).length === 1 && /facing=\{facing\}/.test(cam) && !/<CameraView[^>]*key=/.test(cam));
  ok("no white overlays or flashes: no #fff full-screen fills, no front flash", !/backgroundColor: "#fff"[\s\S]{0,40}opacity/.test(cam) && !/frontFlash|flipFlash/.test(cam) && /fullscreen: \{ flex: 1, backgroundColor: "#000" \}/.test(cam));
  ok("the camera screen's own background is black (the light app background never shows through)", /contentStyle: \{ backgroundColor: "#000" \}/.test(layout));
  ok("a dark blur (not white) covers the preview while a flip switches", /<BlurView[^>]*tint="dark"/.test(cam) && /switching/.test(cam));
  ok("circle record button, 72 pt+ target, red with a pulse while recording", /RECORD_TOUCH = 88/.test(cam) && /RECORD_SIZE = 76/.test(cam) && /recordDiscRecording/.test(cam) && /Animated\.loop/.test(cam) && /borderRadius: \(RECORD_SIZE - 12\) \/ 2/.test(cam));
  ok("haptic on start and stop", /onState: \(s\) =>[\s\S]{0,300}Haptics\.ImpactFeedbackStyle\.Medium/.test(hook));
  ok("delete-last (backspace icon) left, Next (check) right, both outside recording", /<Delete /.test(cam) && /<Check /.test(cam) && /sideSlot/.test(cam));
  ok("flip and flash in a right-side column of 48 pt buttons; flash only on the back camera", /styles\.toolColumn/.test(cam) && /TOOL_SIZE = 48/.test(cam) && /facing === "back" && \(/.test(cam));
  ok("the flip icon spins and gives a light haptic", /rotate: spinDeg/.test(cam) && /hapticLight\(\)/.test(cam));
  ok("double-tap flip only on the preview zone, clear of the controls and tools; single taps do nothing", /numberOfTaps\(2\)/.test(cam) && /styles\.previewZone, \{ bottom: insets\.bottom \+ CONTROLS_ZONE, right: TOOLS_ZONE \}/.test(cam) && !/numberOfTaps\(1\)/.test(cam));
  ok("the hint text", /Tap to record  ·  Tap again to stop/.test(cam));
  ok("the last used camera is remembered, the default is the front camera", /trial:cameraFacing/.test(hook) && /useState<"back" \| "front">\("front"\)/.test(hook) && /AsyncStorage\.setItem\(FACING_KEY/.test(hook));
  ok("the view waits for the remembered camera, then stays mounted (no remount on a flip)", /\{facingLoaded && \(\s*<CameraView/.test(cam));
  ok("a flip while recording waits for the camera: onCameraReady or a settle time, then a new segment", /afterFlipSettled/.test(hook) && /readyWaitersRef/.test(hook) && /FLIP_SETTLE_MS/.test(hook));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
