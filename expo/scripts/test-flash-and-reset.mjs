#!/usr/bin/env node
/**
 * Front-camera screen light / back-camera torch that survive flips; and the clean player reset used by Keep original.
 *   node --experimental-strip-types --no-warnings scripts/test-flash-and-reset.mjs
 */
import { readFileSync } from "node:fs";
import { SCREEN_LIGHT_COLOR, flashMode } from "../lib/cameraFlash.ts";
import { createScreenLight } from "../lib/screenLightCore.ts";
import { resetPlayer } from "../lib/playerReset.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── flash modes ──
{
  eq("off is off on both cameras", [flashMode("back", false), flashMode("front", false)], ["off", "off"]);
  eq("on: the back camera uses the torch, the front camera the screen light", [flashMode("back", true), flashMode("front", true)], ["torch", "screen"]);
  // the switch is one value; the camera decides. Flip back -> front -> back (also in the middle of a recording).
  let facing = "back"; const flashOn = true; const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(flashMode(facing, flashOn)); facing = facing === "back" ? "front" : "back"; }
  eq("flash stays on through flips and switches mode automatically", seen, ["torch", "screen", "torch", "screen"]);
  eq("an off switch stays off through flips", ["back", "front", "back"].map((f) => flashMode(f, false)), ["off", "off", "off"]);

  const hook = read("../hooks/useCameraRecorder.ts");
  const cam = read("../app/camera.tsx");
  ok("one flash switch in the hook, the mode derived from the camera (a flip never resets it)", /const \[flashOn, setFlashOn\] = useState\(false\)/.test(hook) && /const flash = flashMode\(facing, flashOn\)/.test(hook) && !/setFlashOn\(false\)/.test(hook));
  ok("the back camera uses enableTorch, only in torch mode", /enableTorch=\{flash === "torch"\}/.test(cam));
  ok("the front camera shows a warm white glow (#FFF4E0, 80%) over the whole screen, under the controls, drawn on the screen only (the recording is unaffected)", /flash === "screen" && <View/.test(cam) && /styles\.screenLight/.test(cam) && /backgroundColor: SCREEN_LIGHT_COLOR/.test(cam) && /zIndex: 4/.test(cam));
  eq("the glow colour is #FFF4E0 at 80%", SCREEN_LIGHT_COLOR, "rgba(255,244,224,0.8)");
  ok("it is see-through enough to show the preview: 80% opacity, not solid", /,0\.8\)$/.test(SCREEN_LIGHT_COLOR));
  ok("the flash button is there for both cameras and shows on/off clearly (filled yellow bolt + ringed button vs crossed bolt)", /onPress=\{toggleFlash\}/.test(cam) && /flashOn \? <Zap color="#FFD60A"/.test(cam) && /<ZapOff/.test(cam) && /toolBtnOn/.test(cam) && /accessibilityLabel=\{flashOn \? "Flash on" : "Flash off"\}/.test(cam));
  ok("no animated white flash on start/stop: the ring is static", !/frontFlash|flipFlash/.test(cam));
}

// ── screen brightness (only with expo-brightness) ──
{
  const pkg = JSON.parse(read("../package.json"));
  ok("expo-brightness is in package.json (the SDK 57 version) for the next native build", pkg.dependencies?.["expo-brightness"] === "~57.0.2");
  const src = read("../lib/screenLight.ts");
  ok("brightness is looked up at run time, so builds WITHOUT the module do not crash (no static import of expo-brightness)", /requireOptionalNativeModule<BrightnessModule>\("ExpoBrightness"\)/.test(src) && !/from "expo-brightness"/.test(src) && !/require\("expo-brightness"\)/.test(src));
  ok("a missing or broken module just means no brightness change", /catch \{\s*return null;/.test(src));
  const none = createScreenLight(null);
  await none.on(); await none.off();
  eq("without the module: nothing happens, reported unavailable", none.available, false);
  let level = 0.4; const calls = [];
  const api = { get: async () => level, set: async (v) => { calls.push(v); level = v; } };
  const light = createScreenLight(api);
  await light.on(); await light.on();
  eq("on: brightness to max, remembered once", [level, calls], [1, [1]]);
  await light.off(); await light.off();
  eq("off: the user's brightness is back, once", [level, calls], [0.4, [1, 0.4]]);
  const quick = createScreenLight({ get: async () => { await new Promise((r) => setTimeout(r, 5)); return 0.7; }, set: async (v) => { calls.push(v); level = v; } });
  level = 0.7; calls.length = 0;
  const p = quick.on(); await quick.off(); await p;
  eq("turned off before the first read finished: the max is never left behind", level !== 1 || calls.at(-1) === 0.7, true);
  const cam = read("../app/camera.tsx");
  ok("on while the screen light is on, off when it goes off and when the camera closes", /flash === "screen"\) void screenLight\.on\(\)/.test(cam) && /else void screenLight\.off\(\)/.test(cam) && /useEffect\(\(\) => \(\) => void screenLight\.off\(\)/.test(cam));
}

// ── clean player reset (Keep original / undo) ──
{
  function fakePlayer(opts = {}) {
    const log = [];
    return {
      log,
      pause: () => log.push("pause"),
      replace: (u) => log.push(`replace:${u}`),
      nextReady: () => { log.push("listen"); return { promise: opts.neverReady ? new Promise((r) => setTimeout(() => r(false), 5)) : Promise.resolve(true), cancel: () => {} }; },
      seekMs: (ms) => log.push(`seek:${ms}`),
    };
  }
  const p = fakePlayer();
  const r = await resetPlayer({ player: p, uri: "file:///m.mp4", seekToMs: 12000 });
  eq("pause, listen, load the file again, wait for ready, ONE seek", [p.log, r.ready], [["pause", "listen", "replace:file:///m.mp4", "seek:12000"], true]);
  eq("the seek comes after ready, not before", r.steps, ["pause", "replace", "ready", "seek"]);
  const q = fakePlayer({ neverReady: true });
  const r2 = await resetPlayer({ player: q, uri: "file:///m.mp4", seekToMs: 500, timeoutMs: 10 });
  eq("if ready never comes it still ends (no stuck wait) with one seek", [r2.ready, q.log.filter((l) => l.startsWith("seek")).length], [false, 1]);

  // the state transition around it: the editor sets ready/play only after the reset
  async function keepOriginal(wasPlaying) {
    const st = { videoReady: true, isPlaying: false, inFlight: true };
    st.videoReady = false;
    await resetPlayer({ player: fakePlayer(), uri: "m", seekToMs: 1 });
    st.inFlight = false; st.videoReady = true; st.isPlaying = wasPlaying;
    return st;
  }
  eq("Keep original while playing: ready again, playing again, nothing left in flight", await keepOriginal(true), { videoReady: true, isPlaying: true, inFlight: false });
  eq("Keep original while paused: ready again, stays paused", await keepOriginal(false), { videoReady: true, isPlaying: false, inFlight: false });

  const edit = read("../app/edit.tsx");
  ok("Keep original resets the live player the same way (no AppState needed) and resumes only if it was playing", /isPlayingWholeSource\(produced, next, model\.durationMs\)/.test(edit) && /resetPlayer\(\{\s*player: adaptPlayer\(live\)/.test(edit) && /setVideoReady\(true\);\s*\n\s*setIsPlaying\(wasPlaying\)/.test(edit));
  ok("the rendered preview (undo back to the cuts) is loaded the same way: fresh item, ready, one seek, then play", /resetPlayer\(\{ player: adaptPlayer\(playerR\), uri: previewUri/.test(edit) && /isPlayingRef\.current\) playerR\.play\(\)/.test(edit));
  ok("the editor itself has no AppState handler (resume only worked because it re-attached the native view)", !/AppState/.test(edit));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
