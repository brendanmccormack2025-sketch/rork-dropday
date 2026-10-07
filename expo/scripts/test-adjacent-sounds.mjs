#!/usr/bin/env node
/**
 * Sounds that run straight on from a word (an um tail or head): candidates, cuts, debug.
 *
 *   node --experimental-strip-types scripts/test-adjacent-sounds.mjs
 */
import { analyzeUnexplained } from "../lib/autoEdit/classifySound.ts";
import { ADJACENT_SOUND_CONFIG, analyzeAdjacent } from "../lib/autoEdit/adjacentSounds.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { keepRangesOf, newEditState, setCategoryEnabled, setDecisionState } from "../lib/autoEdit/decisions.ts";
import { planUmCuts } from "../lib/autoEdit/umCuts.ts";
import { silenceThresholdDb, speechMedianDb } from "../lib/autoEdit/classifySound.ts";
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
  for (const [from, to, db] of stretches) for (let i = from / WIN; i < to / WIN; i++) out[i] = db;
  return out;
}
const C = ADJACENT_SOUND_CONFIG;
eq("config values", [C.tailMarginMs, C.headMarginMs, C.minPieceMs, C.maxPieceMs, C.minPeakVsSpeechDb, C.maxPeakVsSpeechDb, C.neighbourGapMs, C.reportPauseMs], [80, 80, 150, 1500, -12, 6, 250, 300]);

// 13 normal 440 ms words (640 ms apart), starting at 500; the interesting word comes after them.
const TEXTS = ["hello", "there", "world", "about", "think", "right", "which", "other", "might", "could", "state", "again", "never"];
let t = 500;
const lead = TEXTS.map((text) => { const x = w(text, t, t + 440); t += 640; return x; });
const LS = t + 200; // "lease" starts 200 ms after "never" ends + 200 gap = t is lead end + 200
const LE = LS + 440;
const clip = ({ tail, pause = 7300, extra = [] }) => {
  const next = LE + pause;
  const after = [w("crazy", next, next + 440), w("really", next + 640, next + 1180), w("works", next + 1380, next + 1820)];
  const words = [...lead, w("lease", LS, LE), ...after];
  const total = Math.ceil((next + 2400) / 1000) * 1000;
  const windows = windowsOf(total, [...[...lead, w("lease", LS, LE), ...after].map((x) => [x.startMs, x.endMs, SPEECH]), ...(tail ? [tail] : []), ...extra]);
  return { words, windows, total, next };
};

// ── word + continuous um tail + long pause ──
{
  const c = clip({ tail: [LE, LE + 560, SPEECH - 2] });
  const found = analyzeUnexplained(c.windows, WIN, c.total, c.words);
  eq("the tail after the word end plus the 80 ms margin is a method-2 candidate", found.map((s) => [s.startMs, s.endMs, s.adjacent]), [[LE + 80, LE + 560, "after 'lease'"]]);
  eq("...classified um by the normal rule (near speech, 480 ms, -2 dB)", [found[0].cls, found[0].checks.nearSpeech, found[0].checks.duration, found[0].checks.loudness], ["um", true, true, true]);
  const state = buildAiEditState({ uri: URI, durationMs: c.total, windows: c.windows, silenceOptions: SENSITIVITY_PRESETS.tight, words: c.words });
  const cut = state.decisions.find((d) => d.type === "umCut");
  eq("an applied umCut covers the tail, starting after the margin and the 30 ms padding", [cut?.state, cut?.sourceStartMs >= LE + 80 + 30, cut?.sourceStartMs <= LE + 80 + 30 + 20], ["applied", true, true]);
  const keep = keepRangesOf(state, c.total);
  eq("the word is intact, including its last 80 ms", keep.some((k) => k.startMs <= LS && k.endMs >= LE + 80), true);
  eq("the tail itself is gone", keep.some((k) => k.startMs < LE + 500 && k.endMs > LE + 200), false);
  eq("reversible: reverting the cut keeps the tail", keepRangesOf(setDecisionState(state, cut.id, "reverted"), c.total).some((k) => k.startMs <= LE + 200 && k.endMs >= LE + 500), true);
  eq("the Ums switch turns it off", keepRangesOf(setCategoryEnabled(state, "umCut", false), c.total).some((k) => k.startMs <= LE + 200 && k.endMs >= LE + 500), true);
}

// ── connected speech: the next word follows within 250 ms ──
{
  const c = clip({ tail: [LE, LE + 200, SPEECH - 2], pause: 200 });
  eq("a word followed directly by another word is untouched", analyzeUnexplained(c.windows, WIN, c.total, c.words).length, 0);
  const c2 = clip({ tail: [LE, LE + 240, SPEECH - 2], pause: 240 });
  eq("...also at 240 ms (within 250)", analyzeUnexplained(c2.windows, WIN, c2.total, c2.words).length, 0);
}

// ── a short trailing sibilant ──
{
  const c = clip({ tail: [LE, LE + 220, SPEECH - 4] });
  const s = speechOf(c);
  const r = analyzeAdjacent(c.windows, WIN, c.words, s.thr, s.speech);
  eq("a 220 ms trailing sound leaves 140 ms after the margin: untouched", [r.candidates.length, r.findings.find((f) => f.text === "lease" && f.kind === "tail").status, Math.round(r.findings.find((f) => f.text === "lease" && f.kind === "tail").lengthMs)], [0, "too short", 140]);
}
function speechOf(c) {
  const thr = silenceThresholdDb(c.windows, WIN, c.total);
  return { thr, speech: speechMedianDb({ windows: c.windows, windowMs: WIN, words: c.words, thresholdDb: thr }) };
}

// ── a quiet breath tail ──
{
  const c = clip({ tail: [LE, LE + 560, SPEECH - 20] });
  const s = speechOf(c);
  const r = analyzeAdjacent(c.windows, WIN, c.words, s.thr, s.speech);
  const f = r.findings.find((x) => x.text === "lease" && x.kind === "tail");
  eq("a breath tail at -20 dB is too quiet: untouched", [r.candidates.length, f.status, Math.round(f.dbVsSpeech)], [0, "too quiet", -20]);
  eq("no um cut is applied for it", buildAiEditState({ uri: URI, durationMs: c.total, windows: c.windows, silenceOptions: SENSITIVITY_PRESETS.tight, words: c.words }).decisions.some((d) => d.type === "umCut"), false);
  const loud = clip({ tail: [LE, LE + 560, SPEECH + 9] });
  const sl = speechOf(loud);
  eq("a tail over +6 dB is too loud", analyzeAdjacent(loud.windows, WIN, loud.words, sl.thr, sl.speech).findings.find((x) => x.text === "lease" && x.kind === "tail").status, "too loud");
}

// ── a head: an um running straight into the next word, after a long pause ──
{
  const S = LS + 4000; // pause of 4 s after the lead words
  const words = [...lead, w("lease", S, S + 440), w("it's", S + 640, S + 1080), w("crazy", S + 1280, S + 1720), w("really", S + 1920, S + 2460)];
  const total = Math.ceil((S + 3200) / 1000) * 1000;
  const windows = windowsOf(total, [...words.map((x) => [x.startMs, x.endMs, SPEECH]), [S - 500, S, SPEECH - 2]]);
  const found = analyzeUnexplained(windows, WIN, total, words);
  eq("an um running on into the word is a candidate up to 80 ms before the word", found.map((s) => [s.startMs, s.endMs, s.adjacent, s.cls]), [[S - 500, S - 80, "before 'lease'", "um"]]);
  const bridge = [...lead, w("lease", S, S + 440), w("it's", S + 1000, S + 1440), w("crazy", S + 1640, S + 2080), w("really", S + 2280, S + 2820)];
  const btotal = Math.ceil((S + 3600) / 1000) * 1000;
  const bw = windowsOf(btotal, [...bridge.map((x) => [x.startMs, x.endMs, SPEECH]), [S + 440, S + 1000, SPEECH - 2]]);
  eq("an um filling a 560 ms gap between two words is ONE candidate (not one per word)", analyzeUnexplained(bw, WIN, btotal, bridge).filter((s) => s.adjacent).length, 1);
}

// ── debug text ──
{
  const c = clip({ tail: [LE, LE + 560, SPEECH - 2] });
  const s = speechOf(c);
  const r = analyzeAdjacent(c.windows, WIN, c.words, s.thr, s.speech);
  const sounds = analyzeUnexplained(c.windows, WIN, c.total, c.words);
  const um = planUmCuts(newEditState(URI, []), sounds, c.total).report;
  const text = formatAiDebug({ sourceDurationMs: c.total, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: c.total }]), sourceUri: URI, proposals: [], candidates: sounds, hookTrims: [], fillers: [], umReport: um, adjacent: r.findings });
  eq("debug: the spot after 'lease' says tail, length, level and that it was cut", /after 'lease' \(source 0:\d\d\.\d-0:\d\d\.\d, pause 7300 ms\): tail 480 ms at -2 dB -> um candidate \(cut\)/.test(text), true);
  eq("debug: the candidate line carries the adjacent tag", text.includes("[adjacent: after 'lease']"), true);
  eq("debug: a word with a pause and nothing after it says no tail", /after 'works' .*no tail|after 'again'.*no tail|no tail/.test(text), true);
  eq("debug: the profile after the word is listed", /profile \(50 ms, dB vs speech\): \d+\.\d\d:-?\d/.test(text), true);
  const sib = clip({ tail: [LE, LE + 220, SPEECH - 4] });
  const ss = speechOf(sib);
  const sibText = formatAiDebug({ sourceDurationMs: sib.total, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: sib.total }]), sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], adjacent: analyzeAdjacent(sib.windows, WIN, sib.words, ss.thr, ss.speech).findings });
  eq("debug: a short tail says too short with its length", sibText.includes("after 'lease'") && sibText.includes("tail too short (140 ms)"), true);
  const breath = clip({ tail: [LE, LE + 560, SPEECH - 20] });
  const bs = speechOf(breath);
  const breathText = formatAiDebug({ sourceDurationMs: breath.total, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: breath.total }]), sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], adjacent: analyzeAdjacent(breath.windows, WIN, breath.words, bs.thr, bs.speech).findings });
  eq("debug: a quiet tail says too quiet with its level", breathText.includes("too quiet (-20 dB)"), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
