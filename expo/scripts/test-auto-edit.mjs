#!/usr/bin/env node
/**
 * Tests the decision model, planners and analysis cache (lib/autoEdit/):
 *
 *   node --experimental-strip-types scripts/test-auto-edit.mjs
 *
 * (From expo/. Node 22.6+; the flag is a no-op on newer Node.)
 */
import {
  addUserCut, keepRangesOf, makeDecision, mapNonCutDecisions, mergePlan, newEditState, renderClipsOf,
  restoreRange, setCategoryEnabled, setDecisionState, setStates, decisionId,
} from "../lib/autoEdit/decisions.ts";
import { planSilenceCuts } from "../lib/autoEdit/silenceCuts.ts";
import { planHookTrim } from "../lib/autoEdit/hookTrim.ts";
import { findUnexplainedSounds, isFillerWord, planFillerCuts } from "../lib/autoEdit/fillerCuts.ts";
import { emphasisLogEntries, planEmphasis, scoreEmphasis } from "../lib/autoEdit/emphasisMoments.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { keepRangesToClips, outputToSourceMs, sourceToOutputMs } from "../lib/editModel.ts";
import { detectSilences, mergeKeepRanges, SENSITIVITY_PRESETS } from "../lib/silenceDetection.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
function ok(name, cond) {
  eq(name, !!cond, true);
}
const URI = "file:///a.mov";
const D = 10_000;
const cut = (type, s, e, extra = {}) => makeDecision(type, s, e, extra);
const ranges = (r) => r.map((x) => [x.startMs, x.endMs]);
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const state = (...decisions) => newEditState(URI, decisions);

// ── ids ──
eq("id from type and rounded range", decisionId("silenceCut", 1003, 1998), "silenceCut:1000-2000");
eq("same cut, same id", cut("silenceCut", 1001, 1999).id, cut("silenceCut", 998, 2002).id);

// ── Rule a: pure function of (source, EditState); nothing is mutated ──
{
  const s = state(cut("silenceCut", 1000, 2000), cut("fillerCut", 5000, 5300));
  const frozen = JSON.stringify(s);
  const a = renderClipsOf(s, D);
  const b = renderClipsOf(s, D);
  eq("a: same state, same clips", a, b);
  eq("a: state is not mutated", JSON.stringify(s), frozen);
  eq("a: the source uri is the state's", a.every((c) => c.uri === URI), true);
}

// ── Rule b: kept iff no applied, enabled cut covers it ──
eq("b: no decisions keeps everything", ranges(keepRangesOf(state(), D)), [[0, D]]);
eq(
  "b: cuts are removed",
  ranges(keepRangesOf(state(cut("silenceCut", 1000, 2000), cut("hookTrim", 0, 300), cut("fillerCut", 5000, 5300)), D)),
  [[300, 1000], [2000, 5000], [5300, D]],
);
eq(
  "b: overlapping cuts of different types merge",
  ranges(keepRangesOf(state(cut("silenceCut", 1000, 2000), cut("fillerCut", 1800, 2500)), D)),
  [[0, 1000], [2500, D]],
);
eq(
  "b: a reverted cut keeps its footage",
  ranges(keepRangesOf(setDecisionState(state(cut("silenceCut", 1000, 2000)), "silenceCut:1000-2000", "reverted"), D)),
  [[0, D]],
);
eq(
  "b: a disabled category keeps its footage",
  ranges(keepRangesOf(setCategoryEnabled(state(cut("fillerCut", 5000, 5300), cut("silenceCut", 1000, 2000)), "fillerCut", false), D)),
  [[0, 1000], [2000, D]],
);
eq("b: non-cut decisions never cut", ranges(keepRangesOf(state(cut("zoom", 1000, 2000), cut("caption", 3000, 4000)), D)), [[0, D]]);
eq("b: cuts are clamped to the source", ranges(keepRangesOf(state(cut("hookTrim", -500, 400), cut("hookTrim", 9800, 12000)), D)), [[400, 9800]]);
eq("b: cutting everything leaves nothing", ranges(keepRangesOf(state(cut("silenceCut", 0, D)), D)), []);
eq(
  "b: clips come from the keep ranges",
  renderClipsOf(state(cut("silenceCut", 1000, 2000)), D),
  keepRangesToClips(URI, [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: D }]),
);

// ── Rule c: non-cut decisions map at render time and stay on their content ──
{
  const zoom = cut("zoom", 5000, 6000);
  const withCut = state(cut("silenceCut", 1000, 2000), zoom);
  const clipsCut = renderClipsOf(withCut, D);
  const mappedCut = mapNonCutDecisions(withCut, clipsCut);
  eq("c: zoom maps through the cut", mappedCut[0].pieces, [{ startMs: 4000, endMs: 5000 }]);
  const restored = restoreRange(withCut, 1000, 2000);
  const clipsRestored = renderClipsOf(restored, D);
  const mappedRestored = mapNonCutDecisions(restored, clipsRestored);
  eq("c: after restoring the cut it moves", mappedRestored[0].pieces, [{ startMs: 5000, endMs: 6000 }]);
  eq("c: ...but its source content is unchanged (cut state)", outputToSourceMs(clipsCut, mappedCut[0].pieces[0].startMs), 5000);
  eq("c: ...but its source content is unchanged (restored state)", outputToSourceMs(clipsRestored, mappedRestored[0].pieces[0].startMs), 5000);
  eq("c: maps with sourceToOutputMs", mappedCut[0].pieces[0].startMs, sourceToOutputMs(clipsCut, 5000, URI));
  const straddle = state(cut("silenceCut", 5200, 5600), cut("zoom", 5000, 6000));
  eq("c: a zoom across a cut plays continuously over the seam", mapNonCutDecisions(straddle, renderClipsOf(straddle, D))[0].pieces, [
    { startMs: 5000, endMs: 5600 },
  ]);
  const gone = state(cut("silenceCut", 4000, 7000), cut("zoom", 5000, 6000));
  eq("c: a zoom wholly cut has no output", mapNonCutDecisions(gone, renderClipsOf(gone, D)), []);
  eq("c: reverted and disabled decisions are not mapped", mapNonCutDecisions(setCategoryEnabled(state(zoom), "zoom", false), keepRangesToClips(URI, [{ startMs: 0, endMs: D }])), []);
}

// ── Rule d: user wins when planners re-run ──
{
  const old = state(cut("silenceCut", 1000, 2000), cut("silenceCut", 4000, 5000));
  const afterUser = setDecisionState(old, "silenceCut:1000-2000", "reverted");
  const replanSame = mergePlan(afterUser, [cut("silenceCut", 1000, 2000), cut("silenceCut", 4000, 5000)], ["silenceCut"]);
  eq("d: the same cut stays reverted", replanSame.resolved.map((d) => d.state), ["reverted", "applied"]);
  const shifted = mergePlan(afterUser, [cut("silenceCut", 1100, 1900), cut("silenceCut", 4000, 5000)], ["silenceCut"]);
  eq("d: a shifted cut (contained, 100% overlap) stays reverted", shifted.resolved.map((d) => d.state), ["reverted", "applied"]);
  const half = mergePlan(afterUser, [cut("silenceCut", 1500, 2500)], ["silenceCut"]);
  eq("d: exactly 50% overlap stays reverted", half.resolved[0].state, "reverted");
  const little = mergePlan(afterUser, [cut("silenceCut", 1800, 3000)], ["silenceCut"]);
  eq("d: 20% overlap is applied", little.resolved[0].state, "applied");
  eq("d: the footage stays kept after a re-plan", ranges(keepRangesOf(shifted.state, D)), [[0, 4000], [5000, D]]);
  const otherType = mergePlan(afterUser, [cut("fillerCut", 1200, 1500)], ["fillerCut"]);
  eq("d: a reverted decision also blocks another type", otherType.resolved[0].state, "reverted");
  const userCut = addUserCut(old, 6000, 6500);
  const replanned = mergePlan(userCut, [cut("silenceCut", 4000, 5000)], ["silenceCut"]);
  eq("d: user cuts survive a re-plan", replanned.state.decisions.some((d) => d.origin === "user" && d.sourceStartMs === 6000), true);
  eq("d: old AI cuts that are gone from the plan are dropped", replanned.state.decisions.some((d) => d.id === "silenceCut:1000-2000"), false);
  const again = mergePlan(replanned.state, [cut("silenceCut", 4000, 5000)], ["silenceCut"]);
  eq("d: re-planning twice is stable", JSON.stringify(again.state), JSON.stringify(replanned.state));
  const reapplied = setStates(afterUser, { "silenceCut:1000-2000": "applied" });
  eq("d: the user can turn a reverted decision back on", reapplied.decisions[0].state, "applied");
}

// ── Rule e: restoreRange reverts EVERY overlapping cut ──
{
  const s = state(cut("silenceCut", 1000, 2000), cut("hookTrim", 1800, 2600), cut("fillerCut", 2500, 2800), cut("silenceCut", 6000, 7000), cut("zoom", 1500, 1700));
  const r = restoreRange(s, 1900, 2550);
  eq("e: every overlapping cut is reverted", r.decisions.map((d) => [d.id, d.state]), [
    ["silenceCut:1000-2000", "reverted"],
    ["zoom:1500-1700", "applied"],
    ["hookTrim:1800-2600", "reverted"],
    ["fillerCut:2500-2800", "reverted"],
    ["silenceCut:6000-7000", "applied"],
  ]);
  eq("e: a range touching only the edge reverts nothing", restoreRange(s, 2800, 2900).decisions.filter((d) => d.state === "reverted").length, 0);
  eq("e: the footage comes back", ranges(keepRangesOf(r, D)).some(([a, b]) => a <= 1900 && b >= 2550), true);
}

// ── silence planner: keep ranges IDENTICAL to today's ──
function speechWindows(pattern, windowMs = 20) {
  const out = [];
  for (const [ms, db] of pattern) for (let i = 0; i < ms / windowMs; i++) out.push(db + ((i * 7) % 5) * 0.4);
  return out;
}
{
  const pattern = [[400, -80], [1500, -22], [900, -75], [1200, -20], [1300, -78], [1000, -24], [600, -70], [900, -21], [2500, -80]];
  const windows = speechWindows(pattern);
  const duration = windows.length * 20;
  for (const preset of ["gentle", "normal", "tight"]) {
    const options = SENSITIVITY_PRESETS[preset];
    const detection = detectSilences(windows, 20, { durationMs: duration, ...options });
    const planned = planSilenceCuts(windows, 20, duration, options);
    const derived = keepRangesOf(newEditState(URI, planned.decisions), duration);
    eq(`silence (${preset}): keep ranges identical to detectSilences`, ranges(derived), ranges(detection.keepRanges));
    eq(`silence (${preset}): clips identical`, renderClipsOf(newEditState(URI, planned.decisions), duration), keepRangesToClips(URI, detection.keepRanges));
    ok(`silence (${preset}): found cuts to compare`, detection.cuts.length > 0);
    // The Review sheet's switches: disabling cuts must match mergeKeepRanges
    const enabled = detection.cuts.map((_, i) => i % 2 === 0);
    let s = newEditState(URI, planned.decisions);
    planned.decisions.forEach((d, i) => {
      if (!enabled[i]) s = setDecisionState(s, d.id, "reverted");
    });
    eq(`silence (${preset}): disabled cuts match mergeKeepRanges`, ranges(keepRangesOf(s, duration)), ranges(mergeKeepRanges(detection.keepRanges, enabled, detection.cuts)));
  }
  const none = planSilenceCuts(speechWindows([[3000, -20]]), 20, 3000);
  eq("silence: nothing found, nothing cut", [none.decisions.length, ranges(keepRangesOf(newEditState(URI, none.decisions), 3000))], [0, [[0, 3000]]]);
}

// ── hook trim ──
eq("hook: no words, no decisions", planHookTrim([], 5000), []);
{
  const d = planHookTrim([w("Welcome", 800, 1200), w("back", 1250, 1500), w("everyone", 1550, 2000)], 6000);
  eq("hook: starts ~150 ms before the first word, ends ~300 ms after the last", d.map((x) => [x.type, x.sourceStartMs, x.sourceEndMs]), [
    ["hookTrim", 0, 650],
    ["hookTrim", 2300, 6000],
  ]);
  eq("hook: applied by default, from the AI", d.every((x) => x.state === "applied" && x.origin === "ai"), true);
}
eq("hook: a word at the very start is not trimmed", planHookTrim([w("Hi", 100, 400), w("there", 450, 800)], 800).map((x) => x.sourceStartMs), []);
{
  const d = planHookTrim([w("So", 200, 400), w("Okay", 1000, 1300), w("this", 1350, 1600)], 5000);
  eq("hook: weak opener + pause > 300 ms is cut up to ~150 ms before the next word", d[0] && [d[0].sourceStartMs, d[0].sourceEndMs], [0, 850]);
}
{
  const d = planHookTrim([w("So,", 200, 400), w("this", 600, 900), w("is", 950, 1100)], 5000);
  eq("hook: weak opener with a pause of only 200 ms is not cut as an opener", d[0] && [d[0].sourceStartMs, d[0].sourceEndMs, d[0].payload.reason], [0, 50, "lead"]);
}
{
  const d = planHookTrim([w("Hey", 300, 500), w("guys", 520, 800), w("today", 1300, 1600)], 6000);
  eq("hook: 'hey guys' is a weak opener", d[0] && [d[0].sourceEndMs, d[0].payload.reason], [1150, "weakOpener"]);
}
{
  const d = planHookTrim([w("What's", 300, 500), w("up", 520, 700), w("so", 1100, 1300), w("today", 1350, 1600)], 6000);
  eq("hook: 'what's up' is a weak opener", d[0] && [d[0].sourceEndMs, d[0].payload.reason], [950, "weakOpener"]);
}
{
  const d = planHookTrim([w("hello", 4600, 5000), w("there", 5050, 5400)], 9000);
  ok("hook: never trims more than 3 s from the start", d.every((x) => x.sourceStartMs !== 0 || x.sourceEndMs <= 3000));
  eq("hook: a long lead is capped at 3 s", d[0] && [d[0].sourceStartMs, d[0].sourceEndMs], [0, 3000]);
  const far = planHookTrim([w("Um", 500, 700), w("hello", 4600, 5000)], 9000);
  eq("hook: a weak opener whose cut would pass 3 s is not cut as an opener", far[0] && [far[0].sourceEndMs, far[0].payload.reason], [350, "lead"]);
}
eq("hook: not a weak opener when it is a normal first word", planHookTrim([w("Sorry", 600, 900), w("about", 1500, 1800)], 5000)[0].payload.reason, "lead");
eq("hook: a tail shorter than 50 ms is left alone", planHookTrim([w("Hi", 200, 1000)], 1300).map((x) => x.payload.edge), ["start"]);

// ── filler cuts ──
eq("filler words", ["um", "Uh,", "umm", "er", "ah", "Hmm", "hmmm", "hello", "uhm", "area"].map(isFillerWord), [true, true, true, true, true, true, true, false, true, false]);
eq(
  "filler: method 1 gives applied cut decisions",
  planFillerCuts([w("so", 0, 200), w("um", 300, 600), w("I", 650, 700), w("uh", 900, 1100)]).map((d) => [d.type, d.sourceStartMs, d.sourceEndMs, d.state]),
  [["fillerCut", 300, 600, "applied"], ["fillerCut", 900, 1100, "applied"]],
);
{
  // 20 ms windows: sound 1000-1300 (no word), sound 2000-2300 (under a word), sound 3000-4600 (too long), blip 5000-5060 (too short)
  const windows = new Array(300).fill(-80);
  const loud = (a, b) => { for (let i = a / 20; i < b / 20; i++) windows[i] = -20; };
  loud(1000, 1300); loud(2000, 2300); loud(3000, 4600); loud(5000, 5060);
  const found = findUnexplainedSounds(windows, 20, [w("word", 1950, 2350)], -40);
  eq("filler: method 2 finds only unexplained 150-1500 ms sounds", found, [{ startMs: 1000, endMs: 1300, lengthMs: 300 }]);
}

// ── emphasis ──
{
  const windows = new Array(1000).fill(-30); // 20 s of steady speech
  for (let i = 400; i < 420; i++) windows[i] = -15; // +15 dB at 8000 ms
  const words = [w("a", 0, 300), w("b", 3000, 3300), w("c", 3500, 3800), w("d", 13000, 13300)];
  const ctx = { windows, windowMs: 20, words, durationMs: 20000 };
  const moments = scoreEmphasis(ctx);
  ok("emphasis: loudness jump and pause start are found", moments.some((m) => m.reasons.some((r) => r.startsWith("loudness"))) && moments.some((m) => m.reasons.some((r) => r.includes("pause"))));
  ok("emphasis: at least 3.5 s apart", moments.every((m, i) => i === 0 || m.sourceMs - moments[i - 1].sourceMs >= 3500));
  ok("emphasis: at most about one per 5 s", moments.length <= 4);
  const proposals = planEmphasis(ctx);
  ok("emphasis: proposals are zoom decisions, not applied", proposals.length > 0 && proposals.every((d) => d.type === "zoom" && d.state === "reverted"));
  const entries = emphasisLogEntries(proposals, keepRangesToClips(URI, [{ startMs: 0, endMs: 2000 }, { startMs: 4000, endMs: 20000 }]), URI);
  ok("emphasis: log entries carry sourceMs, outputMs, score, reasons", entries.every((e) => "sourceMs" in e && "outputMs" in e && typeof e.score === "number" && Array.isArray(e.reasons)));
  const extra = scoreEmphasis(ctx, [() => [{ sourceMs: 16000, score: 5, reason: "face" }]]);
  eq("emphasis: an extra scorer (e.g. faces) plugs in", extra.map((m) => [m.sourceMs, m.reasons]), [[16000, ["face"]]]);
  eq("emphasis: steady loudness and no pauses finds nothing", scoreEmphasis({ windows: new Array(1000).fill(-30), windowMs: 20, words: [w("a", 0, 300), w("b", 350, 700)], durationMs: 20000 }), []);
}

// ── analysis cache ──
{
  let loudnessRuns = 0, transcriptRuns = 0, active = 0, overlap = false;
  const order = [];
  const store = new Map();
  const mk = () => createAnalysisCache({
    stat: async (uri) => ({ uri, size: 100, mtime: 5 }),
    loadLoudness: async () => { order.push("loudness"); active++; overlap ||= active > 1; loudnessRuns++; await new Promise((r) => setTimeout(r, 10)); active--; return { durationMs: 1000, windows: [1, 2, 3] }; },
    transcribe: async () => { order.push("transcript"); active++; overlap ||= active > 1; transcriptRuns++; await new Promise((r) => setTimeout(r, 10)); active--; return { status: "ok", words: [w("hi", 0, 100)] }; },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), remove: async (k) => void store.delete(k) },
  });
  const cache = mk();
  const [t, l1] = await Promise.all([cache.transcript(URI), cache.loudness(URI)]);
  eq("cache: silence analysis runs before transcription", order, ["loudness", "transcript"]);
  ok("cache: analyses never run at the same time", !overlap);
  const [l2, t2] = [await cache.loudness(URI), await cache.transcript(URI)];
  eq("cache: computed once per source", [loudnessRuns, transcriptRuns], [1, 1]);
  eq("cache: same data on reuse", [l2, t2], [l1, t]);
  const [a, b] = await Promise.all([cache.loudness("file:///other.mov"), cache.loudness("file:///other.mov")]);
  eq("cache: concurrent requests share one run", [loudnessRuns, a === b || JSON.stringify(a) === JSON.stringify(b)], [2, true]);
  const fresh = mk();
  await fresh.loudness(URI);
  await fresh.transcript(URI);
  eq("cache: a new session reads the stored analysis", [loudnessRuns, transcriptRuns], [2, 1]);
  const changed = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 101, mtime: 5 }),
    loadLoudness: async () => { loudnessRuns++; return { durationMs: 1, windows: [] }; },
    transcribe: async () => ({ status: "unavailable" }),
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), remove: async (k) => void store.delete(k) },
  });
  await changed.loudness(URI);
  eq("cache: a different file size is a different source", loudnessRuns, 3);
  const failing = createAnalysisCache({ stat: async (uri) => ({ uri, size: 1, mtime: 1 }), loadLoudness: async () => null, transcribe: async () => ({ status: "denied" }) });
  eq("cache: only ok transcripts are cached", [(await failing.transcript(URI)).status, (await failing.transcript(URI)).status, failing.runs.transcript], ["denied", "denied", 2]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
