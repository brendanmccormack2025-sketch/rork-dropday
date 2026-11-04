#!/usr/bin/env node
/**
 * App Store 2.5.4: the app plays no audio in the background, so UIBackgroundModes must not contain "audio" (only
 * "remote-notification", for push). expo-video and expo-audio add "audio" at prebuild unless told not to. The last check
 * runs the real config introspection (skipped when node_modules is not installed).
 *   node --experimental-strip-types --no-warnings scripts/test-background-modes.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const root = new URL("..", import.meta.url).pathname;
const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8")).expo;
const plugin = (name) => app.plugins.find((p) => p === name || (Array.isArray(p) && p[0] === name));

eq("expo-video: background playback off (the plugin then removes 'audio')", plugin("expo-video"), ["expo-video", { supportsBackgroundPlayback: false }]);
eq("expo-audio: background playback off (its default is on)", plugin("expo-audio"), ["expo-audio", { enableBackgroundPlayback: false }]);
ok("expo-audio keeps background recording off too (never enabled)", !JSON.stringify(plugin("expo-audio")).includes("enableBackgroundRecording\":true"));
eq("app.json lists only remote-notification (push)", app.ios.infoPlist.UIBackgroundModes, ["remote-notification"]);
ok("the plugin option names exist in the installed plugins (a typo would silently do nothing)", !existsSync(join(root, "node_modules/expo-video/plugin/build/withExpoVideo.js")) || (/supportsBackgroundPlayback/.test(readFileSync(join(root, "node_modules/expo-video/plugin/build/withExpoVideo.js"), "utf8")) && /enableBackgroundPlayback/.test(readFileSync(join(root, "node_modules/expo-audio/plugin/build/withAudio.js"), "utf8"))));

// no code asks for background audio
function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".git", "ios", "android", "scripts"].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|swift)$/.test(f)) out.push(p);
  }
  return out;
}
const offenders = files(root).filter((f) => /shouldPlayInBackground|staysActiveInBackground|allowsBackgroundRecording|shouldPlayBackground|backgroundPlayback\s*[:=]\s*true|UIBackgroundModes/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length));
eq("no code or native module asks for background audio or sets background modes", offenders, []);

// the real thing
const bin = join(root, "node_modules/.bin/expo");
if (!existsSync(bin)) {
  console.log("SKIP  node_modules is not installed: the introspection check was not run");
} else {
  let modes = null;
  try {
    const out = execFileSync(bin, ["config", "--type", "introspect", "--json"], { cwd: root, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] });
    modes = JSON.parse(out.slice(out.indexOf("{"))).ios?.infoPlist?.UIBackgroundModes ?? null;
  } catch (e) {
    modes = `introspection failed: ${String(e.message).slice(0, 120)}`;
  }
  eq("`expo config --type introspect`: UIBackgroundModes is only remote-notification", modes, ["remote-notification"]);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
