#!/usr/bin/env node
/**
 * Tests the um / laugh classifier for method-2 filler candidates:
 *
 *   node --experimental-strip-types scripts/test-classify-sound.mjs
 */
import {
  analyzeUnexplained, classifySound, classifySounds, formatFeatures, planUmCuts, SOUND_CLASSIFIER_CONFIG,
} from "../lib/autoEdit/classifySound.ts";
import { keepRangesOf, mergePlan, newEditState, restoreRange, setDecisionState } from "../lib/autoEdit/decisions.ts";
import { describeDecision, buildDebugMarkers } from "../lib/autoEdit/markers.ts";
import { planEmphasis } from "../lib/autoEdit/emphasisMoments.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";
import { keepRangesToClips } from "../lib/editModel.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const URI = "file:///a.mov";
const WIN = 20;
const w = (text, startMs, endMs) => ({ text, startMs, endMs });

/** Loudness windows of `totalMs`: quiet (-80) except the given [fromMs, toMs, dB] stretches. */
function windowsOf(totalMs, stretches) {
  const out = new Array(totalMs / WIN).fill(-80);
  for (const [from, to, db] of stretches) for (let i = from / WIN; i < to / WIN; i++) out[i] = typeof db === "function" ? db(i - from / WIN) : db;
  return out;
}
const SPEECH = -28;
const speechWords = [w("a", 0, 1000), w("b", 1600, 2600), w("c", 3300, 4300), w("d", 5000, 6000), w("e", 6700, 7700), w("f", 8400, 9400)];
const speechStretches = speechWords.map((x) => [x.startMs, x.endMs, SPEECH]);
const cand = (startMs, endMs) => ({ startMs, endMs, lengthMs: endMs - startMs });
const ctxOf = (windows, words = speechWords) => ({ windows, windowMs: WIN, words });
const classOf = (windows, c, words) => classifySound(c, ctxOf(windows, words), []).cls;

// ── config ──
eq("every threshold lives in one exported config", Object.keys(SOUND_CLASSIFIER_CONFIG).sort(), [
  "burstMinGapMs", "burstMinPulseMs", "burstThresholdFraction", "laughMinBursts", "laughPeakAboveSpeechDb",
  "midSpeechOverlapSlackMs", "midSpeechWindowMs", "nearEmphasisMs", "umMaxCv", "umMaxMs", "umMaxPeakAboveSpeechDb",
  "umMinMs", "umRequiresMidSpeech",
]);

// ── um: flat, short, mid-speech ──
{
  const um = cand(1160, 1460);
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -31]]);
  const r = classifySound(um, ctxOf(windows), []);
  eq("synthetic um -> um", r.cls, "um");
  eq("um features", [r.features.durationMs, Math.round(r.features.peakVsSpeechDb * 10) / 10, Math.round(r.features.steadiness * 1000) / 1000, r.features.burstCount, r.features.nearEmphasis, r.features.midSpeech], [300, -3, 0, 1, false, true]);
  const far = classifySound(cand(10000, 10300), ctxOf(windowsOf(12000, [...speechStretches, [10000, 10300, -31]])), []);
  eq("a um away from speech is still a um (mid-speech is only a feature)", [far.cls, far.features.midSpeech], ["um", false]);
  const strict = classifySound(cand(10000, 10300), ctxOf(windowsOf(12000, [...speechStretches, [10000, 10300, -31]])), [], { ...SOUND_CLASSIFIER_CONFIG, umRequiresMidSpeech: true });
  eq("...unless the config requires it", strict.cls, "unsure");
}

// ── laugh: pulses ──
{
  // 4 pulses: 100 ms at -30 (not louder than speech), 60 ms dips at -45 (above the silence threshold)
  const pulse = (i) => (i % 8 < 5 ? -30 : -45);
  const words = [w("a", 0, 1000), w("b", 1900, 2900)];
  const windows = windowsOf(12000, [[0, 1000, SPEECH], [1900, 2900, SPEECH], [1160, 1740, pulse]]);
  const r = classifySound(cand(1160, 1740), ctxOf(windows, words), []);
  eq("3+ pulses -> laugh, even when not louder than speech", [r.cls, r.features.burstCount >= 3, r.features.peakVsSpeechDb < 3], ["laugh", true, true]);
  eq("the reason names the pulses", r.why[0].endsWith("pulses"), true);
}
// ── laugh: one loud burst ──
{
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -20]]);
  const r = classifySound(cand(1160, 1460), ctxOf(windows), []);
  eq("a loud single burst -> laugh", [r.cls, r.features.burstCount, r.features.peakVsSpeechDb > 3], ["laugh", 1, true]);
  eq("...because it is louder than speech", r.why, ["louder than speech"]);
}
// ── laugh: next to a loudness jump ──
{
  const words = [w("a", 0, 3000), w("b", 3900, 5000)];
  const stretches = [[0, 3000, SPEECH], [3900, 5000, SPEECH], [3200, 3500, -31]];
  const quiet = windowsOf(8000, stretches);
  eq("without a jump the same sound is a um", classifySounds([cand(3200, 3500)], ctxOf(quiet, words))[0].cls, "um");
  const jumpy = windowsOf(8000, [...stretches, [4000, 4300, -15]]);
  const r = classifySounds([cand(3200, 3500)], ctxOf(jumpy, words))[0];
  eq("a loudness-jump emphasis moment within 1 s -> laugh", [r.cls, r.features.nearEmphasis], ["laugh", true]);
}

// ── unsure ──
{
  const flatLoud = windowsOf(12000, [...speechStretches, [1160, 1460, -26]]);
  const a = classifySound(cand(1160, 1460), ctxOf(flatLoud), []);
  eq("borderline: a little louder than speech (+2 dB) -> unsure", [a.cls, Math.round(a.features.peakVsSpeechDb)], ["unsure", 2]);
  const ramp = windowsOf(12000, [...speechStretches, [1160, 1460, (i) => -45 + i]]);
  const b = classifySound(cand(1160, 1460), ctxOf(ramp), []);
  eq("borderline: not steady, not pulsed, not loud -> unsure", [b.cls, b.features.steadiness > SOUND_CLASSIFIER_CONFIG.umMaxCv, b.features.burstCount], ["unsure", true, 1]);
  const tooShort = classifySound(cand(1160, 1250), ctxOf(windowsOf(12000, [...speechStretches, [1160, 1250, -31]])), []);
  eq("shorter than 150 ms is not a um", tooShort.cls, "unsure");
}

// ── apply: only ums are cut ──
{
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -31], [2800, 3100, -20], [4560, 4860, -26]]);
  const sounds = analyzeUnexplained(windows, WIN, 12000, speechWords);
  eq("end to end: one um, one laugh, one unsure", sounds.map((s) => [s.startMs, s.cls]), [[1160, "um"], [2800, "laugh"], [4560, "unsure"]]);
  const cuts = planUmCuts(sounds);
  eq("only the um becomes a cut decision", cuts.map((d) => [d.type, d.sourceStartMs, d.sourceEndMs, d.state, d.origin]), [["fillerCut", 1160, 1460, "applied", "ai"]]);
  eq("laughs and unsure sounds never produce cut decisions", planUmCuts(sounds.filter((s) => s.cls !== "um")), []);
  const state = buildAiEditState({ uri: URI, durationMs: 12000, windows, words: speechWords });
  const covers = (range) => state.decisions.filter((d) => d.state === "applied" && d.sourceStartMs < range[1] && d.sourceEndMs > range[0]);
  eq("the ai edit cuts the um", covers([1160, 1460]).map((d) => [d.type, d.payload.method]), [["fillerCut", 2]]);
  eq("the ai edit leaves the laugh alone", covers([2800, 3100]), []);
  eq("the ai edit leaves the unsure sound alone", covers([4560, 4860]), []);
  const keep = keepRangesOf(state, 12000);
  eq("the laugh footage is kept", keep.some((k) => k.startMs <= 2800 && k.endMs >= 3100), true);
  eq("the um footage is cut", keep.some((k) => k.startMs < 1460 && k.endMs > 1160), false);
  // reversible, user wins, Restore works
  const umId = cuts[0].id;
  const reverted = setDecisionState(state, umId, "reverted");
  eq("a reverted um stays reverted when the plan runs again", mergePlan(reverted, cuts, ["hookTrim", "fillerCut"]).resolved[0].state, "reverted");
  eq("Restore reverts a um cut", restoreRange(state, 1200, 1300).decisions.find((d) => d.id === umId).state, "reverted");
  eq("the um is a Fillers decision", state.decisions.find((d) => d.id === umId).type, "fillerCut");
  // laughs feed zooms
  const zooms = planEmphasis({ windows, windowMs: WIN, words: speechWords, durationMs: 12000, laughs: sounds.filter((s) => s.cls === "laugh") });
  const laugh = zooms.find((z) => z.payload.reasons.includes("laugh"));
  eq("a laugh is an emphasis moment with a strong score", [!!laugh, laugh.sourceStartMs, laugh.payload.score >= 2, laugh.state], [true, 2800, true, "reverted"]);
  eq("without laughs there is no laugh reason", planEmphasis({ windows, windowMs: WIN, words: speechWords, durationMs: 12000 }).some((z) => z.payload.reasons.includes("laugh")), false);

  // markers
  eq("a method-2 um cut is labeled Filler (um)", describeDecision(cuts[0]).label, "Filler (um)");
  eq("a method-1 filler keeps its label", describeDecision({ ...cuts[0], payload: { text: "uh" } }).label, "Filler 'uh'");
  eq("the um cut marker carries its class and features", describeDecision(cuts[0]).sound.cls, "um");
  const clips = keepRangesToClips(URI, [{ startMs: 0, endMs: 12000 }]);
  const markers = buildDebugMarkers([], sounds, clips, URI);
  eq("debug markers: laugh orange kind, unsure green kind, um is a normal cut marker instead", markers.map((m) => [m.kind, m.outputMs, m.detail.cls]), [["laugh", 2800, "laugh"], ["filler2", 4560, "unsure"]]);
  eq("tapping shows the features", markers[0].detail.features.durationMs, 300);

  // debug text
  const text = formatAiDebug({ sourceDurationMs: 12000, clips, sourceUri: URI, proposals: [], candidates: sounds, hookTrims: [], fillers: [], ums: cuts });
  eq("debug text lists every candidate with class and features", text.split("\n").filter((l) => /^\d:\d\d\.\d  (um|laugh|unsure)/.test(l)), [
    `0:01.2  um  ${formatFeatures(sounds[0].features)}`,
    `0:02.8  laugh  ${formatFeatures(sounds[1].features)}`,
    `0:04.6  unsure  ${formatFeatures(sounds[2].features)}`,
  ]);
  eq("debug text counts the classes and lists the applied ums", [text.includes("method 2: 3 (um 1, laugh 1, unsure 1)"), text.includes("Um cuts, method 2 (applied): 1"), text.includes("um  source 0:01.2-0:01.5")], [true, true, true]);
  eq("features format", formatFeatures({ durationMs: 300, peakVsSpeechDb: -2.14, steadiness: 0.1849, burstCount: 1, nearEmphasis: false, midSpeech: true }), "300 ms  peak vs speech -2.1 dB  steadiness 0.18  bursts 1  near emphasis no  mid-speech yes");
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
