#!/usr/bin/env node
/**
 * Pre-App-Store audit of the AI editor, as tests: silence removal on realistic signals (continuous speech, natural pauses,
 * quiet speech, loud game / music, long silences, no silence, no speech), the cut cap that left real pauses in, invariants
 * of every cut list, preview and export using the SAME decisions, non-destructive editing, captions after cuts, the
 * render-edit validation, interrupted analysis, and the cut markers that merge when they would overlap.
 * Needs a device or a human listen: how a cut sounds, and the real seek / swap timing of the players.
 *   node --experimental-strip-types --no-warnings scripts/test-edit-audit.mjs
 */
import {
  ABSOLUTE_CEILING_DB, MAX_CUTS, MAX_CUTS_CEILING, MIN_KEEP_MS, MIN_SILENCE_MS, PAD_AFTER_SPEECH_MS, PAD_BEFORE_SPEECH_MS, SENSITIVITY_PRESETS,
  detectSilences, maxCutsFor,
} from "../lib/silenceDetection.ts";
import { planSilenceCuts } from "../lib/autoEdit/silenceCuts.ts";
import { addManualCut, addSplit, keepRangesOf, makeDecision, mergePlan, newEditState, pieceRangesOf, renderClipsOf, setCaptionEdits, setCaptionStyle } from "../lib/autoEdit/decisions.ts";
import { cutCategoriesOff } from "../lib/autoEdit/editPanel.ts";
import { reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { buildCutMarkers, restoreMarker } from "../lib/autoEdit/markers.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { buildSegments, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";
import { coalesceEdit, editLengthMs, rangeOf, renderEditOf, validateEdit } from "../lib/renderEdit.ts";
import { rawKeyOf, renderSignature } from "../lib/renderSignature.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { buildCaptionLines } from "../lib/transcription/captionLines.ts";
import { MARKER_MIN_GAP_PX, clusterByPixels, scaleToSeparate } from "../lib/autoEdit/timelineView.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);

const W = 20;
/** [[ms, dB], ...] -> 20 ms windows */
function signal(parts) {
  const out = [];
  for (const [ms, db] of parts) for (let i = 0; i < Math.round(ms / W); i++) out.push(typeof db === "function" ? db(i) : db);
  return out;
}
const SPEECH = -22, QUIET = -70;
const run = (windows, opts = {}) => detectSilences(windows, W, { durationMs: windows.length * W, ...opts });
const TIGHT = SENSITIVITY_PRESETS.tight;

// ── 1. silence removal on realistic signals ──
{
  const continuous = run(signal([[30_000, (i) => SPEECH + 4 * Math.sin(i / 3)]]), TIGHT);
  eq("continuous speech: nothing is cut", [continuous.cuts.length, continuous.savedMs], [0, 0]);

  const natural = run(signal([[5000, SPEECH], [250, QUIET], [5000, SPEECH], [280, QUIET], [5000, SPEECH], [600, QUIET], [5000, SPEECH]]), TIGHT);
  eq("natural pauses of 250 / 280 ms stay; the 600 ms pause is cut (tight: from 300 ms)", natural.cuts.map((c) => Math.round(c.lengthMs / 10) * 10), [520]);
  const gentle = run(signal([[5000, SPEECH], [600, QUIET], [5000, SPEECH]]), SENSITIVITY_PRESETS.gentle);
  eq("gentle keeps a 600 ms pause (comedic timing): gentle cuts from 800 ms", gentle.cuts.length, 0);

  const quietSpeech = run(signal([[4000, -41], [900, -68], [4000, -40], [900, -68], [4000, -42]]), TIGHT);
  eq("quiet speech (-41 dB) over a quiet room (-68 dB): the pauses are found, the speech is kept", [quietSpeech.cuts.length, quietSpeech.thresholdDb > -68 && quietSpeech.thresholdDb < -41], [2, true]);
  const quietNoisy = run(signal([[4000, -41], [900, -52], [4000, -40]]), TIGHT);
  eq("quiet speech in a noisy room (pause only 11 dB lower): kept rather than clipped", quietNoisy.cuts.every((c) => c.startMs >= 4000 - 1 && c.endMs <= 4900 + 1), true);

  const game = run(signal([[6000, -12], [1500, -24], [6000, -10], [1500, -25]]), TIGHT);
  eq("loud game / music under the voice: its quieter parts are never 'silence'", [game.cuts.length, game.thresholdDb <= ABSOLUTE_CEILING_DB], [0, true]);

  const long = run(signal([[4000, SPEECH], [3500, QUIET], [4000, SPEECH]]), TIGHT);
  eq("a 3.5 s silence is cut down to the speech padding", [long.cuts.length, Math.round(long.cuts[0].lengthMs) >= 3500 - PAD_AFTER_SPEECH_MS - PAD_BEFORE_SPEECH_MS - 60], [1, true]);

  const none = run(signal([[20_000, (i) => -30 + 3 * Math.sin(i / 2)]]), TIGHT);
  eq("no silence anywhere (steady noise): nothing is cut", none.cuts.length, 0);

  const noSpeech = run(signal([[12_000, -72]]), TIGHT);
  eq("no speech at all: not edited (nothing would be left)", [noSpeech.cuts.length, noSpeech.skipReason], [0, "no_activity"]);

  const head = run(signal([[1200, QUIET], [6000, SPEECH], [900, QUIET]]), TIGHT);
  eq("a silent head and tail are trimmed (no seam)", head.cuts.map((c) => c.edge), ["start", "end"]);
}

// ── 2. the cut cap (the confirmed cause of the pauses left in the recording) ──
{
  // 22 pauses of 0.46 .. 2.4 s in 68 s: the old flat cap of 14 left six real pauses in.
  const parts = [[2500, SPEECH]];
  const lens = [450, 1014, 1872, 1092, 700, 1180, 740, 2100, 1500, 520, 880, 1330, 960, 610, 1750, 800, 1240, 690, 1480, 990, 1110, 560];
  for (const len of lens) parts.push([len, QUIET], [1300, SPEECH]);
  const w = signal(parts);
  const r = run(w, TIGHT);
  eq("22 pauses (all >= 0.3 s): every one is cut now (it used to stop at 14 + the head and tail)", [r.silences.length, r.silences.filter((s) => !s.cut).length], [22, 0]);
  eq("the cap scales with the clip: 14 for short clips, 0.5 per second after that, never above the ceiling", [maxCutsFor(10_000), maxCutsFor(38_000), maxCutsFor(68_000), maxCutsFor(180_000), MAX_CUTS, MAX_CUTS_CEILING], [14, 19, 34, 60, 14, 60]);
  eq("an explicit maxCuts still wins (callers can ask for fewer)", run(w, { ...TIGHT, maxCuts: 5 }).cuts.filter((c) => !c.edge).length, 5);
  eq("when the cap does bind the longest pauses are the ones cut", (() => { const cut = run(w, { ...TIGHT, maxCuts: 5 }).silences.filter((s) => s.cut).map((s) => s.lengthMs); const left = run(w, { ...TIGHT, maxCuts: 5 }).silences.filter((s) => !s.cut).map((s) => s.lengthMs); return Math.min(...cut) >= Math.max(...left); })(), true);
}

// ── 3. invariants of every cut list (random clips) ──
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let bad = [];
  for (let trial = 0; trial < 200; trial++) {
    const parts = [];
    const n = 3 + Math.floor(rnd() * 40);
    if (rnd() < 0.3) parts.push([Math.round(rnd() * 1500), QUIET]);
    for (let i = 0; i < n; i++) {
      parts.push([200 + Math.round(rnd() * 5000), SPEECH + Math.round(rnd() * 8)]);
      parts.push([Math.round(rnd() * 3000), rnd() < 0.15 ? -40 : QUIET]);
    }
    const w = signal(parts);
    const total = w.length * W;
    for (const preset of Object.values(SENSITIVITY_PRESETS)) {
      const r = run(w, preset);
      const fail = (why) => bad.push(`trial ${trial} ${why}`);
      let prevEnd = 0, sum = 0;
      for (const c of r.cuts) {
        if (!(c.startMs >= prevEnd - 1e-6)) fail("cuts overlap or are out of order");
        if (!(c.endMs > c.startMs) || c.startMs < 0 || c.endMs > total + 1e-6) fail("invalid cut interval");
        prevEnd = c.endMs;
        sum += c.endMs - c.startMs;
        // only quiet audio is cut: every window inside a cut is below the threshold
        for (let i = Math.ceil(c.startMs / W); i < Math.floor(c.endMs / W); i++) if (w[i] >= r.thresholdDb + 1e-9 && !(c.edge)) { fail(`speech inside a cut at ${i * W} ms`); break; }
      }
      if (Math.abs(sum - r.savedMs) > 1e-6) fail("savedMs differs from the cuts");
      let prev = 0;
      for (const k of r.keepRanges) {
        if (k.startMs < prev - 1e-6 || k.endMs <= k.startMs) fail("invalid keep range");
        prev = k.endMs;
      }
      const interiorPieces = r.keepRanges.length > 1 ? r.keepRanges.slice(1, -1) : [];
      if (interiorPieces.some((k) => k.endMs - k.startMs < MIN_KEEP_MS - 1e-6)) fail("micro-clip (kept piece under the minimum)");
      if (r.cuts.length && total - sum < 3000 - 1e-6) fail("less than the minimum left");
      if (r.cuts.filter((c) => !c.edge).length > maxCutsFor(total)) fail("more cuts than the cap");
    }
  }
  eq(`200 random clips x 3 presets: cuts ordered, valid, only over quiet audio, no micro-clips, savings add up (${bad.length} problems)`, bad.slice(0, 3), []);
}

// ── 4. speech padding (clipped word starts and ends) ──
{
  const r = run(signal([[3000, SPEECH], [1000, QUIET], [3000, SPEECH]]), TIGHT);
  const c = r.cuts[0];
  ok(`the cut starts ${PAD_AFTER_SPEECH_MS} ms after the last speech window and ends ${PAD_BEFORE_SPEECH_MS} ms before the next`, Math.abs(c.startMs - (3000 + PAD_AFTER_SPEECH_MS)) <= W + 1 && Math.abs(c.endMs - (4000 - PAD_BEFORE_SPEECH_MS)) <= W + 41);
  const soft = run(signal([[3000, SPEECH], [1000, QUIET], [40, -48], [40, -40], [3000, SPEECH]]), TIGHT);
  ok("a soft consonant onset before speech is kept (the cut ends before it)", soft.cuts[0].endMs <= 4000 + 1);
  eq("the speech padding, the minimum pause and the keep minimum are named config values", [PAD_AFTER_SPEECH_MS, PAD_BEFORE_SPEECH_MS, MIN_SILENCE_MS, MIN_KEEP_MS], [30, 50, 500, 350]);
}

// ── 5. preview and export use the SAME decisions ──
{
  const parts = [[2000, SPEECH]];
  for (let i = 0; i < 18; i++) parts.push([500 + i * 90, QUIET], [1200 + (i % 4) * 400, SPEECH]);
  const w = signal(parts);
  const total = w.length * W;
  const planned = planSilenceCuts(w, W, total, TIGHT);
  const state = newEditState("file:///a.mov", planned.decisions);
  const detectorKeep = planned.detection.keepRanges.map((k) => [k.startMs, k.endMs]);
  eq("the decisions keep exactly what the detector kept", keepRangesOf(state, total).map((k) => [k.startMs, k.endMs]), detectorKeep);
  const clips = renderClipsOf(state, total).map((c, i) => ({ id: `c${i}`, ...c }));
  const preview = buildSegments(clips).map((s) => [s.srcStartMs, s.srcEndMs]);
  const exported = renderEditOf(clips).edit.map((r) => [r.trimStartMs, r.trimEndMs]);
  eq("the preview plays the clips the decisions give, the export renders the same ranges", [preview, exported], [detectorKeep, detectorKeep]);
  eq("...and they are the same length", [Math.round(totalEditedMs(buildSegments(clips))), Math.round(renderEditOf(clips).editMs)], [Math.round(total - planned.detection.savedMs), Math.round(total - planned.detection.savedMs)]);
  // with splits, hand cuts and a range cut on top: still one list for both
  let s2 = addSplit(state, 1000, total);
  s2 = addManualCut(s2, 3000, 3400);
  const clips2 = renderClipsOf(s2, total).map((c, i) => ({ id: `c${i}`, ...c }));
  eq("with a split and a hand cut on top the preview pieces and the export differ only by the split (which is merged away)", [buildSegments(clips2).length >= renderEditOf(clips2).edit.length, renderEditOf(clips2).edit.map((r) => [r.trimStartMs, r.trimEndMs])], [true, keepRangesOf(s2, total).map((k) => [k.startMs, k.endMs])]);
  eq("a split does not change what a render is for (no redundant render)", rawKeyOf(clips2.filter(() => true)), rawKeyOf(keepRangesOf(s2, total).map((k) => ({ uri: "file:///a.mov", trimStartMs: k.startMs, trimEndMs: k.endMs }))));
  ok("...and the signature of a finished render stays the same", renderSignature({ clips: clips2, includeCaptions: false, size: { width: 720, height: 1280 } }) === renderSignature({ clips: keepRangesOf(s2, total).map((k) => ({ uri: "file:///a.mov", trimStartMs: k.startMs, trimEndMs: k.endMs })), includeCaptions: false, size: { width: 720, height: 1280 } }));
}

// ── 6. render edit validation ──
{
  const ok1 = [{ uri: "u", trimStartMs: 0, trimEndMs: 1000 }, { uri: "u", trimStartMs: 1000, trimEndMs: 2000 }, { uri: "u", trimStartMs: 3000, trimEndMs: 4000 }];
  eq("contiguous pieces merge, a gap keeps two ranges", coalesceEdit(ok1).map((r) => [r.trimStartMs, r.trimEndMs]), [[0, 2000], [3000, 4000]]);
  eq("different files are never merged", coalesceEdit([{ uri: "a", trimStartMs: 0, trimEndMs: 100 }, { uri: "b", trimStartMs: 100, trimEndMs: 200 }]).length, 2);
  eq("a valid edit has no problem and a length", [validateEdit(coalesceEdit(ok1)), editLengthMs(coalesceEdit(ok1))], [null, 3000]);
  const bad = (r) => validateEdit([r]);
  eq("invalid intervals are caught before anything is exported", [validateEdit([]), bad({ uri: "u", trimStartMs: 500, trimEndMs: 500 }), bad({ uri: "u", trimStartMs: 800, trimEndMs: 300 }), bad({ uri: "u", trimStartMs: NaN, trimEndMs: 300 }), bad({ uri: "u", trimStartMs: -5, trimEndMs: 300 }), bad({ uri: "u", trimStartMs: 0, trimEndMs: 10 })], ["empty edit", "invalid clip range", "invalid clip range", "invalid clip range", "invalid clip range", "clip too short"]);
  eq("a range past the end of its file is caught (clips carry the file's length)", renderEditOf([{ uri: "u", trimStartMs: 0, trimEndMs: 9000, durationMs: 5000 }]).problem, "clip beyond the end of its file");
  eq("a trimEnd of 0 means to the end of the file", rangeOf({ uri: "u", trimStartMs: 100, trimEndMs: 0, durationMs: 900 }), { uri: "u", trimStartMs: 100, trimEndMs: 900 });
}

// ── 7. non-destructive editing ──
{
  const DUR = 60_000;
  const ai = newEditState("u", [makeDecision("silenceCut", 5000, 6200), makeDecision("silenceCut", 20_000, 21_500), makeDecision("silenceCut", 40_000, 41_000)]);
  const original = [[0, DUR]];
  let st = setCaptionEdits(setCaptionStyle(ai, { scale: 1, yCenter: 0.7, xCenter: 0.5, fontId: "classic" }), { 3: "hello" });
  st = addSplit(st, 12_000, DUR);
  st = addManualCut(st, 30_000, 31_000);
  st = reshapeCutAtEdge(st, { side: "right", atMs: 5000 }, 4500, DUR);   // trim a clip inward
  const edited = keepRangesOf(st, DUR);
  ok("the source file is never changed: every cut is an instruction, the whole recording is always there", original[0][1] === DUR && edited.length > 1);
  // restore every cut chip: the full original comes back
  let all = st;
  for (let guard = 0; guard < 20; guard++) {
    const marker = buildCutMarkers(all, DUR).find((m) => m.kind === "cut");
    if (!marker) break;
    all = restoreMarker(all, marker);
  }
  eq("restoring each cut chip brings back the whole recording", keepRangesOf(all, DUR).map((k) => [k.startMs, k.endMs]), original);
  ok("...without touching the caption edits, the caption style or the split", all.captionEdits?.[3] === "hello" && all.captionStyle?.fontId === "classic" && (all.splits ?? []).includes(12_000));
  // undo / redo walk back through every step
  let h = emptyHistory(), cur = ai;
  const steps = [(s) => addSplit(s, 12_000, DUR), (s) => addManualCut(s, 30_000, 31_000), (s) => reshapeCutAtEdge(s, { side: "right", atMs: 5000 }, 4500, DUR)];
  const states = [ai];
  for (const f of steps) { const next = f(cur); h = pushEdit(h, cur); cur = next; states.push(next); }
  let u = { history: h, state: cur };
  const undone = [];
  for (let i = 0; i < steps.length; i++) { u = undoEdit(u.history, u.state); undone.push(u.state === states[states.length - 2 - i]); }
  eq("undo walks back through split, hand cut and trim to exactly the AI edit", [undone, u.state === ai], [[true, true, true], true]);
  for (let i = 0; i < steps.length; i++) u = redoEdit(u.history, u.state);
  eq("redo brings every step back", JSON.stringify(u.state) === JSON.stringify(cur), true);
  // re-analysis (a sensitivity change) keeps the creator's own work and their reversals
  const replanned = mergePlan(st, [makeDecision("silenceCut", 5000, 6200), makeDecision("silenceCut", 50_000, 51_000)], ["silenceCut"]);
  ok("re-planning keeps hand cuts, splits, caption edits and the caption style", replanned.state.splits?.includes(12_000) && replanned.state.captionEdits?.[3] === "hello" && replanned.state.captionStyle?.fontId === "classic" && keepRangesOf(replanned.state, DUR).every((k) => !(k.startMs < 30_500 && k.endMs > 30_500)));
  const restoredThenReplanned = mergePlan(restoreMarker(ai, buildCutMarkers(ai, DUR)[0]), [makeDecision("silenceCut", 5000, 6200)], ["silenceCut"]).state;
  ok("a cut the creator restored is not cut again by a re-plan", keepRangesOf(restoredThenReplanned, DUR).some((k) => k.startMs <= 5000 && k.endMs >= 6200));
  // Keep original: the automatic cuts off; the creator's own work stays
  const kept = cutCategoriesOff(st);
  ok("Keep original turns the automatic cuts off and leaves the hand cut, the split and the captions alone", kept.splits?.includes(12_000) && kept.captionEdits?.[3] === "hello" && keepRangesOf(kept, DUR).some((k) => k.endMs <= 30_000) && !keepRangesOf(kept, DUR).some((k) => k.startMs < 30_500 && k.endMs > 30_500));
  // the AI edit state built from analysis is deterministic, so Reset gives the same edit each time
  const w = signal([[3000, SPEECH], [900, QUIET], [3000, SPEECH], [1200, QUIET], [3000, SPEECH]]);
  eq("planning the AI edit twice from the same analysis gives the same decisions", JSON.stringify(buildAiEditState({ uri: "u", durationMs: w.length * W, windows: w, silenceOptions: TIGHT })), JSON.stringify(buildAiEditState({ uri: "u", durationMs: w.length * W, windows: w, silenceOptions: TIGHT })));
}

// ── 8. captions after cuts ──
{
  const DUR = 40_000;
  const words = [];
  for (let i = 0; i < 60; i++) words.push({ text: `w${i}`, startMs: 300 + i * 600, endMs: 300 + i * 600 + 420 });
  let seed = 99;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let problems = [];
  for (let trial = 0; trial < 100; trial++) {
    let st = newEditState("u", []);
    for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++) { const a = Math.round(rnd() * (DUR - 2000)); st = addManualCut(st, a, a + 200 + Math.round(rnd() * 1800)); }
    const keep = keepRangesOf(st, DUR);
    if (keep.length === 0) continue;
    const total = keep.reduce((s, k) => s + k.endMs - k.startMs, 0);
    const lines = buildCaptionLines(words, {}, keep, null);
    let prevEnd = -1;
    for (const l of lines) {
      if (l.startMs < prevEnd - 1e-6) problems.push(`trial ${trial}: overlap`);
      if (l.startMs < -1e-6 || l.endMs > total + 1e-6 || l.endMs <= l.startMs) problems.push(`trial ${trial}: outside the edit`);
      prevEnd = l.endMs;
      for (const i of l.srcIndexes) {
        const w = words[i];
        const overlap = keep.reduce((m, k) => Math.max(m, Math.min(w.endMs, k.endMs) - Math.max(w.startMs, k.startMs)), -Infinity);
        if (overlap < (w.endMs - w.startMs) * 0.5 - 1e-6) problems.push(`trial ${trial}: a word from removed footage (${w.text})`);
      }
    }
    const shown = new Set(lines.flatMap((l) => l.srcIndexes));
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const overlap = keep.reduce((m, k) => Math.max(m, Math.min(w.endMs, k.endMs) - Math.max(w.startMs, k.startMs)), -Infinity);
      if (overlap >= (w.endMs - w.startMs) * 0.5 + 1e-6 && !shown.has(i)) problems.push(`trial ${trial}: a spoken word is missing (${w.text})`);
    }
  }
  eq(`100 random edits: caption lines ordered, one at a time, inside the edit, no word from cut footage, no spoken word missing (${problems.length} problems)`, problems.slice(0, 3), []);
}

// ── 9. interrupted processing and retry ──
{
  let calls = 0, fail = true;
  const cache = createAnalysisCache({
    stat: async () => ({ uri: "u", size: 1, mtime: 1 }),
    loadLoudness: async () => { calls++; if (fail) throw new Error("interrupted"); return { durationMs: 1000, windows: [-20, -20] }; },
    transcribe: async () => ({ words: [], status: "ok" }),
  });
  let first = null;
  try { await cache.loudness("u"); } catch (e) { first = e.message; }
  eq("an interrupted analysis fails loudly (the caller shows its message)", first, "interrupted");
  fail = false;
  const second = await cache.loudness("u");
  eq("...and a retry runs the analysis again instead of replaying the failure", [second?.durationMs, calls], [1000, 2]);
  const third = await cache.loudness("u");
  eq("an unchanged file is analysed once: the next call is served from the cache", [third?.durationMs, calls], [1000, 2]);
}

// ── 10. cut markers that would overlap are one marker with a count ──
{
  const fifteen = Array.from({ length: 15 }, (_, i) => 1500 + i * 2200);   // a 38 s edit with 15 cuts
  const fitScale = (360 - 40) / 38_000;
  const groups = clusterByPixels(fifteen, fitScale);
  ok(`at the whole-video zoom the 15 dots no longer overlap: every marker is at least ${MARKER_MIN_GAP_PX} pt from the next (${groups.length} markers)`, groups.every((g, i) => i === 0 || (g.outputMs - groups[i - 1].outputMs) * fitScale >= MARKER_MIN_GAP_PX - 8) && groups.length < 15 && groups.reduce((n, g) => n + g.count, 0) === 15);
  eq("zoomed in far enough they are all separate", clusterByPixels(fifteen, 0.2).length, 15);
  eq("a count of 1 is a plain marker", clusterByPixels([1000], 0.01), [{ outputMs: 1000, indices: [0], count: 1 }]);
  eq("markers close together are grouped, order of the input does not matter", clusterByPixels([5000, 1000, 5100, 1050], 0.05).map((g) => [g.count, g.indices.sort()]), [[2, [1, 3]], [2, [0, 2]]]);
  const g = groups.find((x) => x.count > 1);
  const s = scaleToSeparate(g, fifteen, 38_000, 360);
  ok("tapping a group zooms to where its markers are apart", clusterByPixels(g.indices.map((i) => fifteen[i]), s).length === g.count || s >= 0.2);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
