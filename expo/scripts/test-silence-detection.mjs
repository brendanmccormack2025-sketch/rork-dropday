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

const WINDOW_MS = 20;

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
    expect: (r) => r.cuts.length === 1 && Math.abs(r.savedMs - 5920) < 200,
  },
  {
    name: "no pauses: continuous speech with 0.4 s gaps (40 s)",
    windows: build([[9000, -22], [400, -60], [9000, -21], [400, -60], [9000, -23], [400, -60], [12000, -22]]),
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
    name: "eight pauses: all eight are cut (limit is 14) (60 s)",
    windows: build([
      [4000, -22], [1500, -70], [4000, -22], [2000, -70], [4000, -22], [2500, -70],
      [4000, -22], [3000, -70], [4000, -22], [3500, -70], [4000, -22], [4000, -70],
      [4000, -22], [4500, -70], [4000, -22], [5000, -70], [4000, -22],
    ]),
    expect: (r) => r.cuts.length === 8 && r.silences.length === 8 && r.silences.filter((s) => s.cut).length === 8,
  },
  {
    name: "short clip: 5 s with a 3 s pause would leave under the 3 s floor",
    windows: build([[1000, -22], [3000, -70], [1000, -22]]),
    expect: (r) => r.cuts.length === 0 && r.silences.length === 1,
  },
  {
    name: "pause of 0.4 s is below the 0.5 s minimum",
    windows: build([[10000, -22], [400, -70], [10000, -22]]),
    expect: (r) => r.silences.length === 0 && r.cuts.length === 0,
  },
  {
    name: "pause of 1.4 s keeps 30 ms after speech and 50 ms before: cut is ~1.32 s",
    windows: build([[10000, -22], [1400, -70], [10000, -22]]),
    expect: (r) => r.cuts.length === 1 && Math.abs(r.cuts[0].lengthMs - 1320) <= 60,
  },
  {
    name: "pause of 0.6 s qualifies (0.5 s minimum): cut is ~0.52 s",
    windows: build([[10000, -22], [600, -70], [10000, -22]]),
    expect: (r) => r.cuts.length === 1 && Math.abs(r.cuts[0].lengthMs - 520) <= 60,
  },
  {
    name: "sixteen pauses: at most 14 cuts (90 s)",
    windows: build(
      Array.from({ length: 16 }, (_, i) => [[4000, -22], [800 + i * 50, -70]]).flat().concat([[4000, -22]]),
    ),
    expect: (r) => r.cuts.length === 14 && r.silences.length === 16 && r.silences.filter((s) => s.cut).length === 14,
  },
  {
    name: "350 ms rule: a 200 ms burst between two pauses would be a 280 ms piece, so one cut is dropped",
    windows: build([[8000, -22], [1000, -70], [200, -22], [1000, -70], [8000, -22]], 0),
    expect: (r) => r.cuts.length === 1 && r.keepRanges.every((k) => k.lengthMs >= 350),
  },
  {
    name: "350 ms rule: a 400 ms burst (kept piece ~480 ms) keeps both cuts",
    windows: build([[8000, -22], [1000, -70], [400, -22], [1000, -70], [8000, -22]], 0),
    expect: (r) => r.cuts.length === 2 && r.keepRanges.every((k) => k.lengthMs >= 350),
  },
  {
    name: "soft onset: look-back keeps up to 40 ms of a rising consonant (20 ms windows)",
    windows: build([[8000, -22], [2000, -70], [20, -66], [20, -65], [8000, -22]], 0),
    expect: (r, noLookBack) =>
      r.silences.length === 1 &&
      noLookBack.silences[0].endMs - r.silences[0].endMs === 40 &&
      r.cuts[0].endMs === noLookBack.cuts[0].endMs - 40,
  },
  {
    name: "flat silence: look-back changes nothing (no rise above floor + 3 dB)",
    windows: build([[8000, -22], [2000, -70], [8000, -22]], 0),
    expect: (r, noLookBack) => r.silences[0].endMs === noLookBack.silences[0].endMs,
  },
  {
    name: "one noisy window inside a pause does not split it (3-window smoothing)",
    windows: build([[8000, -22], [1000, -70], [20, -30], [1000, -70], [8000, -22]], 0),
    expect: (r) => r.silences.length === 1 && r.silences[0].lengthMs >= 2000,
  },
];

let failed = 0;
for (const c of cases) {
  const r = detectSilences(c.windows, WINDOW_MS);
  const ok = c.expect(r, detectSilences(c.windows, WINDOW_MS, { onsetLookBackMs: 0 }));
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
