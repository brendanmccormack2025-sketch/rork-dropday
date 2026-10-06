#!/usr/bin/env node
/**
 * Tests the AI edits panel logic (history, panel rows, markers, position mapping,
 * reset, debug text) in lib/autoEdit/:
 *
 *   node --experimental-strip-types scripts/test-ai-edits.mjs
 */
import {
  addUserCut, keepRangesOf, makeDecision, mergePlan, newEditState, renderClipsOf, setCategoryEnabled,
  setDecisionState,
} from "../lib/autoEdit/decisions.ts";
import { canRedo, canUndo, emptyHistory, mapHistory, MAX_HISTORY, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { allCategoriesOff, categoryRows, isOriginalVideo } from "../lib/autoEdit/editPanel.ts";
import {
  buildCutMarkers, buildDebugMarkers, describeDecision, mapOutputPosition, reapplyMarker, restoreMarker,
} from "../lib/autoEdit/markers.ts";
import { formatAiDebug, formatClock } from "../lib/autoEdit/debugText.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { guardManualEdits, MANUAL_EDIT_CONFIRM_MESSAGE, timelineMatchesState } from "../lib/autoEdit/confirm.ts";
import { planEmphasis } from "../lib/autoEdit/emphasisMoments.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { keepRangesToClips, outputToSourceMs } from "../lib/editModel.ts";
import { detectSilences, SENSITIVITY_PRESETS } from "../lib/silenceDetection.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const URI = "file:///a.mov";
const D = 10_000;
const cut = (type, s, e, extra) => makeDecision(type, s, e, extra);
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const st = (...ds) => newEditState(URI, ds);
const ranges = (r) => r.map((x) => [x.startMs, x.endMs]);

// ── undo / redo ──
{
  const s0 = st(cut("silenceCut", 1000, 2000), cut("fillerCut", 5000, 5300));
  const s1 = setDecisionState(s0, "silenceCut:1000-2000", "reverted");
  const s2 = setCategoryEnabled(s1, "fillerCut", false);
  let h = emptyHistory();
  eq("history starts empty", [canUndo(h), canRedo(h)], [false, false]);
  h = pushEdit(h, s0);
  h = pushEdit(h, s1);
  const u1 = undoEdit(h, s2);
  eq("undo returns the previous state", u1.state, s1);
  const u2 = undoEdit(u1.history, u1.state);
  eq("undo twice reaches the first state", u2.state, s0);
  eq("nothing left to undo", undoEdit(u2.history, u2.state), null);
  const r1 = redoEdit(u2.history, u2.state);
  eq("redo returns the undone state", r1.state, s1);
  const r2 = redoEdit(r1.history, r1.state);
  eq("redo twice reaches the latest state", r2.state, s2);
  eq("nothing left to redo", redoEdit(r2.history, r2.state), null);
  const afterNew = pushEdit(u1.history, s1);
  eq("a new action clears redo", canRedo(afterNew), false);
  let big = emptyHistory();
  for (let i = 0; i < MAX_HISTORY + 20; i++) big = pushEdit(big, st(cut("silenceCut", i * 10, i * 10 + 5)));
  eq("history is capped at 50", big.past.length, 50);
  eq("the oldest steps are dropped", big.past[0].decisions[0].sourceStartMs, 200);
  eq("undo of a state is the state itself (round trip)", redoEdit(undoEdit(h, s2).history, undoEdit(h, s2).state).state, s2);
}
{
  // AI planning is not an undo step: it never pushes; saved snapshots are re-planned
  const base = st(cut("silenceCut", 1000, 2000));
  const userReverted = setDecisionState(base, "silenceCut:1000-2000", "reverted");
  let h = pushEdit(emptyHistory(), base); // the user reverted the cut: the step starts from `base`
  const aiPlan = [cut("fillerCut", 5000, 5300)];
  const replan = (s) => mergePlan(s, aiPlan, ["hookTrim", "fillerCut"]).state;
  const current = replan(userReverted);
  h = mapHistory(h, replan);
  eq("planning did not add an undo step", h.past.length, 1);
  const back = undoEdit(h, current);
  eq("undo keeps the AI decisions planned later", back.state.decisions.map((d) => [d.id, d.state]), [
    ["silenceCut:1000-2000", "applied"],
    ["fillerCut:5000-5300", "applied"],
  ]);
  eq("...and undo brings back the user's choice", back.state.decisions[0].state, "applied");
}

// ── panel rows ──
{
  const s = st(cut("silenceCut", 1000, 2000), cut("silenceCut", 3000, 3500), cut("fillerCut", 5000, 5300), cut("hookTrim", 0, 300));
  eq("everyone sees only Cuts", categoryRows(s, { owner: false, captionLines: 0, captionsOn: true }).map((r) => [r.id, r.label, r.count, r.enabled]), [["cuts", "Cuts", 2, true]]);
  const owner = categoryRows(setCategoryEnabled(s, "fillerCut", false), { owner: true, captionLines: 7, captionsOn: true });
  eq("the owner sees all five rows", owner.map((r) => [r.id, r.count, r.enabled]), [
    ["cuts", 2, true], ["hook", 1, true], ["fillers", 1, false], ["zooms", 0, true], ["captions", 7, true],
  ]);
  const reverted = categoryRows(setDecisionState(s, "silenceCut:1000-2000", "reverted"), { owner: false, captionLines: 0, captionsOn: true });
  eq("count is applied decisions only", reverted[0].count, 1);
  const off = allCategoriesOff(s);
  eq("Original video: every category off", [isOriginalVideo(off), ranges(keepRangesOf(off, D))], [true, [[0, D]]]);
  eq("Original video does not touch the decisions", off.decisions, s.decisions);
  eq("the Cuts switch is setCategoryEnabled", ranges(keepRangesOf(setCategoryEnabled(s, "silenceCut", false), D)), [[300, 5000], [5300, D]]);
}

// ── markers ──
{
    const s = st(cut("silenceCut", 1000, 2000), cut("fillerCut", 2000, 2300, { payload: { text: "um" } }), cut("silenceCut", 6000, 6600));
  const m = buildCutMarkers(s, D);
  eq("two cuts at one seam: one marker, both listed", m.map((x) => [x.outputMs, x.items.map((i) => i.label)]), [
    [1000, ["Silence 1.0s", "Filler 'um'"]],
    [4700, ["Silence 0.6s"]],
  ]);
  eq("the marker covers the whole span", [m[0].srcStartMs, m[0].srcEndMs], [1000, 2300]);
  const restored = restoreMarker(s, m[0]);
  eq("Restore reverts both cuts at that seam", restored.decisions.map((d) => d.state), ["reverted", "reverted", "applied"]);
  const after = buildCutMarkers(restored, D);
  eq("restored sections get one subtle marker", after.map((x) => [x.kind, x.outputMs, x.items.length]), [["restored", 1000, 2], ["cut", 6000, 1]]);
  const again = reapplyMarker(restored, after.find((x) => x.kind === "restored"));
  eq("tapping a restored marker re-applies its cuts", JSON.stringify(again.decisions), JSON.stringify(s.decisions));
  eq("a category switched off draws no markers", buildCutMarkers(setCategoryEnabled(s, "fillerCut", false), D).map((x) => x.items.map((i) => i.type)), [["silenceCut"], ["silenceCut"]]);
  eq("labels", [describeDecision(cut("hookTrim", 0, 800, { payload: { reason: "weakOpener" } })).label, describeDecision(cut("hookTrim", 9000, 10000, { payload: { edge: "end" } })).label, describeDecision(cut("fillerCut", 1, 2)).label], ["Weak opener 0.8s", "Ending trim 1.0s", "Filler 'filler'"]);
  eq("a restored cut that another cut still covers draws nothing", buildCutMarkers(setDecisionState(st(cut("silenceCut", 1000, 2000), cut("fillerCut", 1200, 1800, { payload: { text: "uh" } })), "fillerCut:1200-1800", "reverted"), D).map((x) => x.kind), ["cut"]);
}

// ── position mapping across a restore ──
{
  const withCut = st(cut("silenceCut", 1000, 2000));
  const oldClips = renderClipsOf(withCut, D);
  const restoredState = restoreMarker(withCut, buildCutMarkers(withCut, D)[0]);
  const newClips = renderClipsOf(restoredState, D);
  const map = (out) => mapOutputPosition(oldClips, newClips, out, URI);
  eq("a position after the cut shifts to the same content", [map(4000), outputToSourceMs(newClips, map(4000))], [5000, 5000]);
  eq("a position before the cut is unchanged", map(500), 500);
  eq("the seam maps to the start of the restored footage", map(1000), 2000);
  eq("the end stays the end", map(oldClips.reduce((n, c) => n + c.trimEndMs - c.trimStartMs, 0)), D);
  eq("position 0 stays 0", map(0), 0);
  // the other way: a cut applied over the playhead lands on the seam
  const back = (out) => mapOutputPosition(newClips, oldClips, out, URI);
  eq("content that gets cut lands on its seam", back(1500), 1000);
  eq("content after the new cut keeps its place", [back(5000), outputToSourceMs(oldClips, back(5000))], [4000, 5000]);
  eq("round trip returns to the same place", map(back(7000)), 7000);
  const multi = st(cut("silenceCut", 1000, 2000), cut("silenceCut", 4000, 4500), cut("fillerCut", 7000, 7300));
  const mc = renderClipsOf(multi, D);
  const mr = renderClipsOf(restoreMarker(multi, buildCutMarkers(multi, D)[1]), D);
  eq("restoring one of several cuts moves only later positions", [mapOutputPosition(mc, mr, 500, URI), mapOutputPosition(mc, mr, 2000, URI), mapOutputPosition(mc, mr, 5000, URI)], [500, 2000, 5500]);
}

// ── Reset to AI edit reuses cached analysis ──
{
  const windows = [];
  for (const [ms, db] of [[400, -80], [1500, -22], [900, -75], [1200, -20], [1300, -78], [1000, -24], [600, -70], [900, -21], [2500, -80]]) {
    for (let i = 0; i < ms / 20; i++) windows.push(db + ((i * 7) % 5) * 0.4);
  }
  const durationMs = windows.length * 20;
  const words = [w("so", 450, 650), w("hello", 1700, 2100), w("um", 2200, 2500), w("there", 3500, 3900)];
  let loudnessRuns = 0, transcriptRuns = 0;
  const cache = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 5, mtime: 5 }),
    loadLoudness: async () => { loudnessRuns++; return { durationMs, windows }; },
    transcribe: async () => { transcriptRuns++; return { status: "ok", words }; },
  });
  const options = SENSITIVITY_PRESETS.tight;
  const planFrom = async (owner) => {
    const loud = await cache.loudness(URI);
    const t = owner ? await cache.transcript(URI) : null;
    return buildAiEditState({ uri: URI, durationMs: loud.durationMs, windows: loud.windows, silenceOptions: options, words: t && t.status === "ok" ? t.words : null });
  };
  const ai = await planFrom(true);
  eq("the AI edit has cuts, a hook trim and a filler", [ai.decisions.some((d) => d.type === "silenceCut"), ai.decisions.some((d) => d.type === "hookTrim"), ai.decisions.some((d) => d.type === "fillerCut")], [true, true, true]);
  eq("the AI edit ran each analysis once", [loudnessRuns, transcriptRuns], [1, 1]);
  // the creator changes things
  let edited = setCategoryEnabled(ai, "silenceCut", false);
  edited = setDecisionState(edited, ai.decisions.find((d) => d.type === "fillerCut").id, "reverted");
  edited = addUserCut(edited, 8000, 8200);
  const reset = await planFrom(true);
  eq("Reset to AI edit gives the original AI edit back", JSON.stringify(reset), JSON.stringify(ai));
  eq("...with every reversal cleared and every category on", [reset.decisions.every((d) => d.state === "applied" && d.origin === "ai"), Object.values(reset.categoryEnabled).every(Boolean)], [true, true]);
  eq("...without any new analysis", [loudnessRuns, transcriptRuns], [1, 1]);
  eq("(the edit really had changed)", JSON.stringify(edited) === JSON.stringify(ai), false);
  const plain = await planFrom(false);
  eq("everyone else's reset has only silence cuts", plain.decisions.every((d) => d.type === "silenceCut"), true);
  const detection = detectSilences(windows, 20, { durationMs, ...options });
  eq("...and they equal today's keep ranges", ranges(keepRangesOf(plain, durationMs)), ranges(detection.keepRanges));
  eq("a clip with too little silence gets no cuts", buildAiEditState({ uri: URI, durationMs: 3000, windows: new Array(150).fill(-20) }).decisions, []);
}

// ── debug text ──
eq("clock format", [formatClock(0), formatClock(7234), formatClock(59960), formatClock(64000), formatClock(125500)], ["0:00.0", "0:07.2", "1:00.0", "1:04.0", "2:05.5"]);
{
  const clips = keepRangesToClips(URI, [{ startMs: 500, endMs: 3000 }, { startMs: 4000, endMs: 20000 }]);
  const proposals = [
    makeDecision("zoom", 6000, 7200, { state: "reverted", payload: { score: 1.4, reasons: ["loud jump", "after pause"] } }),
    makeDecision("zoom", 3500, 4700, { state: "reverted", payload: { score: 0.8, reasons: ["loud jump"] } }),
  ];
  const text = formatAiDebug({
    sourceDurationMs: 20000,
    clips,
    sourceUri: URI,
    proposals,
    candidates: [{ startMs: 1000, endMs: 1300, lengthMs: 300 }, { startMs: 3200, endMs: 3400, lengthMs: 200 }],
    hookTrims: [cut("hookTrim", 0, 500, { payload: { edge: "start", reason: "weakOpener" } })],
    fillers: [cut("fillerCut", 5000, 5300, { payload: { text: "um" } })],
  });
  eq("debug text", text, [
    "Trial AI debug",
    "Clip duration: 0:20.0 (edited 0:18.5)",
    "",
    "Emphasis proposals (not applied): 2",
    "0:04.5  score 1.40  loud jump, after pause",
    "cut  score 0.80  loud jump",
    "",
    "Filler candidates, method 2 (not applied): 2",
    "0:00.5  300 ms  sound with no transcript word",
    "cut  200 ms  sound with no transcript word",
    "",
    "Hook trim (applied): 1",
    "start  source 0:00.0-0:00.5  weakOpener",
    "",
    "Fillers, method 1 (applied): 1",
    "'um'  source 0:05.0-0:05.3",
    "",
    "Um cuts, method 2 (applied): 0",
  ].join("\n"));
  eq("debug text with nothing found", formatAiDebug({ sourceDurationMs: 5000, clips: keepRangesToClips(URI, [{ startMs: 0, endMs: 5000 }]), sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [] }).split("\n"), [
    "Trial AI debug", "Clip duration: 0:05.0 (edited 0:05.0)", "", "Emphasis proposals (not applied): 0", "", "Filler candidates, method 2 (not applied): 0", "", "Hook trim (applied): 0", "", "Fillers, method 1 (applied): 0", "", "Um cuts, method 2 (applied): 0",
  ]);
  const dm = buildDebugMarkers(proposals, [{ startMs: 1000, endMs: 1300, lengthMs: 300 }, { startMs: 3200, endMs: 3400, lengthMs: 200 }], clips, URI);
  eq("debug markers: proposals and candidates, cut-out moments skipped", dm.map((m) => [m.kind, m.outputMs, m.detail.reasons]), [
    ["filler2", 500, ["sound with no word, 300 ms"]],
    ["proposal", 4500, ["loud jump", "after pause"]],
  ]);
}

// ── confirm before replacing manual edits ──
{
  const state = st(cut("silenceCut", 1000, 2000), cut("fillerCut", 5000, 5300));
  const modelClips = () => renderClipsOf(state, D).map((c, i) => ({ id: `c${i}`, ...c }));
  eq("a timeline equal to the model matches", timelineMatchesState(modelClips(), state, D), true);
  eq("edges within 60 ms still match", timelineMatchesState(modelClips().map((c) => ({ ...c, trimEndMs: c.trimEndMs - 40 })), state, D), true);
  const manual = [{ id: "m", uri: URI, trimStartMs: 0, trimEndMs: 3000 }, { id: "n", uri: URI, trimStartMs: 6000, trimEndMs: 8000 }];
  eq("hand-edited clips do not match", timelineMatchesState(manual, state, D), false);
  eq("a split the model does not know about does not match", timelineMatchesState([...modelClips().slice(0, 1), { id: "x", uri: URI, trimStartMs: 1500, trimEndMs: 1600 }, ...modelClips().slice(1)], state, D), false);
  eq("the confirm text", MANUAL_EDIT_CONFIRM_MESSAGE, "This will replace your manual edits with the AI edit. Continue?");

  // The editor's action: apply = show the model's render in place of the timeline.
  const run = (timeline, answer) => {
    let clips = timeline;
    let asked = 0;
    let model = state;
    const ask = (onContinue) => {
      asked++;
      if (answer === "continue") onContinue();
    };
    guardManualEdits(timelineMatchesState(clips, model, D), ask, () => {
      model = setCategoryEnabled(model, "fillerCut", false);
      clips = renderClipsOf(model, D);
    });
    return { clips, asked, model };
  };
  const cancelled = run(manual, "cancel");
  eq("Cancel leaves the manual timeline unchanged", cancelled.clips, manual);
  eq("Cancel leaves the model unchanged", cancelled.model, state);
  eq("the creator was asked once", cancelled.asked, 1);
  const confirmed = run(manual, "continue");
  eq("Continue replaces the manual edits with the model's render", ranges(confirmed.clips.map((c) => ({ startMs: c.trimStartMs, endMs: c.trimEndMs }))), [[0, 1000], [2000, D]]);
  const inSync = run(modelClips(), "cancel");
  eq("no dialog when the timeline matches the model", [inSync.asked, ranges(inSync.clips.map((c) => ({ startMs: c.trimStartMs, endMs: c.trimEndMs })))], [0, [[0, 1000], [2000, D]]]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
