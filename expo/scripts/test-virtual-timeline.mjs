#!/usr/bin/env node
/**
 * The Cuts screen's virtual timeline: the preview plays the source through the edit list, nothing is rendered while
 * editing. Edited <-> source time, the skip logic, the playhead while playing, split / delete, and the fixed-centre
 * (CapCut style) timeline.
 *   node --experimental-strip-types --no-warnings scripts/test-virtual-timeline.mjs
 */
import { readFileSync } from "node:fs";
import {
  SKIP_LEAD_MS, buildSegments, canSplitAt, editedFromPlayer, editedToSource, followPlayhead, interpolatePosition, playbackTick, seamTargets, segmentAtEdited, sourceToEdited, totalEditedMs,
} from "../lib/autoEdit/virtualTimeline.ts";
import { addManualCut, addSplit, keepRangesOf, makeDecision, newEditState, pieceRangesOf, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { describeEdgeDrag, reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { planDeletePart } from "../lib/autoEdit/deletePart.ts";
import { timelineMatchesState } from "../lib/autoEdit/confirm.ts";
import { buildSeamHandles } from "../lib/autoEdit/seams.ts";
import { buildCaptionLines } from "../lib/transcription/captionLines.ts";
import { TL_PAD, TOOLBAR_H, clampCenterOffset, flingStep, fitScale, msAtCenter, offsetForCenter, toolbarRects } from "../lib/autoEdit/timelineView.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const clips = [
  { id: "a", uri: "u", trimStartMs: 0, trimEndMs: 2000 },
  { id: "b", uri: "u", trimStartMs: 5000, trimEndMs: 8000 },
  { id: "c", uri: "u", trimStartMs: 9000, trimEndMs: 10_000 },
];
const segs = buildSegments(clips);

// ── time mapping ──
{
  eq("the segment table: source ranges and where they sit on the edited timeline", segs.map((s) => [s.srcStartMs, s.srcEndMs, s.outStartMs, s.outEndMs]), [[0, 2000, 0, 2000], [5000, 8000, 2000, 5000], [9000, 10_000, 5000, 6000]]);
  eq("the edited length is the sum of the kept ranges", totalEditedMs(segs), 6000);
  eq("a clip with no end means 'to the end of the file'", buildSegments([{ id: "x", trimStartMs: 100, trimEndMs: 0, durationMs: 900 }])[0].srcEndMs, 900);
  eq("edited -> source", [0, 1999, 2000, 3500, 5999].map((t) => editedToSource(segs, t).sourceMs), [0, 1999, 5000, 6500, 9999]);
  eq("past the end maps to the end, before the start to the start", [editedToSource(segs, 99_999).sourceMs, editedToSource(segs, -5).sourceMs], [10_000, 0]);
  eq("source -> edited", [0, 1999, 5000, 7999, 9000, 9500].map((t) => sourceToEdited(segs, t).editedMs), [0, 1999, 2000, 4999, 5000, 5500]);
  eq("a moment inside a removed range lands on the seam (the start of the next kept range)", [sourceToEdited(segs, 3000), sourceToEdited(segs, 8500)], [{ editedMs: 2000, segment: 1, removed: true }, { editedMs: 5000, segment: 2, removed: true }]);
  eq("after the last range it lands on the end", sourceToEdited(segs, 12_000), { editedMs: 6000, segment: 2, removed: true });
  ok("every kept moment maps there and back", (() => { for (let t = 0; t < 6000; t += 7) { const s = editedToSource(segs, t); if (Math.abs(sourceToEdited(segs, s.sourceMs).editedMs - t) > 1e-9) return false; } return true; })());
  eq("segmentAtEdited", [0, 1999, 2000, 5999, 6000, 7000].map((t) => segmentAtEdited(segs, t)), [0, 0, 1, 2, 2, 2]);
  eq("the playhead from the player, held inside its segment", [editedFromPlayer(segs, 1, 5000), editedFromPlayer(segs, 1, 6500), editedFromPlayer(segs, 1, 9999), editedFromPlayer(segs, 1, 100)], [2000, 3500, 5000, 2000]);
}

// ── skipping removed ranges during playback ──
{
  eq("inside the range it just plays (and reports the edited time)", playbackTick({ segs, activeIndex: 1, sourceMs: 6000 }), { kind: "play", editedMs: 3000 });
  eq("a moment before the end it hands over to the next range, seeking past the removed part", playbackTick({ segs, activeIndex: 0, sourceMs: 2000 - SKIP_LEAD_MS + 1 }), { kind: "advance", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000 });
  eq("...not earlier", playbackTick({ segs, activeIndex: 0, sourceMs: 2000 - SKIP_LEAD_MS - 1 }).kind, "play");
  eq("the lead is a parameter", playbackTick({ segs, activeIndex: 0, sourceMs: 1900, leadMs: 150 }).kind, "advance");
  eq("the last range ending is the end of the edit", playbackTick({ segs, activeIndex: 2, sourceMs: 9990 }), { kind: "end", editedMs: 6000 });
  const split = buildSegments([{ id: "p", trimStartMs: 0, trimEndMs: 3000 }, { id: "q", trimStartMs: 3000, trimEndMs: 6000 }]);
  eq("pieces that continue where the last ended need no seek at all (a split)", playbackTick({ segs: split, activeIndex: 0, sourceMs: 2990 }), { kind: "advance", toIndex: 1, seekToSourceMs: null, editedMs: 3000 });
  eq("the seeks are known ahead (pre-armed): one per removed part, none at a split", [seamTargets(segs), seamTargets(split)], [[5000, 9000], [null]]);
  eq("a player that ended up inside a removed part is sent to the next kept range", playbackTick({ segs, activeIndex: 0, sourceMs: 3500 }), { kind: "resync", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000 });
  eq("a player before its range is put at its start", playbackTick({ segs, activeIndex: 1, sourceMs: 4000 }), { kind: "resync", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000 });
  eq("a player far ahead, in another kept range, continues there", playbackTick({ segs, activeIndex: 0, sourceMs: 9500 }), { kind: "resync", toIndex: 2, seekToSourceMs: 9500, editedMs: 5500 });
  eq("no segments is the end", playbackTick({ segs: [], activeIndex: 0, sourceMs: 0 }).kind, "end");

  // simulate playing the whole edit at 60 fps, the way the loop does
  const sim = (list, fps = 60) => {
    const table = buildSegments(list);
    let active = 0, src = table[0].srcStartMs, edited = [], seeks = [], playedRemoved = 0, steps = 0;
    const removed = (ms) => !table.some((s) => ms >= s.srcStartMs && ms < s.srcEndMs);
    for (;;) {
      src += 1000 / fps;
      steps++;
      const t = playbackTick({ segs: table, activeIndex: active, sourceMs: src });
      if (t.kind === "end") break;
      if (t.kind === "advance") { active = t.toIndex; if (t.seekToSourceMs !== null) { seeks.push(t.seekToSourceMs); src = t.seekToSourceMs; } continue; }
      if (t.kind === "play") { edited.push(t.editedMs); if (removed(src)) playedRemoved++; }
      if (steps > 100_000) throw new Error("did not end");
    }
    return { edited, seeks, playedRemoved, total: totalEditedMs(table) };
  };
  const r = sim(clips);
  eq("playing the edit: one seek per removed part", r.seeks, [5000, 9000]);
  eq("...no cut-out footage is ever played", r.playedRemoved, 0);
  ok("...and the playhead (edited time) only moves forward", r.edited.every((v, i) => i === 0 || v >= r.edited[i - 1] - 1e-9));
  ok("...to the end of the edit, within the lead", Math.abs(r.edited[r.edited.length - 1] - r.total) <= SKIP_LEAD_MS + 20);
  eq("a split plays straight through without a seek", sim([{ id: "p", trimStartMs: 0, trimEndMs: 3000 }, { id: "q", trimStartMs: 3000, trimEndMs: 6000 }]).seeks, []);
}

// ── the playhead between progress events ──
{
  eq("it moves on at normal speed while playing", interpolatePosition(1000, 5000, 5250, true, 9000), 1250);
  eq("paused, it stays", interpolatePosition(1000, 5000, 5250, false, 9000), 1000);
  eq("never past the end, never before the start", [interpolatePosition(8900, 0, 500, true, 9000), interpolatePosition(-50, 0, 0, false, 9000)], [9000, 0]);
  eq("the display follows a nearby target smoothly", followPlayhead(1000, 1100), 1045);
  eq("...and jumps when the target jumped (a seek, a seam)", followPlayhead(1000, 4000), 4000);
  eq("an exact target (ease 1) is reached at once", followPlayhead(1000, 1100, 250, 1), 1100);
  ok("a stream of progress events 200 ms apart gives a continuous playhead (a step every frame, none larger than the frame)", (() => {
    let shown = 0, last = 0, maxStep = 0;
    for (let frame = 0; frame < 120; frame++) {
      const now = frame * 16.7;
      const anchorAt = Math.floor(now / 200) * 200;   // the last event
      const target = interpolatePosition(anchorAt, anchorAt, now, true, 99_999);
      shown = followPlayhead(shown, target);
      maxStep = Math.max(maxStep, Math.abs(shown - last));
      last = shown;
    }
    return maxStep < 40;
  })());
}

// ── split and delete are edits of the edit list ──
{
  const DUR = 20_000;
  const st = newEditState("u", [makeDecision("silenceCut", 8000, 9000)]);
  const keep = (x) => keepRangesOf(x, DUR).map((k) => [k.startMs, k.endMs]);
  const pieces = (x) => pieceRangesOf(x, DUR).map((k) => [k.startMs, k.endMs]);
  const sp = addSplit(st, 4000, DUR);
  eq("a split cuts nothing: the kept footage is the same", keep(sp), keep(st));
  eq("...but the clip is two pieces on the timeline", pieces(sp), [[0, 4000], [4000, 8000], [9000, 20_000]]);
  eq("the clips of the edit list are the pieces", renderClipsOf(sp, DUR).map((c) => [c.trimStartMs, c.trimEndMs]), pieces(sp));
  eq("a split too close to an end, in a removed part, or next to another split is refused (the same state: no undo step)", [addSplit(st, 30, DUR) === st, addSplit(st, 8500, DUR) === st, addSplit(sp, 4040, DUR) === sp, addSplit(st, 8000 - 79, DUR) === st, addSplit(st, NaN, DUR) === st], [true, true, true, true, true]);
  eq("splits can be many and stay sorted", pieces(addSplit(addSplit(sp, 12_000, DUR), 2000, DUR)).map((p) => p[0]), [0, 2000, 4000, 9000, 12_000]);
  ok("the timeline matches the state with pieces (no 'manual edits' warning)", timelineMatchesState(renderClipsOf(sp, DUR).map((c, i) => ({ ...c, id: String(i) })), sp, DUR));
  // one undo step
  let h = emptyHistory();
  h = pushEdit(h, st);
  const u = undoEdit(h, sp);
  eq("undo removes the split exactly, redo brings it back", [u.state === st, pieces(redoEdit(u.history, u.state).state)], [true, pieces(sp)]);
  // delete the selected piece
  const list = renderClipsOf(sp, DUR).map((c, i) => ({ id: `c${i}`, ...c }));
  const plan = planDeletePart({ clips: list, clipId: "c1", model: { state: sp, durationMs: DUR }, matches: true });
  eq("deleting a piece is a cut of just that piece", [plan.kind, keep(plan.next), pieces(plan.next)], ["user-cut", [[0, 4000], [9000, 20_000]], [[0, 4000], [9000, 20_000]]]);
  eq("...the first piece too", keep(planDeletePart({ clips: list, clipId: "c0", model: { state: sp, durationMs: DUR }, matches: true }).next), [[4000, 8000], [9000, 20_000]]);
  eq("the last remaining piece cannot be deleted", planDeletePart({ clips: [list[0]], clipId: "c0", model: { state: st, durationMs: DUR }, matches: true }), { kind: "blocked", reason: "last-part" });
  // Reset to AI edit replaces the state (and with it the splits)
  const reset = { ...newEditState("u", [makeDecision("silenceCut", 8000, 9000)]), captionStyle: undefined };
  eq("Reset to AI edit brings back the single clip", pieces(reset), [[0, 8000], [9000, 20_000]]);
  // captions follow: a word inside a deleted piece disappears
  const words = [{ text: "one", startMs: 500, endMs: 900 }, { text: "two", startMs: 4500, endMs: 4900 }, { text: "three", startMs: 10_000, endMs: 10_400 }];
  const text = (x) => buildCaptionLines(words, {}, keepRangesOf(x, DUR), null).map((l) => l.text).join(" ");
  eq("captions stay in sync with a deleted piece", [text(sp), text(plan.next)], ["one two three", "one three"]);
  // trimming a piece at a split
  const handles = buildSeamHandles(renderClipsOf(sp, DUR).map((c, i) => ({ id: `c${i}`, ...c })), "u");
  eq("a split has a handle on each side (both at the same moment)", handles.filter((x) => x.prev && x.next).map((x) => [x.prev.atMs, x.next.atMs]), [[4000, 4000], [8000, 9000]]);
  const inward = reshapeCutAtEdge(sp, { side: "right", atMs: 4000 }, 3000, DUR);
  eq("dragging the end of the first piece inward trims it (a new cut next to the split)", keep(inward), [[0, 3000], [4000, 8000], [9000, 20_000]]);
  const leftIn = reshapeCutAtEdge(sp, { side: "left", atMs: 4000 }, 5000, DUR);
  eq("...and the start of the second piece too", keep(leftIn), [[0, 4000], [5000, 8000], [9000, 20_000]]);
  eq("outward at a split brings nothing back (the footage is already there): no change, no undo step", [reshapeCutAtEdge(sp, { side: "right", atMs: 4000 }, 5000, DUR) === sp, reshapeCutAtEdge(sp, { side: "left", atMs: 4000 }, 3000, DUR) === sp, describeEdgeDrag(sp, { side: "left", atMs: 4000 }, 1000, DUR).clampedMs], [true, true, 4000]);
  eq("an edge of a clip next to a cut still brings footage back as before", keep(reshapeCutAtEdge(st, { side: "right", atMs: 8000 }, 8500, DUR)), [[0, 8500], [9000, 20_000]]);
  // one undo step brings the trimmed footage back
  eq("undo of the trim restores", undoEdit(pushEdit(emptyHistory(), sp), inward).state === sp, true);
}

// ── the fixed-centre timeline ──
{
  const W = 360, total = 30_000, fit = fitScale(total, W);
  eq("the time under the centre line and the offset that puts it there are inverses", [12_345, 0, 30_000].map((ms) => Math.round(msAtCenter(offsetForCenter(ms, fit * 3, W), fit * 3, W))), [12_345, 0, 30_000]);
  eq("the start of the video sits under the centre line at offset 'start'", offsetForCenter(0, fit, W), TL_PAD - W / 2);
  eq("the scroll range is the video itself: start under the line .. end under the line", [clampCenterOffset(-9999, total, fit, W), clampCenterOffset(9999, total, fit, W)], [offsetForCenter(0, fit, W), offsetForCenter(total, fit, W)]);
  const lo = offsetForCenter(0, fit, W);
  const step = flingStep(5 - 0, 3000, 0.016, total * fit);
  ok("a fling over the centre range stops at the ends", flingStep(total * fit - 1, 5000, 0.05, total * fit).done && step.offset > 5);
  const rects = toolbarRects(W, 3, 116);
  ok("three big toolbar buttons side by side, each at least 48 pt tall, inside the screen", rects.length === 3 && rects.every((r) => r.h >= 48 && r.x >= 12 && r.x + r.w <= W - 12 && r.w >= 80) && TOOLBAR_H >= 64);
  eq("two buttons share the width the same way", toolbarRects(W, 2, 116).map((r) => Math.round(r.w)), [163, 163]);
  ok("a playhead while playing reaches the centre: the timeline moves, not the playhead", (() => { let o = lo; for (let t = 0; t <= 30_000; t += 500) o = offsetForCenter(t, fit * 4, W); return Math.round(msAtCenter(o, fit * 4, W)) === 30_000; })());
}

// ── the screen ──
{
  const edit = read("../app/edit.tsx");
  const tl = read("../components/PrecisionTimeline.tsx");
  ok("nothing is rendered while the cuts are edited: the renders hold on the Cuts screen and start when it is left", /hold: captionsBusy \|\| mergeUi\.kind !== "idle" \|\| step === "cuts"/.test(edit));
  ok("the Cuts screen never plays a rendered preview and never waits for one", /const previewMode = step !== "cuts" && previewModeFor/.test(edit) && /const waitForPreview = step !== "cuts" && aheadBusy/.test(edit));
  ok("a cut changes the edit list without resetting the player (soft commit): no pause, no re-seek unless its moment was cut out", /softReplaceClips\(nextClips, newPosition\)/.test(edit) && /Math\.abs\(player\.currentTime \* 1000 - wantedMs\) > 40/.test(edit));
  ok("unchanged pieces keep their clip, so selection and keys survive an edit", /reuse\(c\) \?\? \{ \.\.\.base/.test(edit));
  ok("the playback loop watches the player every frame and skips removed ranges (playbackTick)", /requestAnimationFrame\(tick\)/.test(edit) && /playbackTick\(\{ segs: virtualSegsRef\.current/.test(edit));
  ok("the playhead is read from the player (getPositionMs) and the timeline knows when it plays", /getPositionMs=\{samplePlayheadMs\}/.test(edit) && /isPlaying=\{isPlaying\}/.test(edit));
  ok("selecting a clip on the timeline does not move the playhead or limit playback to it", /const handleSelectPiece[\s\S]{0,300}isIsolatedRef\.current = false/.test(edit) && /onSelectClip=\{handleSelectPiece\}/.test(edit));
  ok("Split and Delete go through the reversible edit", /const handleSplitAtPlayhead[\s\S]{0,700}userEdit\(\(\) => next\)/.test(edit) && /const handleDeleteSelected[\s\S]{0,900}userEdit\(\(\) => plan\.next\)/.test(edit));
  ok("the old Trim / Split / Delete rows are hidden while the precision timeline owns them", /!\(timelineSeams && precisionOn\)/.test(edit));
  ok("the playhead is fixed at the centre of the timeline", /styles\.playhead, \{ left: viewW \/ 2 - 1 \}/.test(tl) && !/playMs/.test(tl));
  ok("scrolling scrubs (throttled seeks), playing scrolls the timeline every frame", /scrub\(false\)/.test(tl) && /SCRUB_EVERY_MS/.test(tl) && /interpolatePosition\(propPos/.test(tl) && /getPositionMs\?\.\(\)/.test(tl));
  ok("a lost touch cannot freeze the playhead", /TOUCH_STALE_MS/.test(tl));
  ok("the bottom toolbar: Split, Delete and (with a cut chip selected) Restore, big rounded buttons", /label="Split"/.test(tl) && /label="Delete"/.test(tl) && /chipMarker \? 3 : 2/.test(tl) && /toolButton: \{[^}]*borderRadius: 24/.test(tl));
  ok("the long-press range selection is gone", !/activateAfterLongPress|rangePan|rangeFill/.test(tl));
  ok("crash-safe pattern: every gesture runOnJS(true); no worklets, reactions or UI-thread callbacks", (tl.match(/Gesture\.(Pan|Tap|Pinch)\(\)/g) ?? []).length === (tl.match(/Gesture\.(Pan|Tap|Pinch)\(\)\s*\.runOnJS\(true\)/g) ?? []).length && !/['"]worklet['"]|useAnimatedReaction|useFrameCallback|runOnUI|useDerivedValue/.test(tl));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
