#!/usr/bin/env node
/**
 * Tests the um / laugh classifier for method-2 filler candidates:
 *
 *   node --experimental-strip-types scripts/test-classify-sound.mjs
 */
import {
  analyzeUnexplained, classifySound, classifySounds, formatFeatures, silenceThresholdDb, SOUND_CLASSIFIER_CONFIG,
  speechMedianDb,
} from "../lib/autoEdit/classifySound.ts";
import { checkAlignment } from "../lib/autoEdit/alignment.ts";
import { appliedCutRanges, keepRangesOf, makeDecision, mergePlan, newEditState, restoreRange, setCategoryEnabled, setDecisionState } from "../lib/autoEdit/decisions.ts";
import { planUmCuts } from "../lib/autoEdit/umCuts.ts";
import { buildCutMarkers, buildDebugMarkers, describeDecision } from "../lib/autoEdit/markers.ts";
import { loudnessJumpScorer, planEmphasis, scoreEmphasis } from "../lib/autoEdit/emphasisMoments.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";
import { keepRangesToClips } from "../lib/editModel.ts";
import { planSilenceCuts } from "../lib/autoEdit/silenceCuts.ts";
import { planFillerCuts } from "../lib/autoEdit/fillerCuts.ts";
import { SENSITIVITY_PRESETS, detectSilences } from "../lib/silenceDetection.ts";

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
eq("every threshold lives in one exported config", Object.keys(SOUND_CLASSIFIER_CONFIG).sort(), ["burstMinGapMs", "burstMinPulseMs", "burstThresholdFraction", "laughMinBursts", "laughPeakAboveSpeechDb", "laughPeakMinBursts", "midSpeechOverlapSlackMs", "midSpeechWindowMs", "minWordsForBaseline", "nearEmphasisMs", "umEdgePaddingMs", "umMaxCv", "umMaxMs", "umMaxPeakAboveSpeechDb", "umMergeGapMs", "umMinCutMs", "umMinKeepMs", "umMinMs", "umRequiresMidSpeech", "umSecondsPerNewSeam"]);

// ── um: flat, short, mid-speech ──
{
  const um = cand(1160, 1460);
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -31]]);
  const r = classifySound(um, ctxOf(windows), []);
  eq("synthetic um -> um", r.cls, "um");
eq("the um cut settings", [SOUND_CLASSIFIER_CONFIG.umEdgePaddingMs, SOUND_CLASSIFIER_CONFIG.umMinCutMs, SOUND_CLASSIFIER_CONFIG.umMergeGapMs, SOUND_CLASSIFIER_CONFIG.umMinKeepMs, SOUND_CLASSIFIER_CONFIG.umSecondsPerNewSeam, SOUND_CLASSIFIER_CONFIG.umMaxCv], [30, 150, 120, 250, 3, 0.35]);
eq("the new thresholds", [SOUND_CLASSIFIER_CONFIG.laughMinBursts, SOUND_CLASSIFIER_CONFIG.laughPeakAboveSpeechDb, SOUND_CLASSIFIER_CONFIG.laughPeakMinBursts, SOUND_CLASSIFIER_CONFIG.umMaxMs, SOUND_CLASSIFIER_CONFIG.umMaxPeakAboveSpeechDb], [3, 6, 2, 900, 3]);
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
// ── a loud single burst is no longer a laugh ──
{
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -20]]);
  const r = classifySound(cand(1160, 1460), ctxOf(windows), []);
  eq("a loud single burst (+8 dB, 1 pulse) -> unsure, not laugh", [r.cls, r.features.burstCount, r.features.peakVsSpeechDb > 6], ["unsure", 1, true]);
}
// ── laugh: loud AND at least two pulses ──
{
  const two = (i) => (i % 8 < 5 ? -20 : -45);
  const loud = windowsOf(12000, [...speechStretches, [1160, 1460, two]]);
  const r = classifySound(cand(1160, 1460), ctxOf(loud), []);
  eq("peak >= +6 dB with 2 pulses -> laugh", [r.cls, r.features.burstCount, r.why], ["laugh", 2, ["louder than speech with 2 pulses"]]);
  const quietTwo = (i) => (i % 8 < 5 ? -28 : -45);
  const q = classifySound(cand(1160, 1460), ctxOf(windowsOf(12000, [...speechStretches, [1160, 1460, quietTwo]])), []);
  eq("2 pulses at speech level -> not a laugh", [q.cls !== "laugh", q.features.burstCount], [true, 2]);
}
// ── near emphasis alone never makes a laugh ──
{
  const words = [w("a", 0, 3000), w("b", 3900, 5000)];
  const stretches = [[0, 3000, SPEECH], [3900, 5000, SPEECH], [3200, 3500, -31]];
  const quiet = windowsOf(8000, stretches);
  eq("without a jump the same sound is a um", classifySounds([cand(3200, 3500)], ctxOf(quiet, words))[0].cls, "um");
  const jumpy = windowsOf(8000, [...stretches, [4000, 4300, -15]]);
  const r = classifySounds([cand(3200, 3500)], ctxOf(jumpy, words))[0];
  eq("a loudness-jump moment within 1 s is only a feature: still a um", [r.cls, r.features.nearEmphasis], ["um", true]);
}

// ── unsure ──
{
  const at = (db) => classifySound(cand(1160, 1460), ctxOf(windowsOf(12000, [...speechStretches, [1160, 1460, db]])), []);
  eq("peak +3 dB is still a um", [at(-25).cls, Math.round(at(-25).features.peakVsSpeechDb)], ["um", 3]);
  eq("borderline: +4 dB (above um, below laugh) -> unsure", [at(-24).cls, Math.round(at(-24).features.peakVsSpeechDb)], ["unsure", 4]);
  const long = (ms) => classifySound(cand(1160, 1160 + ms), ctxOf(windowsOf(12000, [...speechStretches, [1160, 1160 + ms, -31]])), []).cls;
  eq("a um may last 900 ms but not 1000", [long(900), long(1000)], ["um", "unsure"]);
  const ramp = windowsOf(12000, [...speechStretches, [1160, 1460, (i) => -70 + 2.5 * i]]);
  const b = classifySound(cand(1160, 1460), ctxOf(ramp), []);
  eq("borderline: not steady, not pulsed, not loud -> unsure", [b.cls, b.features.steadiness > SOUND_CLASSIFIER_CONFIG.umMaxCv, b.features.burstCount], ["unsure", true, 1]);
  const tooShort = classifySound(cand(1160, 1250), ctxOf(windowsOf(12000, [...speechStretches, [1160, 1250, -31]])), []);
  eq("shorter than 150 ms is not a um", tooShort.cls, "unsure");
}

// ── method 2: ums are cut (owner), laughs and unsure sounds never ──
{
  const pulses = (i) => (i % 8 < 5 ? -20 : -45);
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -31], [2720, 3180, pulses], [4560, 4860, -24]]);
  const sounds = analyzeUnexplained(windows, WIN, 12000, speechWords);
  eq("end to end: one um, one laugh, one unsure", sounds.map((s) => [s.startMs, s.cls]), [[1160, "um"], [2720, "laugh"], [4560, "unsure"]]);
  const state = buildAiEditState({ uri: URI, durationMs: 12000, windows, words: speechWords });
  const ums = state.decisions.filter((d) => d.type === "umCut");
  eq("the um becomes one applied cut decision in the Ums category, padded 30 ms each side", ums.map((d) => [d.sourceStartMs, d.sourceEndMs, d.state, d.origin]), [[1190, 1430, "applied", "ai"]]);
  eq("the laugh and the unsure sound are never cut", state.decisions.filter((d) => d.sourceStartMs < 4860 && d.sourceEndMs > 2720 && d.sourceStartMs !== 0), []);
  const keep = keepRangesOf(state, 12000);
  eq("the laugh footage is kept", keep.some((k) => k.startMs <= 2720 && k.endMs >= 3180), true);
  eq("the unsure footage is kept", keep.some((k) => k.startMs <= 4560 && k.endMs >= 4860), true);
  eq("the um footage is cut, its edges are kept", [keep.some((k) => k.startMs < 1430 && k.endMs > 1190 && !(k.endMs <= 1190)), keep.some((k) => k.endMs === 1190), keep.some((k) => k.startMs === 1430)], [false, true, true]);
  eq("Ums off: the keep ranges have no um seam", keepRangesOf(setCategoryEnabled(state, "umCut", false), 12000).some((k) => k.endMs === 1190), false);
  // laughs feed zooms
  const zooms = planEmphasis({ windows, windowMs: WIN, words: speechWords, durationMs: 12000, laughs: sounds.filter((s) => s.cls === "laugh") });
  const laugh = zooms.find((z) => z.payload.reasons.includes("laugh"));
  eq("a laugh is an emphasis moment with a strong score", [!!laugh, laugh.sourceStartMs, laugh.payload.score >= 2, laugh.state], [true, 2720, true, "reverted"]);
  eq("without laughs there is no laugh reason", planEmphasis({ windows, windowMs: WIN, words: speechWords, durationMs: 12000 }).some((z) => z.payload.reasons.includes("laugh")), false);

  // markers: the applied um is a cut marker labeled Um; laugh/unsure stay debug markers
  const clips = keepRangesToClips(URI, keep);
  const cutMarkers = buildCutMarkers(state, 12000);
  eq("an applied um cut shows as a cut marker labeled Um", cutMarkers.filter((m) => m.items.some((i) => i.label === "Um")).length, 1);
  eq("its marker carries the class and features", describeDecision(ums[0]).sound.cls, "um");
  const markers = buildDebugMarkers([], sounds, clips, URI, ums);
  eq("debug markers: no um? for a um that was cut; laugh (orange), unsure (green)", markers.map((m) => [m.kind, m.detail.cls]), [["laugh", "laugh"], ["filler2", "unsure"]]);
  const uncut = buildDebugMarkers([], sounds, keepRangesToClips(URI, [{ startMs: 0, endMs: 12000 }]), URI, []);
  eq("a um that was NOT cut still shows as um?", uncut.filter((m) => m.kind === "um").map((m) => m.items[0].label), ["um?"]);
  // reversible, user wins, Restore works
  const umId = ums[0].id;
  const reverted = setDecisionState(state, umId, "reverted");
  const again = planUmCuts(reverted, sounds, 12000);
  eq("a reverted um stays reverted when planning runs again", mergePlan(reverted, again.decisions, ["umCut"]).resolved.map((d) => d.state), ["reverted"]);
  eq("Restore on the um's seam reverts it", restoreRange(state, 1200, 1300).decisions.find((d) => d.id === umId).state, "reverted");
}

// ── um cut rules: padding, merging, slivers, safety cap ──
{
  const D = 20000;
  const feature = (len) => ({ durationMs: len, peakVsSpeechDb: -3, steadiness: 0.1, burstCount: 1, nearEmphasis: false, midSpeech: true });
  const um = (startMs, endMs, cls = "um") => ({ startMs, endMs, lengthMs: endMs - startMs, cls, features: feature(endMs - startMs), why: [] });
  const sil = (a, b) => makeDecision("silenceCut", a, b);
  const baseOf = (...ds) => newEditState(URI, ds);
  const plan = (base, sounds) => planUmCuts(base, sounds, D);
  const ranges = (r) => r.map((x) => [x.startMs, x.endMs]);

  // padding
  const padded = plan(baseOf(), [um(5000, 5400)]);
  eq("padding: starts 30 ms after the candidate begins, ends 30 ms before it ends", padded.decisions.map((d) => [d.sourceStartMs, d.sourceEndMs]), [[5030, 5370]]);
  const keepP = keepRangesOf(mergePlan(baseOf(), padded.decisions, ["umCut"]).state, D);
  eq("padding keeps the neighbouring words intact (their edges survive)", [keepP.some((k) => k.startMs <= 5000 && k.endMs === 5030), keepP.some((k) => k.startMs === 5370 && k.endMs >= 5400)], [true, true]);
  eq("a um of 210 ms leaves 150 ms: cut", plan(baseOf(), [um(5000, 5210)]).decisions.length, 1);
  const short = plan(baseOf(), [um(5000, 5200)]);
  eq("a um shorter than 150 ms after padding is skipped, with the reason", [short.decisions.length, short.report.skipped.map((x) => x.reason)], [0, ["shorter than 150 ms after padding"]]);
  eq("laugh and unsure sounds are never planned as cuts", plan(baseOf(), [um(5000, 5400, "laugh"), um(7000, 7400, "unsure")]).decisions, []);

  // merge with pauses: one seam, not two
  const withPause = baseOf(sil(6000, 7000));
  const merged = plan(withPause, [um(5600, 5950)]);
  eq("a um within 120 ms of a silence cut is stretched to touch it", merged.decisions.map((d) => [d.sourceStartMs, d.sourceEndMs, d.payload.mergedWithSilence]), [[5630, 6000, true]]);
  const mergedState = mergePlan(withPause, merged.decisions, ["umCut"]).state;
  eq("...so the keep ranges have one seam, not two", ranges(keepRangesOf(mergedState, D)), [[0, 5630], [7000, D]]);
  eq("...and the seam count equals the silence-only count", [merged.report.finalSeams, merged.report.silenceOnlySeams], [1, 1]);
  const near = plan(withPause, [um(5500, 5850)]);
  eq("a um 180 ms before a pause leaves a 180 ms sliver, so it is bridged to the pause (one seam)", [near.decisions[0].sourceEndMs, near.report.finalSeams], [6000, 1]);
  const apart = plan(withPause, [um(5200, 5550)]);
  eq("a um 480 ms before a pause is its own cut (a second seam)", [apart.decisions[0].payload.mergedWithSilence, apart.report.finalSeams], [false, 2]);
  const between = plan(baseOf(sil(4000, 5000), sil(5600, 7000)), [um(5100, 5500)]);
  eq("a um between two pauses merges with both", [between.decisions[0].sourceStartMs, between.decisions[0].sourceEndMs], [5000, 5600]);

  // slivers
  const sliverBase = baseOf(sil(8000, 9000));
  const sliver = plan(sliverBase, [um(9170, 9500)]);
  eq("two cuts leaving a 200 ms piece are merged: the um stretches over it", sliver.decisions.map((d) => [d.sourceStartMs, d.sourceEndMs]), [[9000, 9470]]);
  eq("...no kept piece is shorter than 250 ms", keepRangesOf(mergePlan(sliverBase, sliver.decisions, ["umCut"]).state, D).every((k) => k.endMs - k.startMs >= 250), true);
  const ok = plan(sliverBase, [um(9230, 9560)]);
  eq("a 260 ms piece is kept (not a sliver)", ok.decisions.map((d) => [d.sourceStartMs, d.sourceEndMs]), [[9260, 9530]]);
  const twoUms = plan(baseOf(), [um(10000, 10330), um(10450, 10780)]);
  eq("a sliver between two ums merges them into one cut", ranges(keepRangesOf(mergePlan(baseOf(), twoUms.decisions, ["umCut"]).state, D)), [[0, 10030], [10750, D]]);
  const silenceSlivers = plan(baseOf(sil(1000, 2000), sil(2100, 3000)), [um(9000, 9300)]);
  eq("a short piece between two silence cuts is not touched", ranges(keepRangesOf(mergePlan(baseOf(sil(1000, 2000), sil(2100, 3000)), silenceSlivers.decisions, ["umCut"]).state, D)).slice(0, 2), [[0, 1000], [2000, 2100]]);

  // safety cap: 1 new seam per 3 s of edited duration (20 s -> 6)
  const many = Array.from({ length: 10 }, (_, i) => um(1000 + i * 1800, 1000 + i * 1800 + 300 + i * 20));
  const capped = plan(baseOf(), many);
  eq("the safety cap holds: 6 new seams for 20 s", [capped.decisions.length, capped.report.finalSeams, capped.report.seamLimit.allowed, capped.report.seamLimit.capped], [6, 6, 6, true]);
  eq("the longest ums are the ones applied", capped.decisions.map((d) => d.payload.original.startMs).sort((a, b) => a - b), many.slice(4).map((m) => m.startMs));
  eq("the others are skipped with the reason", capped.report.skipped.map((x) => x.reason), Array(4).fill("seam limit (6 new seams allowed)"));
  const fine = plan(baseOf(), many.slice(0, 5));
  eq("under the limit nothing is skipped", [fine.decisions.length, fine.report.seamLimit.capped], [5, false]);
  const merges = plan(baseOf(sil(1000, 2000)), [um(2060, 2400)]);
  eq("a merged um adds no seam, so it never counts against the cap", [merges.report.finalSeams, merges.report.silenceOnlySeams], [1, 1]);

  // the debug text
  const clips2 = keepRangesToClips(URI, keepRangesOf(mergePlan(baseOf(), capped.decisions, ["umCut"]).state, D));
  const text = formatAiDebug({ sourceDurationMs: D, clips: clips2, sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], umReport: capped.report });
  eq("debug text: applied ums (time, length, merged), skipped with reasons, seam counts, the cap note", [
    text.includes("Um cuts, method 2 (applied): 6"),
    text.includes("Um candidates skipped: 4"),
    text.includes("seam limit (6 new seams allowed)"),
    text.includes("Seams: 6 final vs 0 silence-only"),
    text.includes("Seam limit hit: at most 6 new seams for 0:20.0 edited"),
    /\d:\d\d\.\d  \d+ ms  merged with silence: no/.test(text),
  ], [true, true, true, true, true, true]);
  const mergedText = formatAiDebug({ sourceDurationMs: D, clips: keepRangesToClips(URI, keepRangesOf(mergedState, D)), sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], umReport: merged.report });
  eq("debug text: merged with silence yes", /merged with silence: yes/.test(mergedText), true);
}

// ── silence cuts are exactly the silence detector's, on a realistic multi-pause clip ──
{
  // 20 speech bursts (1.2-1.6 s) separated by pauses of 0.5-1.2 s; the longer pauses hold a
  // flat 300 ms um-like blip in the middle.
  const stretches = [];
  const words = [];
  const blips = [];
  let t = 0;
  for (let k = 0; k < 20; k++) {
    const speech = 1200 + ((k * 37) % 400);
    const speechEnd = t + Math.floor(speech / WIN) * WIN;
    stretches.push([t, speechEnd, SPEECH + ((k * 7) % 5) * 0.4]);
    words.push(w(`w${k}`, t, speechEnd));
    t = speechEnd;
    const pause = Math.floor((500 + ((k * 131) % 700)) / WIN) * WIN;
    if (pause >= 900) {
      const from = t + Math.floor((pause - 300) / 2 / WIN) * WIN;
      blips.push([from, from + 300]);
      stretches.push([from, from + 300, -33]);
    }
    t += pause;
  }
  const total = Math.ceil((words[words.length - 1].endMs + 200) / WIN) * WIN;
  const windows = windowsOf(total, stretches);
  const options = SENSITIVITY_PRESETS.tight;
  const detection = detectSilences(windows, WIN, { durationMs: total, ...options });
  const silenceOnly = newEditState(URI, planSilenceCuts(windows, WIN, total, options).decisions);
  const base = keepRangesOf(silenceOnly, total);
  const ranges = (r) => r.map((x) => [x.startMs, x.endMs]);
  eq("fixture: a realistic clip with many pauses", [detection.cuts.length >= 10, blips.length >= 5], [true, true]);
  eq("silence-only keep ranges equal the detector's own", ranges(base), ranges(detection.keepRanges));

  const sounds = analyzeUnexplained(windows, WIN, total, words);
  eq("fixture: method 2 finds um-like sounds here", sounds.filter((s) => s.cls === "um").length > 0, true);

  const owner = buildAiEditState({ uri: URI, durationMs: total, windows, silenceOptions: options, words });
  eq("the owner's AI edit has silence cuts and um cuts only", [...new Set(owner.decisions.map((d) => d.type))].sort(), ["silenceCut", "umCut"]);
  eq("Ums off: the keep ranges are IDENTICAL to silence-only", ranges(keepRangesOf(setCategoryEnabled(owner, "umCut", false), total)), ranges(base));
  eq("Ums off: same number of seams", keepRangesOf(setCategoryEnabled(owner, "umCut", false), total).length, base.length);
  eq("the silence decisions are exactly the silence planner's", owner.decisions.filter((d) => d.type === "silenceCut").map((d) => d.id), silenceOnly.decisions.map((d) => d.id));
  const withUms = keepRangesOf(owner, total);
  eq("the um cuts stay within the safety cap", withUms.length - base.length <= Math.floor((base.reduce((n, k) => n + k.endMs - k.startMs, 0) / 1000) / 3), true);
  eq("no kept piece next to a um is shorter than 250 ms", withUms.every((k) => k.endMs - k.startMs >= 250 || base.some((b) => b.startMs === k.startMs && b.endMs === k.endMs)), true);
  eq("the applied cuts include the silence cuts", appliedCutRanges(owner).length >= detection.cuts.length, true);

  // method-1 transcript fillers: with Fillers off the keep ranges differ only by the ums
  const withUm = [...words, w("um", words[3].endMs - 60, words[3].endMs - 10)].sort((x, y) => x.startMs - y.startMs);
  const ownerUm = buildAiEditState({ uri: URI, durationMs: total, windows, silenceOptions: options, words: withUm });
  eq("a method-1 um is the only added filler cut", ownerUm.decisions.filter((d) => d.type === "fillerCut").length, planFillerCuts(withUm).length);
  const off = setCategoryEnabled(setCategoryEnabled(ownerUm, "fillerCut", false), "umCut", false);
  eq("with Fillers and Ums off the keep ranges are identical to silence-only", ranges(keepRangesOf(off, total)), ranges(base));
}

// ── regression: the speech baseline and the timeline ──
{
  // 12 words of 500 ms speech; the word times spill 250 ms into silence on both sides
  const words = Array.from({ length: 12 }, (_, i) => w(`w${i}`, 1000 + i * 1500 - 250, 1000 + i * 1500 + 750));
  const stretches = words.map((x) => [x.startMs + 250, x.startMs + 750, SPEECH]);
  const windows = windowsOf(20000, stretches);
  const threshold = silenceThresholdDb(windows, WIN, 20000);
  eq("silence at word edges does not pull the baseline down", Math.round(speechMedianDb({ windows, windowMs: WIN, words, thresholdDb: threshold })), SPEECH);
  const um = classifySound(cand(2180, 2480), { windows: windowsOf(20000, [...stretches, [2180, 2480, -31]]), windowMs: WIN, words, thresholdDb: threshold }, []);
  eq("...so a um is judged against speech level, not against silence", [um.cls, Math.round(um.features.peakVsSpeechDb)], ["um", -3]);
}
{
  // fewer than 10 words, all of them off the sound (misaligned): fall back to non-silent frames
  const words = [w("a", 8000, 8500), w("b", 9000, 9500), w("c", 9600, 9900)];
  const windows = windowsOf(12000, [[0, 6000, SPEECH]]);
  const ctx = { windows, windowMs: WIN, words, thresholdDb: silenceThresholdDb(windows, WIN, 12000) };
  eq("fewer than 10 words: the baseline is the median of non-silent frames", Math.round(speechMedianDb(ctx)), SPEECH);
  const manyOnSilence = Array.from({ length: 10 }, (_, i) => w(`s${i}`, 7000 + i * 300, 7200 + i * 300));
  eq("10+ words that are all on silence also fall back, never to silence", Math.round(speechMedianDb({ ...ctx, words: manyOnSilence })), SPEECH);
}
{
  // words and loudness are both source time; an offset transcript is visible in the check
  const words = Array.from({ length: 12 }, (_, i) => w(`w${i}`, 1000 + i * 1500, 1500 + i * 1500));
  const windows = windowsOf(20000, words.map((x) => [x.startMs + 400, x.endMs + 400, SPEECH]));
  const a = checkAlignment(windows, WIN, words, -60);
  eq("a transcript 400 ms ahead of the audio is detected", [a.bestShiftMs, a.shareAtZero < 0.3, a.bestShare > 0.95], [400, true, true]);
  const aligned = checkAlignment(windowsOf(20000, words.map((x) => [x.startMs, x.endMs, SPEECH])), WIN, words, -60);
  eq("an aligned transcript has its best share at shift 0", [aligned.bestShiftMs, aligned.shareAtZero], [0, 1]);
}

// ── regression: the emphasis loudness jump ──
{
  const ctx = (windows, extra = {}) => ({ windows, windowMs: WIN, words: [], durationMs: windows.length * WIN, ...extra });
  const afterSilence = windowsOf(8000, [[3000, 4000, SPEECH]]);
  eq("speech starting after silence is not a jump", loudnessJumpScorer(ctx(afterSilence, { silenceThresholdDb: -60 })), []);
  eq("...even with the old fixed floor", loudnessJumpScorer(ctx(afterSilence)), []);
  // quiet-ish background that the edit removes, then speech
  const bed = windowsOf(8000, [[0, 2000, -45], [2000, 2400, -30]]);
  eq("without the cut, speech after a -45 dB bed is a jump", loudnessJumpScorer(ctx(bed, { silenceThresholdDb: -60 })).length > 0, true);
  eq("the baseline ignores removed footage", loudnessJumpScorer(ctx(bed, { silenceThresholdDb: -60, cuts: [{ startMs: 0, endMs: 2000 }] })), []);
  eq("the baseline ignores frames below the silence threshold", loudnessJumpScorer(ctx(bed, { silenceThresholdDb: -40 })), []);
  // one loud stretch gives many candidates; they count once
  const steady = windowsOf(8000, [[0, 3000, -30], [3000, 3600, -15]]);
  const raw = loudnessJumpScorer(ctx(steady, { silenceThresholdDb: -60 }));
  const moments = scoreEmphasis(ctx(steady, { silenceThresholdDb: -60 }));
  eq("a loud stretch produces several raw candidates", raw.length > 1, true);
  eq("...but one moment, with the loudness reason once", [moments.length, moments[0].reasons.filter((r) => r.startsWith("loudness")).length], [1, 1]);
  eq("...and its score is the strongest candidate, not their sum", moments[0].score, Math.max(...raw.map((c) => c.score)));
  const both = scoreEmphasis({ ...ctx(steady, { silenceThresholdDb: -60 }), words: [w("a", 2000, 2900), w("b", 3550, 4000)] });
  eq("different kinds still add: loudness once + pause once", both[0].reasons.map((r) => r.split(" ")[0]), ["loudness", "line"]);
}
// ── the loop is broken: classification uses loudness jumps only ──
{
  const pulses = (i) => (i % 8 < 5 ? -20 : -45);
  const windows = windowsOf(12000, [...speechStretches, [1160, 1460, -31], [2720, 3180, pulses]]);
  const before = analyzeUnexplained(windows, WIN, 12000, speechWords);
  const zooms = planEmphasis({ windows, windowMs: WIN, words: speechWords, durationMs: 12000, laughs: before.filter((s) => s.cls === "laugh") });
  const after = analyzeUnexplained(windows, WIN, 12000, speechWords);
  eq("planning zooms from laughs does not change the classification", JSON.stringify(after), JSON.stringify(before));
  eq("the confirmed laugh is a zoom signal afterwards", zooms.some((z) => z.payload.reasons.includes("laugh")), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
