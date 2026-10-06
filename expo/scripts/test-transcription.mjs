#!/usr/bin/env node
/**
 * Tests lib/transcription/mapWords.ts:
 *
 *   node --experimental-strip-types scripts/test-transcription.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import { mapWordsToEdit } from "../lib/transcription/mapWords.ts";
import { applyLineEdit, buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";

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

// ── caption lines ──
const talk = [w("one", 0, 300), w("two", 350, 650), w("three", 700, 1000), w("four", 1050, 1350), w("five", 1400, 1700)];
const whole = [{ startMs: 0, endMs: 5000 }];
eq("max 3 words per line", buildCaptionLines(talk, {}, whole).map((l) => l.text), ["one two three", "four five"]);
eq(
  "no line longer than 1.5 s",
  buildCaptionLines([w("a", 0, 600), w("b", 650, 1250), w("c", 1300, 1900)], {}, whole).map((l) => l.text),
  ["a b", "c"],
);
eq(
  "a pause over 400 ms breaks the line",
  buildCaptionLines([w("a", 0, 300), w("b", 800, 1100)], {}, whole).map((l) => l.text),
  ["a", "b"],
);
eq("line times and source indexes", buildCaptionLines(talk, {}, whole).map((l) => [l.startMs, l.endMs, l.srcIndexes]), [
  [0, 1000, [0, 1, 2]],
  [1050, 1700, [3, 4]],
]);
const cutKept = [
  { startMs: 0, endMs: 700 },
  { startMs: 1050, endMs: 5000 },
];
eq(
  "words are mapped onto the edited timeline before grouping",
  buildCaptionLines(talk, {}, cutKept).map((l) => [l.text, l.startMs, l.endMs]),
  [["one two four", 0, 1000], ["five", 1050, 1350]],
);
eq("overlays", captionLinesToEditOverlays(buildCaptionLines([w("hi", 100, 400)], {}, whole)), [
  { kind: "caption", text: "hi", startMs: 100, endMs: 400, style: "trial" },
]);

// ── edits are stored against source words and survive cut changes ──
const base = buildCaptionLines(talk, {}, whole);
const edited = applyLineEdit(talk, {}, base[0], "ONE 2 THREE");
eq("edit keyed by source word index", edited, { 0: "ONE", 1: "2", 2: "THREE" });
eq("edited text shows", buildCaptionLines(talk, edited, whole)[0].text, "ONE 2 THREE");
eq(
  "edits survive when the cuts change",
  buildCaptionLines(talk, edited, cutKept).map((l) => l.text),
  ["ONE 2 four", "five"],
);
eq("unchanged words lose their edit", applyLineEdit(talk, edited, base[0], "one two three"), {});
eq("fewer words typed deletes the rest", applyLineEdit(talk, {}, base[0], "hello"), { 0: "hello", 1: "", 2: "" });
eq("deleted words leave the line", buildCaptionLines(talk, { 0: "hello", 1: "", 2: "" }, whole).map((l) => l.text), ["hello", "four five"]);
eq("extra typed words join the last word", applyLineEdit(talk, {}, base[1], "a b c d"), { 3: "a", 4: "b c d" });

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
