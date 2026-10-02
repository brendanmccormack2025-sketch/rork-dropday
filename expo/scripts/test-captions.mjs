#!/usr/bin/env node
/**
 * Tests lib/captions.ts. No test framework needed:
 *
 *   node --experimental-strip-types scripts/test-captions.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import { groupWordsIntoLines, captionLinesToOverlays, wordsToCaptionOverlays } from "../lib/captions.ts";
import { keepRangesToClips } from "../lib/editModel.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

/** Words of 300ms starting at t, spaced `step` apart. */
function words(texts, t0 = 0, step = 350) {
  return texts.map((text, i) => ({ text, startMs: t0 + i * step, endMs: t0 + i * step + 300 }));
}
const URI = "file:///a.mov";

eq("no words", groupWordsIntoLines([]), []);
eq("blank words ignored", groupWordsIntoLines([{ text: " ", startMs: 0, endMs: 100 }]), []);

const five = groupWordsIntoLines(words(["one", "two", "three", "four", "five"]));
eq("5 close words: one line", five.map((l) => l.text), ["one two three four five"]);
eq("line times", [five[0].startMs, five[0].endMs], [0, 4 * 350 + 300]);

eq(
  "max 6 words per line",
  groupWordsIntoLines(words(["a", "b", "c", "d", "e", "f", "g", "h"], 0, 250)).map((l) => l.text),
  ["a b c d e f", "g h"],
);

const paused = [...words(["hello", "there"]), ...words(["general", "kenobi"], 1500)];
eq("pause over 0.4s breaks", groupWordsIntoLines(paused).map((l) => l.text), ["hello there", "general kenobi"]);

const exactGap = [{ text: "a", startMs: 0, endMs: 300 }, { text: "b", startMs: 700, endMs: 1000 }];
eq("gap of exactly 0.4s does not break", groupWordsIntoLines(exactGap).length, 1);

eq(
  "max 2.5s per line",
  groupWordsIntoLines(words(["a", "b", "c", "d", "e", "f"], 0, 600)).map((l) => l.text),
  ["a b c d", "e f"],
);

// Output timeline
const w = words(["one", "two", "three", "four"], 0, 1000); // 0-300, 1000-1300, 2000-2300, 3000-3300
const noCuts = keepRangesToClips(URI, [{ startMs: 0, endMs: 5000 }]);
eq("0 cuts: times unchanged", wordsToCaptionOverlays(w, noCuts, URI, { pauseMs: 5000, maxLineMs: 10000 }).map((o) => [o.kind, o.text, o.startMs, o.endMs]), [["caption", "one two three four", 0, 3300]]);

const cut = keepRangesToClips(URI, [{ startMs: 0, endMs: 1500 }, { startMs: 2500, endMs: 5000 }]);
const mapped = wordsToCaptionOverlays(w, cut, URI, { pauseMs: 5000, maxLineMs: 10000 });
eq("1 cut: later words shift earlier", mapped.map((o) => [o.text, o.startMs, o.endMs]), [["one two four", 0, 2300]]);

const insideCut = keepRangesToClips(URI, [{ startMs: 0, endMs: 900 }, { startMs: 3500, endMs: 5000 }]);
eq("words inside a cut are dropped", wordsToCaptionOverlays(w, insideCut, URI), [{ kind: "caption", text: "one", startMs: 0, endMs: 300 }]);

const allCut = keepRangesToClips(URI, [{ startMs: 4000, endMs: 5000 }]);
eq("line fully inside a cut is dropped", wordsToCaptionOverlays(w, allCut, URI), []);

eq(
  "word ending at a clip's end keeps its end",
  captionLinesToOverlays([{ text: "x", startMs: 700, endMs: 1500, words: [{ text: "x", startMs: 700, endMs: 1500 }] }], cut, URI)[0].endMs,
  1500,
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
