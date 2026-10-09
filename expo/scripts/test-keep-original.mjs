#!/usr/bin/env node
/**
 * Keep original / no active cuts: the source file plays directly, one seek, play state kept, undo returns to the cuts.
 *   node --experimental-strip-types --no-warnings scripts/test-keep-original.mjs
 */
import { readFileSync } from "node:fs";
import { addManualCut, makeDecision, newEditState, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { cutCategoriesOff } from "../lib/autoEdit/editPanel.ts";
import { exitPreviewPlan, isPlayingWholeSource } from "../lib/autoEdit/noCuts.ts";
import { redoEdit, undoEdit, pushEdit, emptyHistory } from "../lib/autoEdit/history.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const DUR = 60000;
const cut = (s, e) => makeDecision("silenceCut", s, e);
const edited = newEditState("v.mov", [cut(5000, 7000), cut(20000, 22000), makeDecision("umCut", 30000, 30400)]);
const whole = [{ id: "a", uri: "v.mov", trimStartMs: 0, trimEndMs: DUR, durationMs: DUR }];

// ── no cuts = the source directly ──
{
  const kept = cutCategoriesOff(edited);
  eq("Keep original leaves one clip: the whole source", renderClipsOf(kept, DUR).map((c) => [c.trimStartMs, c.trimEndMs]), [[0, DUR]]);
  ok("with no cut active the timeline plays the source file directly (no preview render)", isPlayingWholeSource(whole, kept, DUR));
  ok("also when the player's length differs a little from the audio's (within 400 ms)", isPlayingWholeSource([{ ...whole[0], trimEndMs: DUR - 120 }], kept, DUR));
  ok("not while any cut is active (the normal rendered preview)", !isPlayingWholeSource(renderClipsOf(edited, DUR).map((c, i) => ({ id: `c${i}`, uri: c.uri, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs })).slice(0, 1), edited, DUR));
  ok("not when the creator's own deletion is still in force (it survives Keep original)", !isPlayingWholeSource(whole, addManualCut(kept, 1000, 2000), DUR));
  ok("not when the timeline is trimmed by hand", !isPlayingWholeSource([{ ...whole[0], trimStartMs: 3000 }], kept, DUR));
  ok("not for several clips, another file, or no model", !isPlayingWholeSource([whole[0], whole[0]], kept, DUR) && !isPlayingWholeSource([{ ...whole[0], uri: "other.mov" }], kept, DUR) && !isPlayingWholeSource(whole, null, DUR));
}

// ── undo / re-enable cuts returns to the normal preview ──
{
  const kept = cutCategoriesOff(edited);
  const h = pushEdit(emptyHistory(), edited);
  const undone = undoEdit(h, kept);
  eq("undo restores the cut state (cuts active again, so the normal preview is rendered and played)", [undone.state === edited, renderClipsOf(undone.state, DUR).length], [true, 4]);
  const cutsClips = renderClipsOf(undone.state, DUR).map((c, i) => ({ id: `c${i}`, uri: c.uri, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));
  ok("(and it is no longer 'whole source')", !isPlayingWholeSource(cutsClips, undone.state, DUR));
  const redone = redoEdit(undone.history, undone.state);
  ok("redo goes back to the source directly", isPlayingWholeSource(whole, redone.state, DUR));
}

// ── one seek, play state kept ──
{
  // Replay the timers of an edit: the decision change (seek at +50 ms, resume at +110 ms) and the preview-exit effect (+0 ms,
  // restore at +60 ms), for both orderings of "was playing".
  function run(wasPlaying, flight) {
    const seeks = [];
    let playing = false;           // the edit set it to false
    const events = [];
    // the edit
    events.push({ at: 50, f: () => seeks.push("edit") });
    if (wasPlaying) events.push({ at: 110, f: () => { playing = true; } });
    // leaving the preview (runs at +0 with whatever isPlaying is then: false, the edit has just paused)
    const plan = exitPreviewPlan({ commitInFlight: flight, isPlaying: false });
    if (plan.seek) events.push({ at: 0, f: () => seeks.push("exit") });
    if (plan.resumeTo !== null) events.push({ at: 60, f: () => { playing = plan.resumeTo; } });
    events.sort((a, b) => a.at - b.at).forEach((e) => e.f());
    return { seeks, playing };
  }
  eq("without the guard (the old behaviour) the edit and the preview exit both seek: two seeks, two competing play-state writes", run(true, false).seeks.length, 2);
  eq("an edit in flight: exactly one seek, and it resumes because it was playing", [run(true, true).seeks, run(true, true).playing], [["edit"], true]);
  eq("it was paused: one seek, and it stays paused", [run(false, true).seeks, run(false, true).playing], [["edit"], false]);
  eq("leaving the preview for any other reason keeps the old behaviour (seek and restore the play state)", [exitPreviewPlan({ commitInFlight: false, isPlaying: true }), exitPreviewPlan({ commitInFlight: false, isPlaying: false })], [{ seek: true, resumeTo: true }, { seek: true, resumeTo: false }]);
  eq("an edit in flight does neither", exitPreviewPlan({ commitInFlight: true, isPlaying: true }), { seek: false, resumeTo: null });
}

// ── wiring ──
{
  const edit = read("../app/edit.tsx");
  ok("the preview render is skipped when no cut is active, and the editor never waits for it", /const noCuts = isPlayingWholeSource\(clips, editModel\?\.state/.test(edit) && /isRoot: args\.isRoot && !noCuts/.test(edit) && /!roughPlay && !noCuts/.test(edit));
  ok("the render for Post is not affected (captions are still burned in, the original is posted when nothing is cut)", /finalRef\.current\?\.update\(\{ \.\.\.args, captions: captions\.overlays \}\)/.test(edit));
  const rap = read("../lib/renderAtPost.ts");
  ok("Post: a single untrimmed clip with no captions posts the original; with captions it is rendered", /return "no cuts";\s*\n\s*if \(!isVideoRenderAvailable/.test(rap) && /clips\.length > 1 \|\| clips\.some\(isTrimmed\) \|\| args\.hasOverlays/.test(rap));
  ok("the edit seeks once: replaceClips' pending seek and start-trim seek are dropped, handleSeek clears any left", /pendingSeekRef\.current = null;\s*\n\s*trimSeekDoneRef\.current = true;/.test(edit) && /pendingSeekRef\.current = null;\s*\n\s*if \(videoRef\.current\) videoRef\.current\.currentTime = sourcePos/.test(edit));
  ok("leaving the preview does not seek or resume a second time while the edit is doing it", /exitPreviewPlan\(\{ commitInFlight: commitInFlightRef\.current/.test(edit) && /commitInFlightRef\.current = true;/.test(edit) && /commitInFlightRef\.current = false;/.test(edit));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
