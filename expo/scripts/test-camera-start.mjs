#!/usr/bin/env node
/**
 * The camera always opens: no brightness module needed, nothing waits at start, flash toggles whatever brightness does,
 * the glow never blocks touches, a failed start shows Retry, and flipGap is a metric.
 *   node --experimental-strip-types --no-warnings scripts/test-camera-start.mjs
 */
import { readFileSync } from "node:fs";
import { createScreenLight } from "../lib/screenLightCore.ts";
import { flashMode } from "../lib/cameraFlash.ts";
import { START_TIMEOUT_MS, startFailure, withTimeout } from "../lib/cameraStart.ts";
import { createErrorRecorder } from "../lib/errorRecorder.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const never = () => new Promise(() => {});
const timed = async (f) => { const t = Date.now(); await f(); return Date.now() - t; };

// ── brightness module absent (build 1.0.4) ──
{
  let looked = 0;
  const light = createScreenLight(() => { looked++; return null; });
  eq("creating the light at camera start does nothing: the module is not even looked up", looked, 0);
  ok("with the module absent, flash on/off do not throw and return at once", (await timed(async () => { await light.on(); await light.off(); await light.on(); })) < 50);
  eq("(the lookup happens once, on first use)", looked, 1);
  const src = read("../lib/screenLight.ts");
  ok("expo-brightness is never imported, only found by name at run time", !/from "expo-brightness"|require\("expo-brightness"\)|import\("expo-brightness"\)/.test(src) && /requireOptionalNativeModule<BrightnessModule>\("ExpoBrightness"\)/.test(src));
  const all = ["../app/camera.tsx", "../hooks/useCameraRecorder.ts", "../lib/screenLightCore.ts", "../lib/cameraFlash.ts"].map(read).join("\n");
  ok("nothing else imports it either", !/(from|import\(|require\()\s*["']expo-brightness/.test(all));
  const throwing = createScreenLight(() => { throw new Error("no module"); });
  await throwing.on(); await throwing.off();
  ok("a lookup that throws just means no brightness", true);
}

// ── a brightness call that hangs or fails never blocks the camera ──
{
  const hanging = createScreenLight(() => ({ get: never, set: never }), 30);
  const t = await timed(() => hanging.on());
  ok("a hanging native call is given up after its time limit (30 ms in this test), not waited for", t >= 25 && t < 400);
  const t2 = await timed(() => hanging.off());
  ok("off() with nothing to restore returns at once", t2 < 50);
  const failing = createScreenLight(() => ({ get: async () => { throw new Error("native"); }, set: async () => { throw new Error("native"); } }));
  await failing.on(); await failing.off();
  ok("rejecting native calls never throw out", true);
  const sync = createScreenLight(() => ({ get: () => { throw new Error("sync"); }, set: () => { throw new Error("sync"); } }));
  await sync.on(); await sync.off();
  ok("synchronous throws never throw out", true);
  // the camera only ever does `void light.on().catch()`: it does not wait; the flash state is separate
  const cam = read("../app/camera.tsx");
  ok("camera start only fires the light and forgets (void ... .catch), never awaits it", /void screenLight\.on\(\)\.catch\(\(\) => \{\}\)/.test(cam) && /void screenLight\.off\(\)\.catch/.test(cam) && !/await screenLight/.test(cam));
  ok("the light is created lazily from a getter, not with a module lookup at start", /createScreenLight\(nativeBrightness\)/.test(cam) && !/createScreenLight\(nativeBrightness\(\)\)/.test(cam));
}

// ── opening with flash ON, and toggling ──
{
  eq("flash ON on the front camera = the glow, with no await anywhere in the mode", [flashMode("front", true), flashMode("back", true)], ["screen", "torch"]);
  const hook = read("../hooks/useCameraRecorder.ts");
  ok("the camera opens with flash OFF: it is not persisted (so an old setting cannot start it in the glow)", /const \[flashOn, setFlashOn\] = useState\(false\)/.test(hook) && !/FLASH_KEY|setItem\([^)]*flash/i.test(hook));
  ok("toggling flash is a plain state flip, independent of brightness", /setFlashOn\(\(on\) => !on\)/.test(hook) && !/screenLight|brightness/i.test(hook));
  // start with flash ON and a dead brightness module: the state machine still toggles
  let on = true;
  const light = createScreenLight(() => ({ get: never, set: never }), 10);
  const toggles = [];
  for (let i = 0; i < 4; i++) { on = !on; toggles.push(on); void (on ? light.on() : light.off()); }
  eq("flash toggles four times while brightness hangs", toggles, [false, true, false, true]);
  ok("(and the glow follows the switch)", flashMode("front", toggles[1]) === "screen" && flashMode("front", toggles[0]) === "off");
}

// ── the glow never blocks touches ──
{
  const cam = read("../app/camera.tsx");
  ok("it is pointerEvents none and rendered only for the front camera with flash on", /\{flash === "screen" && <View pointerEvents="none" style=\{styles\.screenLight\}/.test(cam));
  ok("it sits under the controls (zIndex 4 < the preview zone 5, the tools 10, the bottom row 12)", /screenLight: \{[^}]*zIndex: 4/.test(cam) && /zIndex: 12/.test(cam));
}

// ── reading the remembered camera cannot hang the start ──
{
  eq("storage that never answers: the default after the limit", await withTimeout(never(), 20, null), null);
  eq("storage that answers: its value", await withTimeout(Promise.resolve("back"), 20, null), "back");
  eq("storage that fails: the default", await withTimeout(Promise.reject(new Error("x")), 20, null), null);
  const hook = read("../hooks/useCameraRecorder.ts");
  ok("the hook uses it for the facing read", /withTimeout\(AsyncStorage\.getItem\(FACING_KEY\), FACING_READ_TIMEOUT_MS, null\)/.test(hook));
}

// ── a camera that does not start shows Retry ──
{
  const base = { viewMounted: true, ready: false, mountError: null, elapsedMs: 0 };
  eq("still starting: nothing", startFailure({ ...base, elapsedMs: 2000 }), null);
  eq("not ready in time: stalled", startFailure({ ...base, elapsedMs: START_TIMEOUT_MS }), "stalled");
  eq("ready: fine, however long it has been", startFailure({ ...base, ready: true, elapsedMs: 60000 }), null);
  eq("a mount error is a failure at once", startFailure({ ...base, mountError: "no camera" }), "mount-error");
  eq("the view not shown yet (permission screen) is not a failure", startFailure({ ...base, viewMounted: false, elapsedMs: 60000 }), null);
  const cam = read("../app/camera.tsx");
  ok("a boundary around the screen catches render errors and failed starts: 'Camera couldn't start.' with Retry", /class CameraBoundary extends React\.Component/.test(cam) && /getDerivedStateFromError/.test(cam) && /CAMERA_FAILED_TEXT/.test(cam) && /label="Retry"/.test(cam));
  ok("every failure is logged to client_errors as kind cameraStart", (cam.match(/kind: "cameraStart"/g) ?? []).length >= 2);
  ok("Retry mounts the camera screen again (new key)", /key=\{attempt\}/.test(cam) && /setAttempt\(\(a\) => a \+ 1\)/.test(cam));
  ok("the watchdog reports a stall or a mount error", /startFailure\(\{ viewMounted: true, ready: false/.test(cam) && /onFailure\("mount-error"\)/.test(cam));
}

// ── flipGap is a metric, not an error ──
{
  const rows = [];
  const rec = createErrorRecorder({
    storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    now: () => 1,
    context: () => ({ screen: "camera", appVersion: "1.0.4", buildNumber: "1", updateId: null, userId: "u" }),
    upload: async (r) => { rows.push(...r); },
  });
  await rec.reportNow("flipGap gapMs=152 retries=0", { kind: "metric", metric: "flipGap", gapMs: 152, retries: 0 });
  eq("a metric is stored with kind 'metric', its numbers in the context, and NO stack", [rows[0].context.kind, rows[0].context.gapMs, rows[0].stack], ["metric", 152, ""]);
  const ce = read("../lib/clientErrors.ts");
  ok("recordMetric reports a plain string with kind 'metric'", /export function recordMetric/.test(ce) && /kind: "metric", metric: name/.test(ce));
  const hook = read("../hooks/useCameraRecorder.ts");
  ok("the flip gap is logged through it (dev log kept), no Error object", /recordMetric\("flipGap", \{ gapMs:/.test(hook) && !/new Error\("camera flip gap"\)/.test(hook));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
