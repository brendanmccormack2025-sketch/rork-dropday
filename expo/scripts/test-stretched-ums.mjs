#!/usr/bin/env node
/**
 * Ums the recognizer absorbed into a stretched word: planner, cuts, debug text.
 *
 *   node --experimental-strip-types scripts/test-stretched-ums.mjs
 */
import { planStretchedUms, STRETCHED_UM_CONFIG } from "../lib/autoEdit/stretchedUms.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { keepRangesOf, effectiveCutRanges, setCategoryEnabled, setDecisionState } from "../lib/autoEdit/decisions.ts";
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

// 13 normally timed 5-letter words (440 ms = 88 ms per character, 200 ms apart; all times are multiples of 20 ms), then "lease" 800 ms,
// a 900 ms pause, and three more words.
const TEXTS = ["hello", "there", "world", "about", "think", "right", "which", "other", "might", "could", "state", "again", "never"];
let t = 500;
const lead = TEXTS.map((text) => { const x = w(text, t, t + 440); t += 640; return x; });
const LEASE_START = t; // 8820
const LEASE_END = LEASE_START + 800; // 9750
const NEXT = LEASE_END + 900;
const tail = [w("crazy", NEXT, NEXT + 440), w("really", NEXT + 640, NEXT + 1180), w("works", NEXT + 1380, NEXT + 1820)];
const TOTAL = Math.ceil((NEXT + 2400) / 1000) * 1000;
const words = [...lead, w("lease", LEASE_START, LEASE_END), ...tail];
const wordStretches = (list) => list.map((x) => [x.startMs, x.endMs, SPEECH]);

/** "lease" with an um tail: body, a dip, then 270 ms of voiced sound that runs on into the gap. */
const lease = {
  body: [LEASE_START, LEASE_START + 440, SPEECH],
  dip: [LEASE_START + 440, LEASE_START + 520, -42],
  um: [LEASE_START + 520, LEASE_END, -30],
  gapSound: [LEASE_END, LEASE_END + 200, -33],
};
const withLease = (...parts) => windowsOf(TOTAL, [...wordStretches([...lead, ...tail]), ...parts]);


eq("config values", [STRETCHED_UM_CONFIG.stretchFactor, STRETCHED_UM_CONFIG.pauseMs, STRETCHED_UM_CONFIG.dipDb, STRETCHED_UM_CONFIG.dipMinMs, STRETCHED_UM_CONFIG.voicedMinMs, STRETCHED_UM_CONFIG.voicedMinDb, STRETCHED_UM_CONFIG.voicedMaxDb, STRETCHED_UM_CONFIG.maxWordCutShare], [1.5, 300, 5, 40, 150, -12, 6, 0.5]);

// ── a stretched word with an um tail ──
{
  const windows = withLease(lease.body, lease.dip, lease.um, lease.gapSound);
  const r = planStretchedUms(windows, WIN, TOTAL, words);
  eq("the expected duration comes from the transcript (88 ms per character)", Math.round(r.report.expectedMsPerChar), 88);
  eq("exactly one stretched word is found: 'lease'", r.report.words.map((s) => s.text), ["lease"]);
  const s = r.report.words[0];
  eq("it lasts 800 ms against 440 expected (1.8x), with a pause after", [s.durationMs, Math.round(s.expectedMs), s.pauseAfterMs > 300], [800, 440, true]);
  eq("the dip is found at the end side", [s.dipFound, s.side, s.dip.startMs, s.dip.endMs], [true, "end", LEASE_START + 440, LEASE_START + 520]);
  eq("the absorbed um is the voiced tail plus the sound in the gap", [s.cut.startMs, s.cut.endMs], [LEASE_START + 520, LEASE_END + 200]);
  eq("...280 ms of it inside the word, 35% (under the 50% cap)", [s.cut.insideWordMs, Math.round((100 * s.cut.insideWordMs) / s.durationMs)], [280, 35]);
  eq("one um sound is returned for the cutter", r.sounds.map((x) => [x.cls, x.startMs, x.endMs]), [["um", LEASE_START + 520, LEASE_END + 200]]);

  const state = buildAiEditState({ uri: URI, durationMs: TOTAL, windows, silenceOptions: SENSITIVITY_PRESETS.tight, words });
  const cut = state.decisions.find((d) => d.type === "umCut");
  eq("an applied umCut covers the tail (with the edge padding)", [cut?.state, cut?.sourceStartMs, cut?.sourceEndMs > LEASE_END], ["applied", LEASE_START + 520 + 30, true]);
  const keep = keepRangesOf(state, TOTAL);
  eq("the word head is kept up to the dip", keep.some((k) => k.startMs <= LEASE_START && k.endMs >= LEASE_START + 540), true);
  eq("the um tail is not kept", keep.some((k) => k.startMs < LEASE_END && k.endMs > LEASE_START + 580), false);
  eq("the cut never removes more than 50% of the word", effectiveCutRanges(state, "umCut").map((c) => Math.max(0, Math.min(c.endMs, LEASE_END) - Math.max(c.startMs, LEASE_START)) <= 400).every(Boolean), true);
  eq("reversible: a reverted um cut keeps the whole tail", keepRangesOf(setDecisionState(state, cut.id, "reverted"), TOTAL).some((k) => k.startMs <= LEASE_START + 600 && k.endMs >= LEASE_END), true);
  eq("the Ums switch turns it off", keepRangesOf(setCategoryEnabled(state, "umCut", false), TOTAL).some((k) => k.startMs <= LEASE_START + 600 && k.endMs >= LEASE_END), true);

  const text = formatAiDebug({ sourceDurationMs: TOTAL, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: TOTAL }]), sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], stretched: r.report });
  eq("debug: stretched word, duration vs expected, dip, cut range", [
    text.includes("Stretched words: 1 (expected 88 ms per character)"),
    text.includes("'lease'") && text.includes("800 ms vs expected 440 ms (1.8x)"),
    text.includes("dip found: yes"),
    /cut range: source 0:09\.3-0:09\.8 \(480 ms, 280 ms inside the word = 35%\)/.test(text),
  ], [true, true, true, true]);
  eq("debug: the gap diagnosis says the sound is joined to the word", /sound .*joined to the word 'lease'/.test(text), true);
  eq("debug: the 50 ms profile is listed (dB vs speech)", /profile \(50 ms, dB vs speech\): \d+\.\d\d:-?\d/.test(text), true);
}

// ── a normally timed word is untouched ──
{
  // the same shape on a word of normal length: 5 letters, 450 ms, with a pause after it
  const normal = [...lead.slice(0, 12), w("never", lead[12].startMs, lead[12].startMs + 440), ...tail];
  const windows = windowsOf(TOTAL, [...wordStretches(normal.slice(0, 12)), [lead[12].startMs, lead[12].startMs + 240, SPEECH], [lead[12].startMs + 240, lead[12].startMs + 320, -42], [lead[12].startMs + 320, lead[12].startMs + 440, -30], ...wordStretches(tail)]);
  const r = planStretchedUms(windows, WIN, TOTAL, normal);
  eq("a normally timed word is not stretched, so nothing is planned", [r.report.words.length, r.sounds.length], [0, 0]);
}

// ── stretched but no dip ──
{
  const windows = withLease([LEASE_START, LEASE_END, SPEECH]);
  const r = planStretchedUms(windows, WIN, TOTAL, words);
  const s = r.report.words[0];
  eq("a stretched word without a dip is reported but untouched", [r.report.words.length, s.dipFound, r.sounds.length, s.cut], [1, false, 0, undefined]);
  eq("...with the reason", s.note, "no loudness dip with a voiced stretch next to it: nothing cut");
  const state = buildAiEditState({ uri: URI, durationMs: TOTAL, windows, silenceOptions: SENSITIVITY_PRESETS.tight, words });
  eq("no um cut is applied for it", state.decisions.filter((d) => d.type === "umCut").length, 0);
  eq("its gap diagnosis says the gap is silent", s.gapDiagnosis.some((l) => l.includes("no sound above the threshold")), true);
  // a dip but no voiced stretch after it (only quiet sound)
  const quiet = planStretchedUms(withLease([LEASE_START, LEASE_START + 440, SPEECH], [LEASE_START + 440, LEASE_START + 520, -42], [LEASE_START + 520, LEASE_END, -45]), WIN, TOTAL, words);
  eq("a dip followed only by quiet sound (a breath) is not an um", [quiet.report.words[0].dipFound, quiet.sounds.length], [false, 0]);
}

// ── the 50% cap ──
{
  // a dip 30% into the word: the um would be 70% of it
  const early = planStretchedUms(withLease([LEASE_START, LEASE_START + 240, SPEECH], [LEASE_START + 240, LEASE_START + 320, -42], [LEASE_START + 320, LEASE_END, -30]), WIN, TOTAL, words);
  eq("a dip in the first half of the word is not searched: nothing cut", [early.report.words[0].dipFound, early.sounds.length], [false, 0]);
  // a dip at 55% of the word: 45% inside the word is fine
  const late = planStretchedUms(withLease([LEASE_START, LEASE_START + 400, SPEECH], [LEASE_START + 400, LEASE_START + 460, -42], [LEASE_START + 460, LEASE_END, -30], lease.gapSound), WIN, TOTAL, words);
  eq("a dip at 50% of the word still allows the cut, which stays within 50%", [late.report.words[0].dipFound, late.report.words[0].cut.insideWordMs <= 400], [true, true]);
  const capped = planStretchedUms(withLease([LEASE_START, LEASE_START + 300, SPEECH], [LEASE_START + 300, LEASE_START + 360, -42], [LEASE_START + 360, LEASE_END, -30]), WIN, TOTAL, words, { ...STRETCHED_UM_CONFIG, maxWordCutShare: 0.7 });
  eq("with the cap config raised to 70% that same early dip is searched (the cap is config-driven)", capped.report.words[0].dipFound, true);
}

// ── the um at the START of a stretched word (pause before) ──
{
  const S = 6000;
  const before = [w("hello", 1000, 1440), w("there", 1640, 2080), w("world", 2280, 2720), w("about", 2920, 3360), w("think", 3560, 4000), w("right", 4200, 4640), w("which", 4840, 5280)];
  const after = [w("other", S + 1000, S + 1440), w("might", S + 1640, S + 2080), w("could", S + 2280, S + 2720), w("state", S + 2920, S + 3360)];
  const startWords = [...before, w("lease", S, S + 800), ...after];
  const total = 11000;
  const windows = windowsOf(total, [
    ...startWords.filter((x) => x.text !== "lease").map((x) => [x.startMs, x.endMs, SPEECH]),
    [S - 200, S, -33], [S, S + 280, -30], [S + 280, S + 360, -42], [S + 360, S + 800, SPEECH],
  ]);
  const r = planStretchedUms(windows, WIN, total, startWords);
  const s = r.report.words[0];
  eq("a stretched word after a pause: the um at its start is found", [s?.text, s?.side, s?.dipFound, s?.cut?.startMs, s?.cut?.endMs], ["lease", "start", true, S - 200, S + 280]);
}

// ── too few words ──
{
  const few = words.slice(0, 6);
  eq("fewer than 10 words: no estimate, nothing planned", (({ report, sounds }) => [report.expectedMsPerChar, sounds.length])(planStretchedUms(withLease(lease.body), WIN, TOTAL, few)), [null, 0]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
