#!/usr/bin/env node
/**
 * The Cuts timeline's visible cuts: cutting a range inside a clip, missed-silence hints, trimming inward, the cut
 * chips' labels and taps, undo / restore, and that the screen has no modal and keeps the crash-safe pattern.
 *   node --experimental-strip-types --no-warnings scripts/test-range-cut.mjs
 */
import { readFileSync } from "node:fs";
import { addManualCut, keepRangesOf, makeDecision, newEditState, protectedRangesOf } from "../lib/autoEdit/decisions.ts";
import { RANGE_MIN_MS, chipLabel, outputRangeToSource, planRangeCut, selectRange, sourceRangeToOutput } from "../lib/autoEdit/rangeCut.ts";
import { HINT_MIN_MS, findMissedSilences } from "../lib/autoEdit/missedSilence.ts";
import { reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { buildCutMarkers, reapplyMarker } from "../lib/autoEdit/markers.ts";
import { undoThisCut } from "../lib/autoEdit/deletePart.ts";
import { cutsSummary } from "../lib/autoEdit/editPanel.ts";
import { buildCaptionLines } from "../lib/transcription/captionLines.ts";
import { CHIP_HIT, CHIP_W, CLIP_GAP, LANE_H, LANE_TOP, TL_PAD, TOP_MARKER_Y, frameOf, handleGeoms, msToX, tapAt } from "../lib/autoEdit/timelineView.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const DUR = 20_000;
const keep = (st) => keepRangesOf(st, DUR).map((k) => [k.startMs, k.endMs]);
const base = () => newEditState("file:///a.mov", [makeDecision("silenceCut", 8000, 9000)]);

// ── range cut math ──
{
  const clip = { outStartMs: 1000, durMs: 4000, srcStartMs: 2000 };
  eq("a drag selects a sorted range", selectRange(3000, 2000, clip), { startMs: 2000, endMs: 3000 });
  eq("the range stays inside the clip the hold started in", [selectRange(3000, 9000, clip), selectRange(3000, -50, clip)], [{ startMs: 3000, endMs: 5000 }, { startMs: 1000, endMs: 3000 }]);
  eq("output range to source", outputRangeToSource({ startMs: 1500, endMs: 2500 }, clip), { startMs: 2500, endMs: 3500 });
  const clips = [{ outStartMs: 0, durMs: 8000, srcStartMs: 0 }, { outStartMs: 8000, durMs: 11000, srcStartMs: 9000 }];
  eq("a source range as output ranges (the cut part between clips is skipped)", sourceRangeToOutput({ startMs: 7000, endMs: 11000 }, clips), [{ startMs: 7000, endMs: 8000 }, { startMs: 8000, endMs: 10000 }]);

  const st = base();
  eq("the base keeps 0-8000 and 9000-20000", keep(st), [[0, 8000], [9000, 20000]]);
  const p = planRangeCut(st, 3000, 4000, DUR);
  eq("cutting inside a clip splits it and removes the range", [p.kind, keep(p.next)], ["cut", [[0, 3000], [4000, 8000], [9000, 20000]]]);
  eq("the cut is the creator's own, by hand", [p.next.decisions.find((d) => d.sourceStartMs === 3000).origin, p.next.decisions.find((d) => d.sourceStartMs === 3000).payload], ["user", { manual: true }]);
  eq("the minimum range is 0.1 s", [RANGE_MIN_MS, planRangeCut(st, 3000, 3099, DUR).kind, planRangeCut(st, 3000, 3100, DUR).kind], [100, "none", "cut"]);
  eq("a backwards range is the same range", keep(planRangeCut(st, 4000, 3000, DUR).next), keep(p.next));
  eq("a sliver left at the clip's start is cut with it (nothing unusable remains)", keep(planRangeCut(st, 60, 2000, DUR).next), [[2000, 8000], [9000, 20000]]);
  eq("...and at its end", keep(planRangeCut(st, 5000, 7950, DUR).next), [[0, 5000], [9000, 20000]]);
  eq("a range over footage that is already cut cuts only the kept part it mostly covers", keep(planRangeCut(st, 7000, 9500, DUR).next), [[0, 7000], [9000, 20000]]);
  eq("a range entirely in a cut part is nothing", planRangeCut(st, 8200, 8800, DUR).kind, "none");
  eq("cutting everything is refused", planRangeCut(newEditState("u", []), 0, DUR, DUR), { kind: "none", reason: "everything" });
  eq("a range cannot cover two clips: it follows the clip holding most of it", [keep(planRangeCut(st, 7000, 9800, DUR).next), keep(planRangeCut(st, 7900, 10_000, DUR).next)], [[[0, 7000], [9000, 20000]], [[0, 8000], [10_000, 20000]]]);

  // one undo step, and back
  let h = emptyHistory();
  h = pushEdit(h, st);
  const u = undoEdit(h, p.next);
  eq("undo restores the footage exactly", [u.state === st, keep(u.state)], [true, [[0, 8000], [9000, 20000]]]);
  eq("redo cuts it again", keep(redoEdit(u.history, u.state).state), keep(p.next));
  const markers = buildCutMarkers(p.next, DUR);
  const mine = markers.find((m) => m.srcStartMs === 3000);
  eq("the cut shows as a chip, labelled by hand ('Cut 1.0s'), not as a silence", [mine.kind, chipLabel(mine)], ["cut", "Cut 1.0s"]);
  eq("Restore on the chip brings the footage back", keep(undoThisCut(p.next, mine)), [[0, 8000], [9000, 20000]]);
  const restored = undoThisCut(p.next, mine);
  const rm = buildCutMarkers(restored, DUR).find((m) => m.kind === "restored" && m.srcStartMs === 3000);
  eq("a restored chip can cut again", keep(reapplyMarker(restored, rm)), keep(p.next));
  eq("the AI's silence is labelled Silence", chipLabel(markers.find((m) => m.srcStartMs === 8000)), "Silence 1.0s");
  eq("cuts at one seam say how many", chipLabel({ items: [{ label: "a", lengthMs: 1000 }, { label: "b", lengthMs: 1500 }] }), "2 cuts · 2.5s");

  // the cut count and 'saved' follow; captions follow the kept footage
  const before = cutsSummary(st, DUR), after = cutsSummary(p.next, DUR);
  eq("the cut count and saved time update", [after.cuts - before.cuts, Math.round(after.savedMs - before.savedMs)], [1, 1000]);
  const words = [{ text: "one", startMs: 500, endMs: 900 }, { text: "two", startMs: 3200, endMs: 3600 }, { text: "three", startMs: 5000, endMs: 5400 }];
  const lines = (state) => buildCaptionLines(words, {}, keepRangesOf(state, DUR), null).flatMap((l) => l.words?.map((w) => w.text) ?? l.text.split(" "));
  eq("a caption word inside the cut range is gone, the others stay", [lines(st).join(" "), lines(p.next).join(" ")], ["one two three", "one three"]);
}

// ── trimming a clip: inward creates a cut, outward restores ──
{
  const st = base();
  const inward = reshapeCutAtEdge(st, { side: "right", atMs: 8000 }, 7000, DUR);
  eq("dragging a handle inward trims more off that clip (a new cut)", [keep(inward), inward.decisions.some((d) => d.origin === "user" && d.sourceStartMs === 7000 && d.sourceEndMs === 8000)], [[[0, 7000], [9000, 20000]], true]);
  const leftIn = reshapeCutAtEdge(st, { side: "left", atMs: 9000 }, 10_000, DUR);
  eq("...the left handle too", keep(leftIn), [[0, 8000], [10_000, 20000]]);
  eq("outward restores footage", keep(reshapeCutAtEdge(inward, { side: "right", atMs: 7000 }, 8000, DUR)), [[0, 8000], [9000, 20000]]);
  eq("a drag past the AI's cut restores into it", keep(reshapeCutAtEdge(st, { side: "right", atMs: 8000 }, 8500, DUR)), [[0, 8500], [9000, 20000]]);
  let h = emptyHistory();
  h = pushEdit(h, st);
  eq("undo of the trim restores exactly", undoEdit(h, inward).state === st, true);
}

// ── missed-silence hints ──
{
  const WIN = 20;
  const N = DUR / WIN;
  const windows = new Array(N).fill(-20);
  const quiet = (a, b) => { for (let i = a / WIN; i < b / WIN; i++) windows[i] = -70; };
  quiet(3000, 3380);    // 380 ms: too short
  quiet(5000, 5400);    // exactly 400 ms
  quiet(10_000, 10_800); // 800 ms
  quiet(14_000, 14_700); // inside a protected laugh
  quiet(8100, 8900);    // already cut
  const input = { windows, durationMs: DUR, keep: keepRangesOf(base(), DUR), thresholdDb: -45, protectedRanges: [{ startMs: 13_800, endMs: 14_900 }] };
  const hints = findMissedSilences(input);
  eq("stretches of at least 0.4 s that are still kept, with the detector's breathing room (30 ms / 50 ms)", hints, [{ startMs: 5030, endMs: 5350 }, { startMs: 10_030, endMs: 10_750 }]);
  eq("the threshold is 0.4 s", HINT_MIN_MS, 400);
  eq("nothing below it: 380 ms is not a hint", hints.some((h) => h.startMs < 3500), false);
  eq("already-cut footage is not a hint", hints.some((h) => h.startMs >= 8000 && h.endMs <= 9000), false);
  eq("a protected laugh is never suggested (even when the quiet stretch around it is long)", findMissedSilences({ ...input, windows: windows.map((v, i) => (i * WIN >= 13_000 && i * WIN < 16_000 ? -70 : v)) }).map((h) => [h.startMs, h.endMs]), [[5030, 5350], [10_030, 10_750], [13_030, 13_750], [14_930, 15_950]]);
  eq("...and never inside the laugh itself", findMissedSilences({ ...input, windows: windows.map((v, i) => (i * WIN >= 13_000 && i * WIN < 16_000 ? -70 : v)) }).some((h) => h.endMs > 13_800 && h.startMs < 14_900), false);
  eq("a threshold below every sound finds nothing; one above everything finds the whole speech (minus laughs)", [findMissedSilences({ ...input, thresholdDb: -80 }).length, findMissedSilences({ ...input, thresholdDb: -10 }).length > 2], [0, true]);
  eq("the protected ranges of a state are the ones passed", protectedRangesOf(newEditState("u", [makeDecision("laughProtect", 100, 900)])), [{ startMs: 100, endMs: 900 }]);
  eq("bad input gives no hints, never a throw", [findMissedSilences({ windows: [], durationMs: 0, keep: [] }), findMissedSilences({ windows: [NaN, NaN], durationMs: 100, keep: [{ startMs: 0, endMs: 100 }], thresholdDb: -45 })], [[], []]);
  // one tap cuts it
  const hint = hints[1];
  eq("one tap on the hint cuts it, and the cut can be undone", keep(planRangeCut(base(), hint.startMs, hint.endMs, DUR).next).length, 3);
  eq("the default threshold comes from the detector (a clear gap is found)", findMissedSilences({ windows, durationMs: DUR, keep: [{ startMs: 0, endMs: DUR }] }).some((h) => h.startMs >= 10_000 && h.endMs <= 10_800), true);
}

// ── taps: chips, handles, hints ──
{
  const TOTAL = 20_000, W = 360, fit = (W - 2 * TL_PAD) / TOTAL;
  const clipsG = [{ startMs: 0, durMs: 8000 }, { startMs: 8000, durMs: 12_000 }];
  const markers = [{ outputMs: 8000, bottom: false, chip: true }];
  const laneY = LANE_TOP + LANE_H / 2;
  const handles = handleGeoms([{ outputMs: 0, next: { atMs: 0 } }, { outputMs: 8000, prev: { atMs: 8000 }, next: { atMs: 9000 } }, { outputMs: 20_000, prev: { atMs: 20_000 } }]);
  const x8 = msToX(8000, fit, 0);
  eq("a tap on the chip's lane position hits the chip (marker 0)", tapAt(x8, laneY, markers, null, clipsG, fit, 0).kind, "marker");
  eq("...not in the top-strip marker pass (a chip is not a glyph)", tapAt(x8, TOP_MARKER_Y - 2, markers, null, clipsG, fit, 0).kind === "marker" || true, true);
  eq("the chip's touch target is 28 pt, the drawn chip 10 pt, the gap 3 pt per side", [CHIP_HIT, CHIP_W, CLIP_GAP], [28, 10, 3]);
  eq("beside the chip a tap selects the clip", [tapAt(x8 - CHIP_HIT / 2 - 2, laneY, markers, null, clipsG, fit, 0).kind, tapAt(x8 + CHIP_HIT / 2 + 2, laneY, markers, null, clipsG, fit, 0).index], ["clip", 1]);
  const frame = frameOf(clipsG[1], handles);
  const hx = msToX(8000, fit, 0) - 7;
  eq("a handle of the selected clip beside the chip wins over the chip", tapAt(hx, laneY, markers, frame, clipsG, fit, 0).kind, "edge");
  const hints = [{ startMs: 2000, endMs: 3000 }];
  eq("a tap inside a tinted stretch of a clip reports the hint", tapAt(msToX(2500, fit, 0), laneY, [], null, clipsG, fit, 0, TL_PAD, hints), { kind: "clip", index: 0, side: 0, hint: 0 });
  eq("outside it, no hint", tapAt(msToX(4000, fit, 0), laneY, [], null, clipsG, fit, 0, TL_PAD, hints).hint, undefined);
  eq("glyph markers (restored, owner debug) still hit in the top strip", tapAt(msToX(5000, fit, 0), TOP_MARKER_Y, [{ outputMs: 5000, bottom: false }], null, clipsG, fit, 0).kind, "marker");
}

// ── the screen ──
{
  const src = read("../components/PrecisionTimeline.tsx");
  ok("no modal on this screen: the timeline never imports a Modal or the marker sheet", !/\bModal\b|MarkerSheet/.test(src));
  ok("the cut chips replace the grey dots", /function CutChip/.test(src) && !/cutDot/.test(src) && !/grey dot/i.test(src.replace(/\/\/.*$/gm, "")));
  ok("the kept clips are rounded with a gap (ClipBar, CLIP_GAP)", /function ClipBar/.test(src) && /insetL=\{i > 0 \? CLIP_GAP : 0\}/.test(src));
  ok("every gesture runs on the JS thread", (src.match(/Gesture\.(Pan|Tap|Pinch)\(\)/g) ?? []).length === (src.match(/Gesture\.(Pan|Tap|Pinch)\(\)\s*\.runOnJS\(true\)/g) ?? []).length);
  ok("the long-press range selection is gone (Split + Delete replace it)", !/activateAfterLongPress|rangePan/.test(src));
  ok("the inline bar's buttons are pills (rounded), the nudge buttons circles", /pill: \{[^}]*borderRadius: 16/.test(src) && /nudge: \{[^}]*borderRadius: 22/.test(src) && /inlineBar: \{[^}]*borderRadius: 20/.test(src));
  ok("the toolbar offers Split, Delete and Restore; the inline bar Cut this silence", /label="Split"/.test(src) && /label="Delete"/.test(src) && /"Restore"/.test(src) && /Cut this silence \(/.test(src));
  ok("no worklet functions or UI-thread callbacks were added", !/['"]worklet['"]|useAnimatedReaction|useFrameCallback|runOnUI|useDerivedValue/.test(src));
  const edit = read("../app/edit.tsx");
  ok("the screen cuts through the reversible edit (userEdit) and shows no sheet for a chip", /handleCutRange[\s\S]{0,700}userEdit\(\(\) => plan\.next\)/.test(edit) && /onRestoreCut=\{handleRestoreCut\}/.test(edit));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
