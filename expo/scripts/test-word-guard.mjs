#!/usr/bin/env node
/**
 * Word guard: automatic pause cuts never clip a spoken word.
 *   node --experimental-strip-types --no-warnings scripts/test-word-guard.mjs
 */
import { makeDecision, newEditState, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { WORD_GUARD_MIN_CUT_MS, WORD_PAD_AFTER_MS, WORD_PAD_BEFORE_MS, cutPiecesAroundWords, guardSilenceCutsAgainstWords } from "../lib/autoEdit/wordGuard.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const r = (startMs, endMs) => ({ startMs, endMs });

eq("a cut between two words that already leaves room is unchanged", cutPiecesAroundWords(r(1200, 1800), [r(500, 1000), r(2000, 2400)]), [r(1200, 1800)]);
eq("a cut that starts inside a word's tail starts after the word + pad", cutPiecesAroundWords(r(1020, 1800), [r(500, 1050), r(2000, 2400)]), [r(1050 + WORD_PAD_AFTER_MS, 1800)]);
eq("a cut that ends inside the next word's start ends before it - pad", cutPiecesAroundWords(r(1200, 2050), [r(500, 1000), r(2000, 2400)]), [r(1200, 2000 - WORD_PAD_BEFORE_MS)]);
eq("a word inside a cut splits it: each side keeps its pause", cutPiecesAroundWords(r(1000, 3000), [r(1800, 2100)]), [r(1000, 1800 - WORD_PAD_BEFORE_MS), r(2100 + WORD_PAD_AFTER_MS, 3000)]);
eq("a piece shorter than the minimum is dropped", cutPiecesAroundWords(r(1000, 1300), [r(900, 1100)]), []);
eq("minimum cut length is 150 ms", WORD_GUARD_MIN_CUT_MS, 150);
eq("no words: unchanged", cutPiecesAroundWords(r(1000, 2000), []), [r(1000, 2000)]);

const base = newEditState("file:///a.mov", [
  makeDecision("silenceCut", 1020, 1800, { payload: { lengthMs: 780 } }),
  makeDecision("silenceCut", 3000, 4000, { payload: { lengthMs: 1000 } }),
  makeDecision("silenceCut", 5000, 5600, { origin: "user" }),
  makeDecision("umCut", 6000, 6300),
]);
const words = [r(500, 1050), r(2000, 2400), r(5100, 5300), r(6050, 6200)];
const g = guardSilenceCutsAgainstWords(base, words);
eq("only automatic silence cuts that touch a word change", [g.shortened, g.split, g.dropped], [1, 0, 0]);
eq("the shortened cut no longer reaches the word", g.state.decisions.filter((d) => d.type === "silenceCut" && d.origin === "ai").map((d) => [d.sourceStartMs, d.sourceEndMs]), [[1140, 1800], [3000, 4000]]);
eq("a cut the creator made by hand is never changed", g.state.decisions.some((d) => d.origin === "user" && d.sourceStartMs === 5000 && d.sourceEndMs === 5600), true);
eq("other kinds of cuts are left alone", g.state.decisions.some((d) => d.type === "umCut" && d.sourceStartMs === 6000), true);
eq("nothing touched: the very same state comes back", guardSilenceCutsAgainstWords(base, [r(2000, 2400)]).state === base, true);
eq("the guarded edit still renders (kept footage includes the whole word)", renderClipsOf(g.state, 8000).some((c) => c.trimStartMs <= 500 && c.trimEndMs >= 1050 + WORD_PAD_AFTER_MS), true);
eq("guarding twice changes nothing more", guardSilenceCutsAgainstWords(g.state, words).shortened + guardSilenceCutsAgainstWords(g.state, words).split, 0);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
