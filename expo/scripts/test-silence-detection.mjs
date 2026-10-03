#!/usr/bin/env node
/**
 * Runs lib/silenceDetection.ts on synthetic loudness arrays and checks the
 * result. No test framework needed:
 *
 *   node --experimental-strip-types scripts/test-silence-detection.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import { detectSilences } from "../lib/silenceDetection.ts";

const WINDOW_MS = 50;

// Small deterministic jitter so windows are not perfectly flat.
let seed = 12345;
function jitter(amountDb) {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return ((seed / 4294967296) * 2 - 1) * amountDb;
}

/** Build windows from [lengthMs, dB] segments. */
function build(segments, jitterDb = 2) {
  const out = [];
  for (const [ms, db] of segments) {
    const n = Math.round(ms / WINDOW_MS);
    for (let i = 0; i < n; i++) out.push(db + jitter(jitterDb));
  }
  return out;
}

const cases = [
  {
    name: "quiet room: speech with two 2.5 s pauses (30 s)",
    windows: build([[8000, -22], [2500, -68], [9000, -24], [2500, -70], [8000, -21]]),
    expect: (r) => r.cuts.length === 2 && r.savedMs > 3500 && r.keepRanges.length === 3,
  },
  {
    name: "noisy room: fan at -42 dB, pause is only the fan (30 s)",
    windows: build([[10000, -20], [3000, -42], [17000, -22]]),
    expect: (r) => r.cuts.length === 1 && r.thresholdDb <= -35,
  },
  {
    name: "loud background (-25 dB) with quieter patches: never silence (30 s)",
    windows: build([[10000, -15], [4000, -26], [16000, -14]]),
    expect: (r) => r.cuts.length === 0 && r.silences.length === 0,
  },
  {
    name: "one long pause (60 s clip, 6 s pause)",
    windows: build([[27000, -23], [6000, -72], [27000, -22]]),
    expect: (r) => r.cuts.length === 1 && Math.abs(r.savedMs - 5750) < 200,
  },
  {
    name: "no pauses: continuous speech with 0.6 s gaps (40 s)",
    windows: build([[9000, -22], [600, -60], [9000, -21], [600, -60], [9000, -23], [600, -60], [11200, -22]]),
    expect: (r) => r.cuts.length === 0 && r.savedMs === 0 && r.keepRanges.length === 1,
  },
  {
    name: "muted track (all digital silence)",
    windows: build([[30000, -100]], 0),
    expect: (r) => r.cuts.length === 0 && r.skipReason === "no_activity",
  },
  {
    name: "too long (200 s)",
    windows: build([[100000, -22], [5000, -70], [95000, -22]]),
    expect: (r) => r.cuts.length === 0 && r.skipReason === "too_long",
  },
  {
    name: "eight pauses: at most 5 cuts, longest kept (60 s)",
    windows: build([
      [4000, -22], [1500, -70], [4000, -22], [2000, -70], [4000, -22], [2500, -70],
      [4000, -22], [3000, -70], [4000, -22], [3500, -70], [4000, -22], [4000, -70],
      [4000, -22], [4500, -70], [4000, -22], [5000, -70], [4000, -22],
    ]),
    expect: (r) => r.cuts.length === 5 && r.silences.length === 8 && r.silences.filter((s) => s.cut).length === 5,
  },
  {
    name: "short clip: 7 s with a 3 s pause would leave under 5 s",
    windows: build([[2000, -22], [3000, -70], [2000, -22]]),
    expect: (r) => r.cuts.length === 0 && r.silences.length === 1,
  },
  {
    name: "pause of 0.8 s is below the 0.9 s minimum",
    windows: build([[10000, -22], [800, -70], [10000, -22]]),
    expect: (r) => r.silences.length === 0 && r.cuts.length === 0,
  },
  {
    name: "pause of 1.4 s keeps 0.1 s after speech and 0.15 s before: cut is ~1.15 s",
    windows: build([[10000, -22], [1400, -70], [10000, -22]]),
    expect: (r) => r.cuts.length === 1 && Math.abs(r.cuts[0].lengthMs - 1150) <= 100,
  },
  {
    name: "pause of 1.0 s now qualifies (0.9 s minimum): cut is ~0.75 s, under the 2 s apply threshold",
    windows: build([[10000, -22], [1000, -70], [10000, -22]]),
    expect: (r) => r.cuts.length === 1 && Math.abs(r.cuts[0].lengthMs - 750) <= 100 && r.savedMs < 2000,
  },
];

let failed = 0;
for (const c of cases) {
  const r = detectSilences(c.windows, WINDOW_MS);
  const ok = c.expect(r);
  if (!ok) failed++;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(
    `  duration ${(c.windows.length * WINDOW_MS) / 1000}s  floor ${r.noiseFloorDb.toFixed(1)} dB  threshold ${r.thresholdDb.toFixed(1)} dB  skip=${r.skipReason}`,
  );
  console.log(
    `  silences: ${r.silences.map((s) => `${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)}s${s.cut ? "*" : ""}`).join(", ") || "none"}`,
  );
  console.log(
    `  cuts: ${r.cuts.map((s) => `${(s.startMs / 1000).toFixed(2)}-${(s.endMs / 1000).toFixed(2)}s`).join(", ") || "none"}  saved ${(r.savedMs / 1000).toFixed(2)}s`,
  );
  console.log(
    `  keep: ${r.keepRanges.map((s) => `${(s.startMs / 1000).toFixed(2)}-${(s.endMs / 1000).toFixed(2)}s`).join(", ")}`,
  );
}

console.log(`\n${cases.length - failed}/${cases.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
