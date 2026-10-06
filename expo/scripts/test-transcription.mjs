#!/usr/bin/env node
/**
 * Tests lib/transcription/mapWords.ts:
 *
 *   node --experimental-strip-types scripts/test-transcription.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import { mapWordsToEdit } from "../lib/transcription/mapWords.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });

const words = [w("a", 0, 300), w("b", 400, 700), w("c", 2000, 2300)];

eq("no cuts: unchanged", mapWordsToEdit(words, [{ startMs: 0, endMs: 3000 }]), words);
eq("no kept ranges: nothing", mapWordsToEdit(words, []), []);
eq("confidence is kept", mapWordsToEdit([{ ...w("a", 0, 300), confidence: 0.9 }], [{ startMs: 0, endMs: 500 }]), [
  { text: "a", startMs: 0, endMs: 300, confidence: 0.9 },
]);

eq(
  "word inside a removed range is dropped, later words shift",
  mapWordsToEdit(words, [
    { startMs: 0, endMs: 1000 },
    { startMs: 1500, endMs: 3000 },
  ]),
  [w("a", 0, 300), w("b", 400, 700), w("c", 1500, 1800)],
);
eq("word fully in the removed gap", mapWordsToEdit([w("x", 1100, 1400)], [
  { startMs: 0, endMs: 1000 },
  { startMs: 1500, endMs: 3000 },
]), []);

const cut = [
  { startMs: 0, endMs: 1000 },
  { startMs: 1500, endMs: 3000 },
];
eq("word 30% inside kept footage is dropped", mapWordsToEdit([w("s", 900, 1233)], cut), []);
eq("word 70% inside kept footage is kept and clamped", mapWordsToEdit([w("s", 700, 1129)], cut), [w("s", 700, 1000)]);
eq("word over half inside, at the start of a kept range, is clamped and shifted", mapWordsToEdit([w("s", 1400, 1633)], [{ startMs: 1500, endMs: 3000 }]), [w("s", 0, 133)]);
eq("word exactly 50% inside is kept", mapWordsToEdit([w("s", 900, 1100)], cut), [w("s", 900, 1000)]);
eq("word fully inside, touching both range edges", mapWordsToEdit([w("s", 0, 1000), w("t", 1500, 3000)], cut), [w("s", 0, 1000), w("t", 1000, 2500)]);
eq("word ending exactly where a kept range starts is dropped", mapWordsToEdit([w("s", 1200, 1500)], cut), []);
eq("word starting exactly where a kept range ends is dropped", mapWordsToEdit([w("s", 1000, 1300)], cut), []);
eq("extra fields survive", mapWordsToEdit([{ ...w("s", 100, 200), srcIndex: 4 }], cut), [{ text: "s", startMs: 100, endMs: 200, srcIndex: 4 }]);
eq(
  "multiple cuts: head trim, middle cut, tail trim",
  mapWordsToEdit(
    [w("a", 100, 400), w("b", 1200, 1500), w("c", 2600, 2900), w("d", 4100, 4400), w("e", 5000, 5200)],
    [
      { startMs: 1000, endMs: 2000 },
      { startMs: 2500, endMs: 3500 },
      { startMs: 4000, endMs: 4500 },
    ],
  ),
  [w("b", 200, 500), w("c", 1100, 1400), w("d", 2100, 2400)],
);
eq(
  "unsorted ranges are ordered by source time",
  mapWordsToEdit([w("a", 100, 300), w("b", 2100, 2300)], [
    { startMs: 2000, endMs: 3000 },
    { startMs: 0, endMs: 500 },
  ]),
  [w("a", 100, 300), w("b", 600, 800)],
);
eq(
  "touching ranges are one stretch: a word across the join is kept",
  mapWordsToEdit([w("j", 900, 1100)], [
    { startMs: 0, endMs: 1000 },
    { startMs: 1000, endMs: 2000 },
  ]),
  [w("j", 900, 1100)],
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
