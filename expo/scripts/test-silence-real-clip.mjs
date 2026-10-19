#!/usr/bin/env node
/**
 * Pause removal on a REAL clip (Brendan's 47 s talking video, Oct 2026: the editor left most pauses in). The fixture is
 * its loudness, 20 ms RMS dBFS windows, as the phone measures it. Every real pause is cut, no speech is.
 *   node --experimental-strip-types --no-warnings scripts/test-silence-real-clip.mjs
 */
import { readFileSync } from "node:fs";
import { BLIP_MAX_MS, SENSITIVITY_PRESETS, detectSilences } from "../lib/silenceDetection.ts";

let failed = 0;
const ok = (n, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n}`); };
const { windows, durationMs } = JSON.parse(readFileSync(new URL("./fixtures/real-clip-pauses.json", import.meta.url), "utf8"));
const run = (s) => detectSilences(windows, 20, { durationMs, ...SENSITIVITY_PRESETS[s] });
const tight = run("tight"), normal = run("normal"), gentle = run("gentle");
const covers = (r, a, b) => r.cuts.some((c) => c.startMs <= a * 1000 && c.endMs >= b * 1000);

// the pauses you can hear in the clip (quiet stretches between sentences)
ok("the opening silence is trimmed", covers(tight, 0, 0.9));
ok("the long pause at 7-11 s is cut in one piece (breaths inside it no longer split it)", covers(tight, 7.4, 10.8));
ok("the pause at 12-13.5 s is cut", covers(tight, 11.8, 13.5));
ok("the pause at 25-26 s is cut", covers(tight, 25.1, 26.1));
ok("the pause at 34-36 s is cut in one piece", covers(tight, 34.1, 36.1));
ok("the 5 s ending is trimmed to the end (a tap on stop no longer keeps it)", tight.cuts.some((c) => c.edge === "end" && c.startMs <= 42600 && c.endMs === durationMs));
ok("about a third of the clip is pauses: 14-19 s removed", tight.savedMs >= 14000 && tight.savedMs <= 19000);

// no speech is cut: anything louder than a whisper inside a cut lasts at most a click (<= 80 ms)
const loudRunsInCuts = (r) => r.cuts.flatMap((c) => {
  const out = []; let len = 0;
  for (let w = Math.floor(c.startMs / 20); w < Math.ceil(c.endMs / 20); w++) { if (windows[w] > -40) len += 20; else { if (len) out.push(len); len = 0; } }
  if (len) out.push(len); return out;
});
ok("no cut contains speech (only clicks or breaths of 80 ms or less)", Math.max(0, ...loudRunsInCuts(tight)) <= 80);
ok("blips are joined only up to " + BLIP_MAX_MS + " ms", BLIP_MAX_MS === 600);
ok("gentle cuts less than normal, normal less than tight", gentle.savedMs < normal.savedMs && normal.savedMs < tight.savedMs);
ok("even gentle cuts the obvious pauses", covers(gentle, 8.1, 10.8) && gentle.savedMs >= 8000);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
