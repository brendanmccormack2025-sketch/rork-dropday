#!/usr/bin/env node
/**
 * Frame-precise edge drag (what is shown at release is what is committed) and the selected-clip loop.
 *   node --experimental-strip-types --no-warnings scripts/test-edge-drag.mjs
 */
import { readFileSync } from "node:fs";
import { moveEdge, rawEdgeMs, roundToFrame, startEdgeSession } from "../lib/autoEdit/edgeDrag.ts";
import { SNAP_MAX_MS, SNAP_PX, buildSnapTargets, crossesWord, snapParams, snapStart, snapStep, snapThresholdMs } from "../lib/autoEdit/edgeSnap.ts";
import { addManualCut, addSplit, keepRangesOf, makeDecision, mergePlan, newEditState, pieceRangesOf, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { describeEdgeDrag, reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { CLIP_LOOP_LEAD_MS, clipLoopOf, loopOfSegment, loopTick, playheadOnSelect, selectionSuccessor, tapOff } from "../lib/autoEdit/clipLoop.ts";
import { buildSegments } from "../lib/autoEdit/virtualTimeline.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const DUR = 60_000;
const base = () => newEditState("u", [makeDecision("silenceCut", 10_000, 12_000), makeDecision("silenceCut", 30_000, 31_500)]);
const keep = (st) => keepRangesOf(st, DUR).map((k) => [k.startMs, k.endMs]);

/** A drag of the end of the first clip (10 000 ms), the way the timeline does it. */
function drag({ state = base(), edge = { side: "right", atMs: 10_000 }, scale, fps = 30, moves, words, startX = 200, offsetStart = 0, scroll = 0 }) {
  const lo = describeEdgeDrag(state, edge, -1e9, DUR, 1).clampedMs;
  const hi = describeEdgeDrag(state, edge, 1e9, DUR, 1).clampedMs;
  const s = startEdgeSession({ atMs: edge.atMs, startX, offsetStart, min: lo, max: hi, fps, now: 0 });
  const targets = buildSnapTargets(words, []);
  let t = 0, caught = 0, last = null;
  const land = (ms) => describeEdgeDrag(state, edge, ms, DUR, 1).clampedMs;
  for (const dx of moves) {
    t += 16;
    last = moveEdge(s, { x: startX + dx, offset: offsetStart + scroll, scale, now: t, targets, params: snapParams(scale, words), land });
    if (last.caught) caught++;
  }
  const shown = s.ms;
  const d = describeEdgeDrag(state, edge, shown, DUR, 1);
  const next = d.kind === "none" ? state : reshapeCutAtEdge(state, edge, d.clampedMs, DUR, 1);
  return { shown, committed: d.clampedMs, state: next, caught, session: s };
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── Part 1: the position shown at release is the position committed ──
{
  let bad = [];
  for (const scale of [0.002, 0.0084, 0.03, 0.12, 0.5, 2]) {
    for (const fps of [24, 30, 60]) {
      for (const dxPx of [-90, -37.3, -6, -1.7, 2.2, 5, 19.9, 64.1]) {
        const moves = Array.from({ length: 12 }, (_, i) => (dxPx * (i + 1)) / 12);
        const r = drag({ scale, fps, moves });
        if (!near(r.shown, r.committed)) bad.push(`shown ${r.shown} != committed ${r.committed} @${scale}/${fps}/${dxPx}`);
        const end = keep(r.state).find((k) => near(k[0], 0))?.[1];
        if (r.committed !== 10_000 && r.committed < 12_000 && end !== undefined && !near(end, r.committed, 1e-6)) bad.push(`edit boundary ${end} != ${r.committed} @${scale}/${fps}/${dxPx}`);
      }
    }
  }
  eq("6 zooms x 3 frame rates x 8 drags: the committed edge is exactly the position shown at release, and it is in the edit", bad.slice(0, 3), []);
}
{
  const r = drag({ scale: 0.05, fps: 30, moves: [-100], words: [] });
  eq("the position is on the frame grid (30 fps)", near(r.shown / (1000 / 30), Math.round(r.shown / (1000 / 30)), 1e-9), true);
  eq("an inward drag of 100 px at 0.05 px/ms is 2 s earlier (the distance travelled, in time)", Math.round(10_000 - r.shown), 2000);
  eq("roundToFrame (whole microseconds)", [roundToFrame(1010, 30), roundToFrame(1020, 30), roundToFrame(1000, 60)], [1000, 1033.333, 1000]);
  const s = startEdgeSession({ atMs: 10_000, startX: 200, offsetStart: 0, min: 0, max: 60_000, fps: 30, now: 0 });
  const first = moveEdge(s, { x: 200, offset: 0, scale: 0.05, now: 16, targets: [], params: snapParams(0.05) });
  eq("no jump on grab: until the finger has moved, the edge stays exactly where it was (even off the frame grid)", first.ms, 10_000);
  const slop = moveEdge(s, { x: 203, offset: 0, scale: 0.05, now: 32, targets: [], params: snapParams(0.05) });
  eq("...and the 3 pt of slop before the gesture starts are not lost: it is measured from where the finger went down", Math.round(slop.ms), Math.round(roundToFrame(10_000 + 3 / 0.05, 30)));
  eq("the timeline scrolling under the finger moves the edge the same distance", rawEdgeMs(s, 200, 80, 0.05), 10_000 + 80 / 0.05);
  const clamped = drag({ scale: 0.05, moves: [900] });
  eq("it cannot go past the end of the video or into the minimum piece", [clamped.shown <= 60_000, clamped.committed === clamped.shown], [true, true]);
  const inward = drag({ scale: 0.05, moves: [-3000] });
  ok("or past the start of its own clip (a 120 ms piece is the minimum)", inward.shown >= 120 - 1e-6);
}

// ── snapping: small, light, releasing, never across a word ──
{
  eq("8 pt on screen", SNAP_PX, 8);
  eq("zoomed in a snap is a few tens of ms; at the whole-video zoom never more than 150 ms", [Math.round(snapThresholdMs(0.5)), Math.round(snapThresholdMs(0.2)), snapThresholdMs(0.002), SNAP_MAX_MS], [16, 40, 150, 150]);
  const words = [{ startMs: 9400, endMs: 9700 }, { startMs: 9900, endMs: 10_080 }];
  const targets = buildSnapTargets(words, []);
  const p = snapParams(0.2, words);   // 40 ms
  let st = snapStart(9930, 0);
  let r = snapStep(st, 9930, 16, targets, p);
  eq("a target within the threshold catches (a light haptic) and holds the edge on it", [r.ms, r.caught], [9900, true]);
  r = snapStep(r.state, 9935, 32, targets, p);
  eq("it stays held while the finger stays near", r.ms, 9900);
  r = snapStep(r.state, 9990, 48, targets, p);
  eq("it lets go as soon as the finger moves past the threshold, and the edge is where the finger is", [r.ms, r.caught], [9990, false]);
  r = snapStep(snapStart(9800, 0), 9800, 16, targets, p);
  eq("a target farther than the threshold does not catch", [r.ms, r.caught], [9800, false]);
  eq("a whole word between two moments is detected; a word the finger is inside is not", [crossesWord(words, 9300, 9800), crossesWord(words, 9650, 9950)], [true, false]);
  const wide = snapParams(0.002, words);   // 150 ms
  r = snapStep(snapStart(9790, 0), 9790, 16, buildSnapTargets([{ startMs: 9400, endMs: 9700 }, { startMs: 9800, endMs: 9930 }], []), snapParams(0.002, [{ startMs: 9400, endMs: 9700 }, { startMs: 9800, endMs: 9930 }]));
  eq("(a word fully between the finger and the target blocks it; one the finger is inside does not)", r.ms, 9800);
  const wordsBetween = [{ startMs: 9500, endMs: 9600 }, { startMs: 9750, endMs: 9760 }];
  r = snapStep(snapStart(9480, 0), 9480, 16, buildSnapTargets(wordsBetween, []), snapParams(0.002, wordsBetween));
  eq("a snap that would jump over the word 9500-9600 to reach 9750 is refused; the near target is taken", r.ms, 9500);
  const withSnap = drag({ scale: 0.2, moves: [-12], words: [{ startMs: 9900, endMs: 9940 }] });
  eq("while dragging, the committed edge is the snapped frame that was shown", [withSnap.caught >= 1, near(withSnap.shown, withSnap.committed)], [true, true]);
}

// ── nothing moves the edge after the commit ──
{
  const DURS = DUR;
  let st = base();
  const edge = { side: "right", atMs: 10_000 };
  const d = describeEdgeDrag(st, edge, 8_637, DURS, 1);
  st = reshapeCutAtEdge(st, edge, d.clampedMs, DURS, 1);
  const boundary = () => keep(st).find((k) => k[0] === 0)[1];
  eq("committed", boundary(), d.clampedMs);
  // re-planning (a sensitivity change) with a plan that has a cut over the same footage
  const replanned = mergePlan(st, [makeDecision("silenceCut", 8_000, 12_000), makeDecision("silenceCut", 45_000, 46_000)], ["silenceCut"]).state;
  eq("a re-plan that finds a bigger silence around it does not move it", keep(replanned).find((k) => k[0] === 0)[1], d.clampedMs);
  // a laugh that is protected right there
  const withLaugh = mergePlan(replanned, [makeDecision("laughProtect", 8_500, 9_000)], ["laughProtect"]).state;
  eq("laugh protection does not move it (the creator's own cut is never held back)", keep(withLaugh).find((k) => k[0] === 0)[1], d.clampedMs);
  eq("the minimum-piece rule belongs to the planner, not to a committed edge", pieceRangesOf(withLaugh, DURS).length >= 2, true);
  // the sliver rule: a reveal that would leave a few ms of the cut is shown as the position it really lands on
  const sliver = describeEdgeDrag(base(), { side: "right", atMs: 10_000 }, 11_950, DURS, 1);
  const committed = reshapeCutAtEdge(base(), { side: "right", atMs: 10_000 }, sliver.clampedMs, DURS, 1);
  eq("dragging an edge out to within 50 ms of the end of a cut: the position shown is the one that lands (the sliver of the cut is restored with it, the clip joins the next)", [sliver.clampedMs, keep(committed)[0]], [12_000, [0, 30_000]]);
  const exactReveal = describeEdgeDrag(base(), { side: "right", atMs: 10_000 }, 11_000, DURS, 1);
  eq("a reveal that leaves a real piece of the cut lands exactly where shown", [exactReveal.clampedMs, keep(reshapeCutAtEdge(base(), { side: "right", atMs: 10_000 }, exactReveal.clampedMs, DURS, 1))[0][1]], [11_000, 11_000]);
  eq("the position given to the edit is a fixed point: asking again gives the same answer", describeEdgeDrag(base(), { side: "right", atMs: 10_000 }, sliver.clampedMs, DURS, 1).clampedMs, sliver.clampedMs);
}

// ── Part 2: a selected clip plays (loops) on its own ──
{
  const st = addSplit(base(), 4_000, DUR);
  const clips = renderClipsOf(st, DUR).map((c, i) => ({ id: `c${i}`, ...c }));
  const loop = clipLoopOf(clips, "c1");
  eq("the loop is the selected clip's source range and where it starts on the edit", [loop.srcStartMs, loop.srcEndMs, loop.outStartMs, loop.outEndMs], [4000, 10_000, 4000, 10_000]);
  eq("no clip, no loop", [clipLoopOf(clips, "nope"), clipLoopOf(clips, null)], [null, null]);
  eq("selecting: the playhead stays when it is inside the clip, else goes to the clip's start", [playheadOnSelect(loop, 6200), playheadOnSelect(loop, 1000), playheadOnSelect(loop, 10_000), playheadOnSelect(loop, 4000)], [6200, 4000, 4000, 4000]);
  eq("inside the clip it just plays", loopTick(loop, 7000), { kind: "play" });
  eq("a moment before the end it jumps back to the start (the footage after the clip is never shown)", loopTick(loop, 10_000 - CLIP_LOOP_LEAD_MS + 1), { kind: "wrap", seekToSourceMs: 4000 });
  eq("a player outside the clip is put at its start", [loopTick(loop, 20_000).kind, loopTick(loop, 100).kind], ["resync", "resync"]);
  // play the loop at 60 fps for 30 s: the player never reaches the end of the clip, and it never leaves its range
  let src = 4000, max = 0, min = Infinity, wraps = 0;
  for (let t = 0; t < 30_000; t += 1000 / 60) {
    const r = loopTick(loop, src);
    if (r.kind !== "play") { src = r.seekToSourceMs; wraps++; }
    max = Math.max(max, src);
    min = Math.min(min, src);
    src += 1000 / 60;
  }
  ok(`looping for 30 s: ${wraps} wraps, the player stays inside the clip (${Math.round(min)}-${Math.round(max)} of 4000-10000)`, max < 10_000 && min >= 4000 && wraps >= 4);
  const tiny = loopOfSegment({ index: 0, id: "t", srcStartMs: 1000, srcEndMs: 1060, outStartMs: 0, outEndMs: 60 });
  eq("a very short clip loops at its end (the lead is at most half of it)", loopTick(tiny, 1035).kind, "wrap");
  // tap off
  eq("tapping off keeps the moment and the play state", [tapOff({ positionMs: 6200, isPlaying: true }), tapOff({ positionMs: 6200, isPlaying: false })], [{ positionMs: 6200, isPlaying: true, seek: false }, { positionMs: 6200, isPlaying: false, seek: false }]);
  // editing the selected clip's edge updates the loop
  const trimmed = reshapeCutAtEdge(st, { side: "right", atMs: 10_000 }, 9_000, DUR, 1);
  const clips2 = renderClipsOf(trimmed, DUR).map((c, i) => ({ id: `n${i}`, ...c }));
  const old = { srcStartMs: 4000, srcEndMs: 10_000 };
  const nextRanges = clips2.map((c) => ({ srcStartMs: c.trimStartMs, srcEndMs: c.trimEndMs }));
  const succ = selectionSuccessor(old, nextRanges, 5000);
  eq("after an edge is dragged the selected clip is its successor, and the loop is the new range", [succ >= 0, clipLoopOf(clips2, clips2[succ].id).srcEndMs], [true, 9000]);
  eq("deleting the selected clip leaves no successor (the selection ends)", selectionSuccessor(old, [{ srcStartMs: 0, srcEndMs: 4000 }, { srcStartMs: 12_000, srcEndMs: 30_000 }]), -1);
  eq("splitting the selected clip keeps the half under the playhead", selectionSuccessor(old, [{ srcStartMs: 4000, srcEndMs: 7000 }, { srcStartMs: 7000, srcEndMs: 10_000 }], 8000), 1);
  eq("an unchanged clip is its own successor", selectionSuccessor(old, [{ srcStartMs: 0, srcEndMs: 4000 }, { srcStartMs: 4000, srcEndMs: 10_000 }]), 1);
  eq("the loop table is the same one the playback uses", buildSegments(clips).find((s) => s.id === "c1").srcEndMs, 10_000);
}

// ── the screens ──
{
  const edit = read("../app/edit.tsx");
  const tl = read("../components/PrecisionTimeline.tsx");
  ok("selecting a clip loads and renders nothing: it seeks the same players inside the source", /const handleSelectPiece[\s\S]{0,1400}handleSeek\(at\)/.test(edit) && !/handleSelectPiece[\s\S]{0,1400}(replace\(|renderAsync|resetPlayer)/.test(edit.slice(edit.indexOf("const handleSelectPiece"), edit.indexOf("const handleSelectPiece") + 1400)));
  ok("a selected clip never plays the rendered file or the two-player swap", /!clipMode &&\s*previewModeFor/.test(edit) && /!previewMode && !clipMode/.test(edit));
  ok("the loop jumps back before the clip's end with the player that is playing (loopTick, every frame)", /loopTick\(loop, player\.currentTime \* 1000\)/.test(edit) && /requestAnimationFrame\(tick\)/.test(edit));
  ok("tapping the video, or the empty timeline, ends the clip mode without a seek, a reload or a play-state change", /if \(clipMode\) \{\s*handleClearSelection\(\);/.test(edit) && /onDeselectAndPreview=\{handleClearSelection\}/.test(edit));
  ok("replay restarts the selected clip, not the video", /clipModeRef\.current \? virtualSegsRef\.current\.find/.test(edit));
  ok("an edit keeps the selection on the clip's successor, so dragging its edge updates the loop", /selectionSuccessor\(range\(before\)/.test(edit));
  ok("the edge preview player is exact (zero tolerance), chases the latest seek while dragging, is loaded when a clip is selected, and ends with a final exact seek", /toleranceBefore: 0, toleranceAfter: 0/.test(edit) && /scrubbingModeEnabled: true/.test(edit) && /edgePlayer\.replace\(uri\);\s*edgePlayer\.pause\(\)/.test(edit) && /cfg\.onEdgePreview\?\.\(drag\.clampedMs\);\s*cfg\.onDragEnd/.test(tl));
  ok("the drag is relative to where the finger went down and the commit uses the last finger position", /touchX: e\.x/.test(tl) && /d\.x = finalX/.test(tl) && /session\.ms/.test(tl));
  ok("crash-safe: gestures run on the JS thread, nothing new on the UI thread", (tl.match(/Gesture\.(Pan|Tap|Pinch)\(\)/g) ?? []).length === (tl.match(/Gesture\.(Pan|Tap|Pinch)\(\)\s*\.runOnJS\(true\)/g) ?? []).length && !/['"]worklet['"]|runOnUI|useAnimatedReaction|useFrameCallback/.test(tl));
}


// ── a new plan never moves an edge the creator set ──
{
  const edgeState = reshapeCutAtEdge(base(), { side: "right", atMs: 10_000 }, 8_637, DUR, 1);
  const plan = [makeDecision("silenceCut", 8_000, 12_000), makeDecision("silenceCut", 20_000, 21_000), makeDecision("silenceCut", 50_000, 52_000)];
  const merged = mergePlan(edgeState, plan, ["silenceCut"]);
  eq("the plan keeps its length and order (the Review sheet's switches match it by position)", merged.resolved.length, plan.length);
  eq("the planned cut that reached into the footage beside the creator's edge is trimmed to start at it", [merged.resolved[0].sourceStartMs, merged.resolved[0].sourceEndMs], [8_637, 12_000]);
  eq("cuts elsewhere are untouched", [merged.resolved[1].sourceStartMs, merged.resolved[2].sourceStartMs], [20_000, 50_000]);
  eq("the creator's edge is still where they put it", keep(merged.state)[0], [0, 8_637]);
  const flush = mergePlan(edgeState, [makeDecision("silenceCut", 8_000, 8_637)], ["silenceCut"]);
  eq("a planned cut that only extends the edge into the kept footage beside it does nothing", [flush.resolved[0].state, keep(flush.state)[0]], ["reverted", [0, 8_637]]);
  const rightEdge = reshapeCutAtEdge(base(), { side: "left", atMs: 12_000 }, 13_500, DUR, 1);
  const right = mergePlan(rightEdge, [makeDecision("silenceCut", 10_000, 16_000)], ["silenceCut"]);
  eq("the same on the other side of a cut (the start of the next clip)", keep(right.state)[1][0], 13_500);
  const untouched = mergePlan(base(), plan, ["silenceCut"]);
  eq("without a creator's edge a plan is exactly what it was", untouched.resolved.map((d) => d.id), plan.map((d) => d.id));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
