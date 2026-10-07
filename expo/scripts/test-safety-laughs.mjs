#!/usr/bin/env node
/**
 * Um safety (never cut over a word dedupe removed; multi-pulse or long word-adjacent sounds are not ums)
 * and laughs of any length (a multi-second laugh outside the words is detected and protected).
 *
 *   node --experimental-strip-types scripts/test-safety-laughs.mjs
 */
import { analyzeUnexplained, blockUmsOverlapping, nonWordStretchReport } from "../lib/autoEdit/classifySound.ts";
import { analyzeAdjacent, findStretchesOutsideWords } from "../lib/autoEdit/adjacentSounds.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { effectiveCutRanges, protectedRangesOf } from "../lib/autoEdit/decisions.ts";
import { planLaughProtection } from "../lib/autoEdit/laughProtection.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";
import { keepRangesToClips } from "../lib/editModel.ts";
import { SENSITIVITY_PRESETS } from "../lib/silenceDetection.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const URI = "file:///a.mov";
const WIN = 20;
const SPEECH = -28;
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
function windowsOf(totalMs, stretches) {
  const out = new Array(totalMs / WIN).fill(-80);
  for (const [from, to, db] of stretches) for (let i = from / WIN; i < to / WIN; i++) out[i] = typeof db === "function" ? db(i - from / WIN) : db;
  return out;
}
const build = (windows, total, words, removedWords) => buildAiEditState({ uri: URI, durationMs: total, windows, silenceOptions: SENSITIVITY_PRESETS.tight, words, removedWords });
const umCuts = (state) => state.decisions.filter((d) => d.type === "umCut" && d.state === "applied");

// 10 words, 440 ms each, 1700 ms apart (word i: 1000 + i*1700): room for sounds in the gaps
const ten = Array.from({ length: 10 }, (_, i) => w(`w${i}`, 1000 + i * 1700, 1440 + i * 1700));
const tenStretches = ten.map((x) => [x.startMs, x.endMs, SPEECH]);
const TOTAL = 19000;
const GAP = [ten[3].endMs + 200, ten[3].endMs + 500]; // 6740..7040 (a voiced sound between two words)

// ── A2: never cut over a word dedupe removed ──
{
  const windows = windowsOf(TOTAL, [...tenStretches, [...GAP, SPEECH - 2]]);
  eq("control: that sound is an um and is cut", [analyzeUnexplained(windows, WIN, TOTAL, ten)[0].cls, umCuts(build(windows, TOTAL, ten)).length], ["um", 1]);
  const removed = [w("know", GAP[0] - 50, GAP[1] + 50)];
  const blocked = analyzeUnexplained(windows, WIN, TOTAL, ten, undefined, removed);
  eq("over a word dedupe removed it is not an um", [blocked[0].cls, blocked[0].blocked], ["unsure", "overlaps removed word 'know'"]);
  eq("...and nothing is cut there", umCuts(build(windows, TOTAL, ten, removed)).length, 0);
  eq("a removed word elsewhere changes nothing", umCuts(build(windows, TOTAL, ten, [w("x", 15000, 15400)])).length, 1);
  const lines = formatAiDebug({ sourceDurationMs: TOTAL, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: TOTAL }]), sourceUri: URI, proposals: [], candidates: blocked, hookTrims: [], fillers: [] });
  eq("debug: the candidate says why it is not cut", lines.includes("[not cut: overlaps removed word 'know']"), true);
  eq("blockUmsOverlapping leaves laughs alone", blockUmsOverlapping([{ ...blocked[0], cls: "laugh" }], removed)[0].cls, "laugh");
}

// ── A2: word-adjacent sounds: one pulse and at most 900 ms ──
{
  const LE = ten[3].endMs; // 6740? (word 3 ends at 1000+3*1700+440 = 6540)
  const twoPulses = (i) => (i < 8 ? SPEECH - 2 : i < 13 ? -55 : SPEECH - 2); // two pulses of 160 ms and 220 ms, 100 ms apart
  const windows = windowsOf(TOTAL, [...tenStretches, [LE, LE + 560, twoPulses]]);
  const found = analyzeUnexplained(windows, WIN, TOTAL, ten);
  const adj = found.filter((s) => s.adjacent);
  eq("a two-pulse sound running on from a word is not an um", [adj.length, adj[0]?.cls, adj[0]?.features.burstCount, adj[0]?.blocked], [1, "unsure", 2, "2 pulses (limit 1)"]);
  eq("...and nothing is cut", umCuts(build(windows, TOTAL, ten)).length, 0);
  const longTail = windowsOf(TOTAL, [...tenStretches, [LE, LE + 1200, SPEECH - 2]]);
  const lt = analyzeAdjacent(longTail, WIN, ten, -72, SPEECH);
  eq("an adjacent sound over 900 ms is not a candidate (too long)", [lt.candidates.length, lt.findings.find((f) => f.text === "w3" && f.kind === "tail")?.status], [0, "too long"]);
  const single = windowsOf(TOTAL, [...tenStretches, [LE, LE + 560, SPEECH - 2]]);
  eq("a single-pulse 480 ms tail is still an um and is cut", [analyzeUnexplained(single, WIN, TOTAL, ten).filter((s) => s.adjacent).map((s) => s.cls), umCuts(build(single, TOTAL, ten)).length], [["um"], 1]);
}

// ── B: a multi-second laugh outside the words ──
{
  // 7 words, a 600 ms pause, a 3 s pulsed laugh (200 ms period), a 600 ms pause, 7 more words
  const before = Array.from({ length: 7 }, (_, i) => w(`a${i}`, 500 + i * 640, 940 + i * 640));
  const LS = before[6].endMs + 600;
  const LE = LS + 3000;
  const after = Array.from({ length: 7 }, (_, i) => w(`b${i}`, LE + 600 + i * 640, LE + 1040 + i * 640));
  const words = [...before, ...after];
  const total = Math.ceil((after[6].endMs + 1500) / 1000) * 1000;
  const pulses = (i) => (i % 10 < 5 ? -22 : -50);
  const windows = windowsOf(total, [...words.map((x) => [x.startMs, x.endMs, SPEECH]), [LS, LE, pulses]]);

  const sounds = analyzeUnexplained(windows, WIN, total, words);
  const laughs = sounds.filter((s) => s.cls === "laugh");
  eq("the 3 s laugh is detected (it is longer than the 1500 ms candidate limit)", [laughs.length, laughs[0]?.startMs, laughs[0]?.endMs], [1, LS, LE]);
  eq("...with its pulses counted locally (15 of them)", laughs[0].features.burstCount, 15);
  const decisions = planLaughProtection(sounds);
  eq("it becomes one protected episode, padded by 150 ms", decisions.map((d) => [d.type, d.sourceStartMs, d.sourceEndMs]), [["laughProtect", LS - 150, LE + 150]]);
  const state = build(windows, total, words);
  eq("buildAiEditState protects exactly one range", protectedRangesOf(state).length, 1);
  eq("no cut of any kind lies inside the protected laugh", effectiveCutRanges(state).every((r) => r.endMs <= LS - 150 || r.startMs >= LE + 150), true);
  eq("...while cuts are made elsewhere (the pauses next to it)", effectiveCutRanges(state).length > 0, true);
  eq("with the old 1500 ms limit it would have been missed: no regular candidate covers it", sounds.filter((s) => s.cls !== "laugh").length, 0);

  const report = nonWordStretchReport(windows, WIN, total, words);
  eq("debug report: one non-word stretch over 1 s, with burst count and verdict", report.map((r) => [r.startMs, r.lengthMs, r.burstCount, r.verdict]), [[LS, 3000, 15, "laugh"]]);
  const text = formatAiDebug({ sourceDurationMs: total, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: total }]), sourceUri: URI, proposals: [], candidates: sounds, hookTrims: [], fillers: [], stretches: report });
  eq("debug text lists it", [text.includes("Non-word sound stretches over 1 s: 1"), /3000 ms  bursts 15  peak vs speech [+-]\d+\.\d dB  laugh/.test(text)], [true, true]);

  // a steady (unpulsed) 3 s sound is not a laugh
  const hum = windowsOf(total, [...words.map((x) => [x.startMs, x.endMs, SPEECH]), [LS, LE, SPEECH - 3]]);
  eq("a steady 3 s sound is not a laugh and creates no candidate", [analyzeUnexplained(hum, WIN, total, words).length, nonWordStretchReport(hum, WIN, total, words)[0].verdict, nonWordStretchReport(hum, WIN, total, words)[0].burstCount], [0, "not a laugh", 1]);

  // a laugh that runs straight on from a word
  const tail = windowsOf(total, [...words.map((x) => [x.startMs, x.endMs, SPEECH]), [before[6].endMs, before[6].endMs + 3200, pulses]]);
  const tl = analyzeUnexplained(tail, WIN, total, words).filter((s) => s.cls === "laugh");
  eq("a long laugh running on from a word is detected too (minus the 80 ms margin)", [tl.length, tl[0]?.startMs], [1, before[6].endMs + 80]);
  eq("findStretchesOutsideWords: the stretch starts after the word margin", findStretchesOutsideWords(tail, WIN, words, -72)[0].startMs, before[6].endMs + 80);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
