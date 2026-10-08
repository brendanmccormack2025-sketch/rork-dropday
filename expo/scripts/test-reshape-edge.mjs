#!/usr/bin/env node
/**
 * Part B: dragging a clip edge to recover footage goes through the decision model (reshapeCutAtEdge).
 *   node --experimental-strip-types scripts/test-reshape-edge.mjs
 */
import { readFileSync } from "node:fs";
import {
  addManualCut, effectiveCutRanges, keepRangesOf, makeDecision, mergePlan, newEditState, setCategoryEnabled,
} from "../lib/autoEdit/decisions.ts";
import { aiBoundariesOf, crossedBoundary, describeEdgeDrag, reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { emptyHistory, pushEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { buildSeamHandles, remapOverlayTimes } from "../lib/autoEdit/seams.ts";
import { timelineMatchesState } from "../lib/autoEdit/confirm.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const DUR = 10000;
const cut = (s, e, extra = {}) => makeDecision("silenceCut", s, e, extra);
const keep = (st) => keepRangesOf(st, DUR).map((k) => [k.startMs, k.endMs]);
// kept: 0-1000 | cut 1000-2000 | 2000-5000 | cut 5000-6000 | 6000-10000
const base = () => newEditState("v.mov", [cut(1000, 2000), cut(5000, 6000)]);

// ── reveal part of a cut ──
{
  const s = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 1400, DUR);
  eq("dragging a clip's right edge out shows more footage, only from the adjacent cut", keep(s), [[0, 1400], [2000, 5000], [6000, 10000]]);
  const l = reshapeCutAtEdge(base(), { side: "left", atMs: 2000 }, 1500, DUR);
  eq("the left edge of the next clip reveals from the other side", keep(l), [[0, 1000], [1500, 5000], [6000, 10000]]);
  eq("the other cut is untouched", effectiveCutRanges(s), [{ startMs: 1400, endMs: 2000 }, { startMs: 5000, endMs: 6000 }]);
  ok("what is left of the cut belongs to the creator (survives a re-plan)", s.decisions.some((d) => d.origin === "user" && d.state === "applied" && d.sourceStartMs === 1400 && d.sourceEndMs === 2000));
  ok("the footage that came back is a reverted decision (tombstone)", s.decisions.some((d) => d.state === "reverted" && d.sourceStartMs === 1000 && d.sourceEndMs === 1400));
}

// ── reveal all of a cut ──
{
  const s = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 2000, DUR);
  eq("revealing the whole cut joins the two clips", keep(s), [[0, 5000], [6000, 10000]]);
  const t = s.decisions.filter((d) => d.state === "reverted");
  eq("the cut is kept as a tombstone", t.map((d) => [d.sourceStartMs, d.sourceEndMs]), [[1000, 2000]]);
  const re = mergePlan(s, [cut(1000, 2000), cut(5000, 6000)], ["silenceCut"]).state;
  eq("a re-plan never cuts it again", keep(re), [[0, 5000], [6000, 10000]]);
  const shifted = mergePlan(s, [cut(1040, 2060), cut(5000, 6000)], ["silenceCut"]).state;
  eq("not even when a sensitivity change moves the cut's edges", keep(shifted), [[0, 5000], [6000, 10000]]);
}

// ── continuing into the next cut ──
{
  const s = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 5500, DUR);
  eq("a drag that keeps going reveals the next cut too, and stops where the finger does", keep(s), [[0, 5500], [6000, 10000]]);
  const stop = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 2000, DUR);
  eq("a drag that stops at the end of the cut leaves the next cut alone", effectiveCutRanges(stop), [{ startMs: 5000, endMs: 6000 }]);
}

// ── dragging inward cuts more ──
{
  const s = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 600, DUR);
  eq("an inward drag cuts that footage", keep(s), [[0, 600], [2000, 5000], [6000, 10000]]);
  const l = reshapeCutAtEdge(base(), { side: "left", atMs: 2000 }, 2800, DUR);
  eq("from the left edge too", keep(l), [[0, 1000], [2800, 5000], [6000, 10000]]);
  eq("it is the creator's cut: it stays when the automatic cuts are switched off", keep(setCategoryEnabled(s, "silenceCut", false)), [[0, 600], [1000, 10000]]);
  const back = reshapeCutAtEdge(s, { side: "right", atMs: 600 }, 1000, DUR);
  eq("and can be dragged back out again", keep(back), [[0, 1000], [2000, 5000], [6000, 10000]]);
}

// ── survives sensitivity changes (re-plan with other cuts) ──
{
  const s = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 1400, DUR);
  const re = mergePlan(s, [cut(900, 2100), cut(5000, 6000)], ["silenceCut"]).state;
  ok("a re-plan keeps the footage the creator got back", keep(re).some(([a, b]) => a <= 1100 && b >= 1400));
  ok("and the creator's remaining cut", effectiveCutRanges(re).some((r) => r.startMs <= 1400 && r.endMs >= 2000));
}

// ── undo: one step per drag ──
{
  const before = base();
  const after = reshapeCutAtEdge(before, { side: "right", atMs: 1000 }, 1800, DUR);
  const h = pushEdit(emptyHistory(), before);
  const u = undoEdit(h, after);
  eq("one undo restores the state before the drag", [u.state === before, h.past.length], [true, 1]);
  eq("the original footage is cut again", keep(u.state), [[0, 1000], [2000, 5000], [6000, 10000]]);
}

// ── never duplicates footage, edges clamp ──
{
  const all = [
    reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 99999, DUR),
    reshapeCutAtEdge(base(), { side: "left", atMs: 2000 }, -500, DUR),
    reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, -50, DUR),
    reshapeCutAtEdge(base(), { side: "left", atMs: 2000 }, 99999, DUR),
  ];
  const sane = (st) => { const k = keep(st); return k.every(([a, b], i) => b > a && (i === 0 || a >= k[i - 1][1])) && k.reduce((n, [a, b]) => n + b - a, 0) <= DUR; };
  ok("kept footage never overlaps itself, whatever the drag", all.every(sane));
  ok("an inward drag cannot take the whole clip", keep(all[2]).length > 0 && keep(all[3]).length > 0);
  const d = describeEdgeDrag(base(), { side: "right", atMs: 1000 }, -50, DUR);
  ok("the clamp keeps at least the minimum length", d.clampedMs >= 120);
  const b0 = base();
  ok("an edge no clip owns does nothing", reshapeCutAtEdge(b0, { side: "right", atMs: 3333 }, 4000, DUR) === b0);
}

// ── first and last edge: start and end trim ──
{
  const st = newEditState("v.mov", [cut(0, 1500, {}), cut(9000, 10000, {})]);
  eq("the first clip's left edge reveals the start", keep(reshapeCutAtEdge(st, { side: "left", atMs: 1500 }, 700, DUR)), [[700, 9000]]);
  eq("the last clip's right edge reveals the end", keep(reshapeCutAtEdge(st, { side: "right", atMs: 9000 }, 9600, DUR)), [[1500, 9600]]);
  const plain = newEditState("v.mov", []);
  eq("with no cut at the start, dragging the first edge inward is a start trim", keep(reshapeCutAtEdge(plain, { side: "left", atMs: 0 }, 800, DUR)), [[800, 10000]]);
  eq("and the last edge an end trim", keep(reshapeCutAtEdge(plain, { side: "right", atMs: 10000 }, 9100, DUR)), [[0, 9100]]);
  eq("the start of the video is a hard limit", keep(reshapeCutAtEdge(plain, { side: "left", atMs: 0 }, -300, DUR)), [[0, 10000]]);
}

// ── laugh protection / minimum piece ──
{
  const small = reshapeCutAtEdge(base(), { side: "right", atMs: 1000 }, 1930, DUR);
  eq("a sliver smaller than the minimum piece is not left behind: the cut is fully restored", keep(small), [[0, 5000], [6000, 10000]]);
  const b1 = base();
  ok("a drag shorter than the minimum makes no change", reshapeCutAtEdge(b1, { side: "left", atMs: 2000 }, 2020, DUR) === b1);
  // a laugh inside an AI cut: the cut is [1000,3000], the laugh [1800,2200] is protected, so only [1000,1800] and [2200,3000] are cut
  const laugh = makeDecision("laughProtect", 1800, 2200);
  const st = newEditState("v.mov", [cut(1000, 3000), laugh]);
  eq("(setup) the laugh is kept", keep(st), [[0, 1000], [1800, 2200], [3000, 10000]]);
  const s = reshapeCutAtEdge(st, { side: "left", atMs: 1800 }, 1400, DUR);
  eq("revealing next to a laugh does not cut the laugh", keep(s), [[0, 1000], [1400, 2200], [3000, 10000]]);
  const t = reshapeCutAtEdge(st, { side: "right", atMs: 2200 }, 2500, DUR);
  eq("and the other side of the laugh stays protected-shaped", keep(t), [[0, 1000], [1800, 2500], [3000, 10000]]);
}

// ── other decisions unchanged ──
{
  const zoom = makeDecision("zoom", 3000, 3500);
  const caption = makeDecision("caption", 3600, 4000);
  const laugh = makeDecision("laughProtect", 7000, 7300);
  const st = newEditState("v.mov", [cut(1000, 2000), cut(5000, 6000), zoom, caption, laugh]);
  const s = reshapeCutAtEdge(st, { side: "right", atMs: 1000 }, 1500, DUR);
  eq("zooms, captions and protections are untouched", [zoom, caption, laugh].every((d) => s.decisions.some((x) => x.id === d.id && x.state === d.state && x.origin === d.origin)), true);
  eq("the other cut keeps its decision exactly", s.decisions.some((x) => x.id === cut(5000, 6000).id && x.state === "applied" && x.origin === "ai"), true);
  eq("the category switches are unchanged", s.categoryEnabled, st.categoryEnabled);
  ok("the timeline derived from the new state matches it (no manual-edit warning)", timelineMatchesState(keepRangesOf(s, DUR).map((k) => ({ uri: "v.mov", trimStartMs: k.startMs, trimEndMs: k.endMs })), s, DUR));
}

// ── haptic boundary helper ──
{
  const st = base();
  eq("the AI's boundaries are its cut edges", aiBoundariesOf(st), [1000, 2000, 5000, 6000]);
  eq("crossing one is detected, in both directions", [crossedBoundary([1000, 2000], 900, 1100), crossedBoundary([1000, 2000], 1100, 900), crossedBoundary([1000, 2000], 1100, 1500)], [true, true, false]);
  const user = addManualCut(st, 3000, 3300);
  eq("the creator's own cuts are not the AI's boundaries", aiBoundariesOf(user), [1000, 2000, 5000, 6000]);
}

// ── seams and overlays ──
{
  const clips = [
    { id: "a", uri: "v.mov", trimStartMs: 0, trimEndMs: 1000 },
    { id: "b", uri: "v.mov", trimStartMs: 2000, trimEndMs: 5000 },
    { id: "c", uri: "v.mov", trimStartMs: 6000, trimEndMs: 10000 },
  ];
  const h = buildSeamHandles(clips, "v.mov");
  eq("a handle at the start, at each seam and at the end", h.map((x) => x.outputMs), [0, 1000, 4000, 8000]);
  eq("the start handle owns the first clip's left edge, the end handle the last clip's right edge", [h[0].next.side, h[0].prev, h[3].prev.side, h[3].next], ["left", undefined, "right", undefined]);
  eq("a middle seam owns both edges (in source ms)", [h[1].prev.atMs, h[1].next.atMs], [1000, 2000]);
  eq("no handles when the clips are not all the edited video", buildSeamHandles([...clips, { id: "z", uri: "other.mov", trimStartMs: 0, trimEndMs: 500 }], "v.mov"), []);

  // text overlays follow their footage
  const old = clips.map((c) => ({ uri: c.uri, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));
  const st = newEditState("v.mov", [cut(1000, 2000), cut(5000, 6000)]);
  const next = reshapeCutAtEdge(st, { side: "right", atMs: 1000 }, 1500, DUR);
  const newClips = keepRangesOf(next, DUR).map((k) => ({ uri: "v.mov", trimStartMs: k.startMs, trimEndMs: k.endMs }));
  const ov = remapOverlayTimes(
    [{ id: "early", startMs: 500, endMs: 900 }, { id: "late", startMs: 5000, endMs: 6500 }, { id: "whole" }, { id: "toEnd", startMs: 2000, endMs: 8000 }],
    old, newClips, "v.mov",
  );
  eq("text before the change stays put", [ov[0].startMs, ov[0].endMs], [500, 900]);
  eq("text after it moves by the footage that came back (500 ms)", [ov[1].startMs, ov[1].endMs], [5500, 7000]);
  eq("text for the whole video is untouched", ov[2], { id: "whole" });
  eq("text that runs to the end still runs to the end", ov[3].endMs, 8500);
  const back = remapOverlayTimes(ov, newClips, old, "v.mov");
  eq("and undo puts it back", [back[1].startMs, back[1].endMs, back[3].endMs], [5000, 6500, 8000]);
}

// ── UI wiring ──
{
  const tl = read("../components/TimelineEditor.tsx");
  const sh = read("../components/SeamHandles.tsx");
  const edit = read("../app/edit.tsx");
  ok("every seam side is a drag target of at least 44 pt", /SEAM_HANDLE_W = 44/.test(sh) && /spec\.prev \? SEAM_HANDLE_W/.test(sh) && /seams\.handles\.map/.test(tl));
  ok("a short touch is a tap on the clip (clip tap and Delete this part still work); the diamond is above the handle", /onTap\(g\.edge\.clipId\)/.test(sh) && /TAP_SLOP_PX/.test(sh) && /zIndex: 20/.test(sh) && /zIndex: 60/.test(tl));
  ok("the drag releases through the decision model, not a free trim, and is one undo step (userEdit)", /reshapeCutAtEdge\(st, edge, newSourceMs/.test(edit) && /userEdit\(\(st\) => reshapeCutAtEdge/.test(edit));
  ok("the old per-clip trim handles are hidden while the seam handles are shown", (tl.match(/&& !seams && \(/g) ?? []).length === 2);
  ok("while dragging: a time label, a haptic at the AI's boundary, and a ghost strip of the cut-out footage", /seamDeltaLabel\(/.test(sh) && /crossedBoundary\(/.test(tl) && /styles\.strip/.test(sh) && /styles\.bubble/.test(sh) && /getThumbnailAsync/.test(sh));
  ok("seam handles only on the automatic edit's timeline (no confirm dialog is involved: the timeline matches)", /!aiEditsEnabled \|\| !editModel \|\| !modelInSync\) return undefined/.test(edit));
  ok("text overlays are remapped whenever the decisions change the clips", /remapOverlayTimes\(prev, before, derived/.test(edit));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
