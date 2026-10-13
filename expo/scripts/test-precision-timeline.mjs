#!/usr/bin/env node
/**
 * Precision editing on the Cuts screen: time <-> position at every zoom, pinch / pan / fit, the handles' touch zones,
 * snapping to words and cuts (and letting go), one-frame nudges, the waveform columns, the readout, and that every
 * change is one undoable edit through the existing reshape logic (captions and overlays follow).
 *   node --experimental-strip-types --no-warnings scripts/test-precision-timeline.mjs
 */
import { readFileSync } from "node:fs";
import {
  BOTTOM_MARKER_Y, DEFAULT_FPS, DIVIDER_W, FRAME_LINE, HANDLE_PRESS_SCALE, HANDLE_RADIUS, HANDLE_TOUCH, HANDLE_W, INFO_H, LANE_H, LANE_TOP, MAX_VISIBLE_MS, NUDGE_BTN, TL_PAD, TOP_MARKER_Y,
  clampOffset, clampScale, contentWidth, dbToAmp, edgeDragMs, fitScale, fitView, followOffset, formatDeltaSeconds, formatTimeCs, frameMsOf,
  easeOutCubic, flingStep, frameHandleXs, frameOf, grabAt, handleGeoms, hitFrame, isFit, lerpView, maxScale, msToX, nudgeFrameMs, offsetToCenter, pinchView, safeFps, tapAt,
  timelineRects, waveformColumns, waveformPath, wavePiecesOf, xToMs, zoomAt,
} from "../lib/autoEdit/timelineView.ts";
import {
  SNAP_MAX_MS, SNAP_MIN_MS, SNAP_PAUSE_MS, buildSnapTargets, nearestTarget, snapParams, snapStart, snapStep, snapThresholdMs,
} from "../lib/autoEdit/edgeSnap.ts";
import { addManualCut, keepRangesOf, makeDecision, newEditState, renderClipsOf, restoreRange } from "../lib/autoEdit/decisions.ts";
import { describeEdgeDrag, reshapeCutAtEdge } from "../lib/autoEdit/reshape.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { buildSeamHandles, remapOverlayTimes } from "../lib/autoEdit/seams.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { GUARD_KEY, armGuard, disableGuard, disarmGuard, readGuard } from "../lib/autoEdit/precisionGuard.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const W = 375;           // the smallest iPhone width
const TOTAL = 60_000;    // a one-minute video

// ── 1. time <-> position at different zooms ──────────────────────────────────
{
  const fit = fitScale(TOTAL, W);
  const max = maxScale(TOTAL, W);
  ok("fit shows the whole video between the paddings", near(msToX(0, fit, 0), TL_PAD) && near(msToX(TOTAL, fit, 0), W - TL_PAD));
  ok("full zoom shows about one second across the screen width", near(W / max, MAX_VISIBLE_MS) && near(MAX_VISIBLE_MS * max, W));
  eq("a short video (under a second) cannot zoom past fit... but never below the 1 s zoom either", maxScale(500, W) >= fitScale(500, W), true);
  for (const [label, scale] of [["fit", fit], ["5x", fit * 5], ["20x", fit * 20], ["max", max]]) {
    for (const offset of [0, 137.5, 2000]) {
      const o = clampOffset(offset, TOTAL, scale, W);
      for (const ms of [0, 1234, 30_000, 59_999]) {
        const x = msToX(ms, scale, o);
        if (!near(xToMs(x, scale, o), ms, 1e-6)) { failed++; console.log(`FAIL  roundtrip ${label} offset ${o} ${ms}`); }
      }
    }
    ok(`time <-> position round-trips at ${label}`, true);
  }
  eq("scale is clamped between fit and the 1 s zoom", [clampScale(1e-9, TOTAL, W) === fit, clampScale(99, TOTAL, W) === max, near(clampScale(fit * 2, TOTAL, W), fit * 2)], [true, true, true]);
  eq("the offset never leaves the content", [clampOffset(-50, TOTAL, max, W), clampOffset(1e9, TOTAL, max, W) === contentWidth(TOTAL, max) - W, clampOffset(10, TOTAL, fit, W)], [0, true, 0]);
  ok("at fit there is nothing to scroll", isFit({ scale: fit, offset: 0 }, TOTAL, W) && !isFit({ scale: fit * 2, offset: 0 }, TOTAL, W));
  eq("fitView is the whole video from the start", fitView(TOTAL, W), { scale: fit, offset: 0 });
  eq("an edge drag moves the same time at the zoom's precision", [edgeDragMs(1000, 44, fit), edgeDragMs(1000, 44, max)].map((v) => Math.round(v)), [Math.round(1000 + 44 / fit), Math.round(1000 + 44 / max)]);
  ok("...so a 10 pt drag at full zoom is about 29 ms and a 3 pt drag under 9 ms", near(edgeDragMs(0, 10, max), 10 / max) && edgeDragMs(0, 10, max) < 30 && edgeDragMs(0, 3, max) < 9);
}

// ── 2. pinch: centred between the fingers, pan, double-tap ───────────────────
{
  const fit = fitScale(TOTAL, W);
  const start = { scale: fit, offset: 0 };
  const focal = 200;
  const tFocal = xToMs(focal, start.scale, start.offset);
  const z = pinchView(start, 4, focal, focal, TOTAL, W);
  ok("the time under the fingers stays under them while zooming in", near(msToX(tFocal, z.scale, z.offset), focal, 1e-6) && z.scale > start.scale);
  const moved = pinchView(start, 4, focal, focal + 50, TOTAL, W);
  ok("moving both fingers while pinching pans with them", near(msToX(tFocal, moved.scale, moved.offset), focal + 50, 1e-6));
  eq("a pinch can't zoom out past the whole video or in past the 1 s zoom", [pinchView(start, 0.01, focal, focal, TOTAL, W).scale === fit, pinchView(start, 1e6, focal, focal, TOTAL, W).scale === maxScale(TOTAL, W)], [true, true]);
  const edge = pinchView({ scale: fit, offset: 0 }, 6, 0, 0, TOTAL, W);
  eq("zooming around the very left stays at the start", edge.offset, 0);
  const zoomedOut = zoomAt(z, 1 / 4, focal, TOTAL, W);
  ok("zooming back out by the same factor returns to fit", near(zoomedOut.scale, fit, 1e-9) && near(zoomedOut.offset, 0, 1e-6));
  ok("the playhead can be centred", near(msToX(30_000, z.scale, offsetToCenter(30_000, z.scale, TOTAL, W)), W / 2, 1e-6));
  eq("a playhead in view is left alone; one out of view is brought back", [followOffset(30_000, z.scale, offsetToCenter(30_000, z.scale, TOTAL, W), TOTAL, W), followOffset(1000, z.scale, offsetToCenter(30_000, z.scale, TOTAL, W), TOTAL, W) !== null], [null, true]);
}

// ── 3. the selected clip's frame and handles: 44 pt targets at every zoom ────
{
  const fit = fitScale(TOTAL, W);
  const max = maxScale(TOTAL, W);
  const seams = [
    { outputMs: 0, next: { atMs: 0 } },
    { outputMs: 10_000, prev: { atMs: 10_000 }, next: { atMs: 12_000 } },
    { outputMs: 10_400, prev: { atMs: 12_400 }, next: { atMs: 15_000 } },
    { outputMs: 40_000, prev: { atMs: 44_000 } },
  ];
  const geoms = handleGeoms(seams);
  eq("geometry: the source time of the edge on each side of a seam", [geoms[1].prevAtMs, geoms[1].nextAtMs, geoms[0].hasPrev, geoms[3].hasNext], [10_000, 12_000, false, false]);
  const clips = [{ startMs: 0, durMs: 10_000 }, { startMs: 10_000, durMs: 400 }, { startMs: 10_400, durMs: 29_600 }];
  const mid = frameOf(clips[1], geoms);
  eq("a clip's frame knows which seams its two handles drag", mid, { startMs: 10_000, endMs: 10_400, leftIdx: 1, rightIdx: 2 });
  eq("the first clip's left handle is the start of the video, the last clip's right handle its end", [frameOf(clips[0], geoms).leftIdx, frameOf(clips[0], geoms).rightIdx, frameOf(clips[2], geoms).leftIdx, frameOf(clips[2], geoms).rightIdx], [0, 1, 2, 3]);
  eq("no clip, no frame", [frameOf(null, geoms), frameOf({ startMs: 0, durMs: 0 }, geoms)], [null, null]);

  const laneY = LANE_TOP + LANE_H / 2;
  for (const [label, scale] of [["fit", fit], ["5x", fit * 5], ["max", max]]) {
    const offset = clampOffset(offsetToCenter(10_200, scale, TOTAL, W), TOTAL, scale, W);
    const hx = frameHandleXs(mid, scale, offset);
    eq(`${label}: handles sit just outside the clip (centres ${HANDLE_W / 2} pt from its edges)`, [near(hx.left, msToX(10_000, scale, offset) - HANDLE_W / 2), near(hx.right, msToX(10_400, scale, offset) + HANDLE_W / 2)], [true, true]);
    const grab = (x, y = laneY) => grabAt(x, y, mid, 55_000, scale, offset);   // playhead far away
    eq(`${label}: a touch within 22 pt of a handle's centre grabs it (a 44 pt target)`, [grab(hx.left - 21).kind, grab(hx.left + 21).kind, grab(hx.right - 21).kind, grab(hx.right + 21).kind], ["edge", "edge", "edge", "edge"]);
    eq(`${label}: the left handle drags the clip's start (side 1 of seam 1), the right its end (side 0 of seam 2)`, [[grab(hx.left).index, grab(hx.left).side], [grab(hx.right).index, grab(hx.right).side]], [[1, 1], [2, 0]]);
    eq(`${label}: 23 pt from a handle's centre is not a grab (a plain spot scrolls)`, grab(hx.left - 23 - 40).kind, "scroll");
    eq(`${label}: the target reaches 8 pt above and below the lane`, [grab(hx.left, LANE_TOP - 7).kind, grab(hx.left, LANE_TOP + LANE_H + 7).kind, grab(hx.left, LANE_TOP - 12).kind], ["edge", "edge", "scroll"]);
  }
  eq("only the selected clip's handles can be grabbed: without a frame an edge is never grabbed", grabAt(msToX(10_000, fit, 0), laneY, null, 5000, fit, 0).kind, "scroll");
  eq("a handle with no seam to drag is not grabbed", hitFrame(msToX(0, fit, 0) - HANDLE_W / 2, laneY, { startMs: 0, endMs: 20_000, leftIdx: -1, rightIdx: 1 }, fit, 0), null);
  eq("the playhead dot (top strip) wins over a handle; the handle wins over the playhead's line", [grabAt(msToX(10_000, max, 0) - 7, 4, mid, 10_000, max, 0).kind, grabAt(msToX(10_000, max, 0) - 7, laneY, mid, 10_000, max, 0).kind], ["playhead", "edge"]);
  eq("the playhead line is grabbed away from the handles", grabAt(msToX(5000, max, 0) + 5, laneY, mid, 5000, max, 0).kind, "playhead");
  // very short clip at the whole-video zoom: both handles overlap, the nearer one wins
  const tiny = frameOf({ startMs: 10_000, durMs: 400 }, geoms);
  const hxT = frameHandleXs(tiny, fit, 0);
  eq("on a clip narrower than its handles the nearer handle is grabbed", [hitFrame(hxT.left - 6, laneY, tiny, fit, 0).side, hitFrame(hxT.right + 6, laneY, tiny, fit, 0).side], [1, 0]);
  eq("the touch target is 44 pt and the drawn handle 14 pt wide, 6 pt radius, full lane height", [HANDLE_TOUCH, HANDLE_W, HANDLE_RADIUS, HANDLE_PRESS_SCALE], [44, 14, 6, 1.15]);
  eq("the frame outline is 2.5 pt and the dividers 1.5 pt", [FRAME_LINE, DIVIDER_W], [2.5, 1.5]);

  // taps: markers first, then the handle, then the clip
  const markers = [{ outputMs: 10_000, bottom: false }, { outputMs: 25_000, bottom: true }];
  const at = (x, y, frame) => tapAt(x, y, markers, frame, clips, fit, 0);
  eq("a tap on a marker beats a handle under it", at(msToX(10_000, fit, 0), TOP_MARKER_Y, mid).kind, "marker");
  eq("a tap on a handle of the selected clip selects that edge", at(frameHandleXs(mid, fit, 0).left, LANE_TOP + LANE_H - 4, mid).kind, "edge");
  eq("a tap on a clip selects it (and shows its handles); another clip's edge is just that clip", [at(msToX(2000, fit, 0), laneY, null).kind, at(msToX(2000, fit, 0), laneY, null).index, at(msToX(30_000, fit, 0), laneY, mid).index], ["clip", 0, 2]);
  eq("outside the lane is nothing", at(msToX(2000, fit, 0), 100, null).kind, "none");
  eq("bottom markers sit in the lower part of the lane", BOTTOM_MARKER_Y > TOP_MARKER_Y && BOTTOM_MARKER_Y < LANE_TOP + LANE_H, true);
}

// ── 4. snapping ──────────────────────────────────────────────────────────────
{
  const words = [{ startMs: 1000, endMs: 1400 }, { startMs: 1450, endMs: 2000 }];
  const targets = buildSnapTargets(words, [1400, 5000, 1000]);
  eq("targets are word starts and ends plus the cut boundaries, sorted, no duplicates", targets, [1000, 1400, 1450, 2000, 5000]);
  eq("the snap threshold is about 10 pt of time, bounded", [snapThresholdMs(1e-6) === SNAP_MAX_MS, snapThresholdMs(10) === SNAP_MIN_MS, near(snapThresholdMs(0.343), 10 / 0.343)], [true, true, true]);
  eq("the nearest target within the threshold, else none", [nearestTarget(targets, 1010, 30), nearestTarget(targets, 1200, 30), nearestTarget(targets, 1425, 30), nearestTarget([], 5, 30)], [1000, null, 1400, null]);
  eq("a skipped target is not returned", nearestTarget(targets, 1425, 30, 1400), 1450);

  const p = { thresholdMs: 30, pauseMs: SNAP_PAUSE_MS, jitterMs: 4 };
  let now = 0;
  let st = snapStart(1100, now);
  // moving through: free, then catches 1400
  let r = snapStep(st, 1200, (now += 16), targets, p); st = r.state;
  eq("far from every target the edge follows the finger", [r.ms, r.caught], [1200, false]);
  r = snapStep(st, 1385, (now += 16), targets, p); st = r.state;
  eq("close to a word end it snaps onto it, once (a haptic)", [r.ms, r.caught], [1400, true]);
  r = snapStep(st, 1390, (now += 16), targets, p); st = r.state;
  eq("it stays on the target while the finger moves within the threshold", [r.ms, r.caught], [1400, false]);
  r = snapStep(st, 1432, (now += 16), targets, p); st = r.state;
  eq("dragging past the threshold releases the snap (the next target 1450 is in reach, so it moves on to it)", [r.ms, r.caught], [1450, true]);
  r = snapStep(st, 1700, (now += 16), targets, p); st = r.state;
  eq("and then the edge is free again", [r.ms, st.target], [1700, null]);

  // a pause lets go
  st = snapStart(1000, (now = 1000));
  r = snapStep(st, 1396, now, targets, p); st = r.state;
  eq("caught on 1400", r.ms, 1400);
  r = snapStep(st, 1396, (now += SNAP_PAUSE_MS - 50), targets, p); st = r.state;
  eq("holding still for a moment keeps it", r.ms, 1400);
  r = snapStep(st, 1397, (now += 80), targets, p); st = r.state;
  eq("holding still past the pause time lets go: the edge goes where the finger is", [r.ms, st.target, st.released], [1397, null, 1400]);
  r = snapStep(st, 1398, (now += 16), targets, p); st = r.state;
  eq("and it does not grab the same target again while the finger stays near it", [r.ms, r.caught], [1398, false]);
  r = snapStep(st, 1500, (now += 16), targets, p); st = r.state;
  eq("after leaving the zone it can be caught again", [r.ms, st.released], [1500, null]);
  r = snapStep(st, 1995, (now += 16), targets, p); st = r.state;
  eq("(a different target is caught normally)", [r.ms, r.caught], [2000, true]);
  // a pause with no move events at all (the frame callback keeps stepping)
  st = snapStart(0, (now = 5000));
  r = snapStep(st, 1999, now, targets, snapParams(0.343)); st = r.state;
  for (let i = 0; i < 30; i++) r = snapStep(st, 1999, (now += 16), targets, snapParams(0.343)), (st = r.state);
  eq("frame-only steps also notice the pause", [r.ms, st.target], [1999, null]);
}

// ── 5. frame nudge ───────────────────────────────────────────────────────────
{
  eq("frame length from the frame rate", [frameMsOf(30), frameMsOf(60), Math.round(frameMsOf(24) * 100) / 100], [1000 / 30, 1000 / 60, 41.67]);
  eq("a missing or silly frame rate means 30", [safeFps(null), safeFps(undefined), safeFps(0), safeFps(1000), safeFps(NaN), safeFps(29.97)], [30, 30, 30, 30, 30, 29.97]);
  eq("one frame later at 30 fps, from a frame boundary", [nudgeFrameMs(1000, 1, 30, 9000), nudgeFrameMs(1000, -1, 30, 9000)], [1033, 967]);
  eq("from between frames it goes to the next frame line in that direction", [nudgeFrameMs(1010, 1, 30, 9000), nudgeFrameMs(1010, -1, 30, 9000)], [1033, 1000]);
  eq("at 60 fps and 24 fps", [nudgeFrameMs(1000, 1, 60, 9000), nudgeFrameMs(1000, 1, 24, 9000)], [1017, 1042]);
  eq("it stays inside the video", [nudgeFrameMs(0, -1, 30, 9000), nudgeFrameMs(9000, 1, 30, 9000)], [0, 9000]);
  eq("walking 30 frames at 30 fps is one second", (() => { let ms = 3000; for (let i = 0; i < 30; i++) ms = nudgeFrameMs(ms, 1, 30, 99999); return ms; })(), 4000);
  eq("forward then back returns to the same frame", nudgeFrameMs(nudgeFrameMs(2000, 1, 30, 9000), -1, 30, 9000), 2000);
  eq("the default is 30 fps", DEFAULT_FPS, 30);
}

// ── 6. readout and waveform ──────────────────────────────────────────────────
{
  eq("m:ss.cc", [formatTimeCs(0), formatTimeCs(3420), formatTimeCs(61_050), formatTimeCs(599_999), formatTimeCs(-5), formatTimeCs(NaN)], ["0:00.00", "0:03.42", "1:01.05", "9:59.99", "0:00.00", "0:00.00"]);
  eq("the delta label", [formatDeltaSeconds(400), formatDeltaSeconds(-40), formatDeltaSeconds(0)], ["+0.40s", "-0.04s", "+0.00s"]);
  const windows = Array.from({ length: 100 }, (_, i) => (i === 50 ? -10 : -60));   // 2 s of 20 ms windows, a loud blip at 1.0 s
  const pieces = [{ srcStartMs: 0, srcEndMs: 2000, outStartMs: 0 }];
  eq("dB to bar height", [dbToAmp(-60), dbToAmp(-8), dbToAmp(-100), dbToAmp(NaN) , near(dbToAmp(-34), 0.5)], [0, 1, 0, 0, true]);
  const cols = waveformColumns(windows, 20, pieces, 0, 2000, 20);   // 100 ms per column
  eq("the loudest window in a column wins (a short sound never disappears when zoomed out)", [cols[10] > 0.9, cols[9], cols[11]], [true, 0, 0]);
  const fine = waveformColumns(windows, 20, pieces, 900, 1100, 40);   // 5 ms per column: interpolated between windows
  ok("zoomed in the level is smooth, not blocky", fine.some((v) => v > 0.1 && v < 0.9));
  const cut = waveformColumns(windows, 20, [{ srcStartMs: 0, srcEndMs: 500, outStartMs: 0 }, { srcStartMs: 1000, srcEndMs: 1500, outStartMs: 500 }], 0, 1000, 10);
  eq("columns follow the kept pieces, not the source: the blip at 1.0 s plays at output 0.5 s", [cut[5] > 0.9, cut[4]], [true, 0]);
  eq("output time with no piece is silent", waveformColumns(windows, 20, [], 0, 1000, 5), [0, 0, 0, 0, 0]);
  eq("pieces from clips", wavePiecesOf([{ trimStartMs: 100, trimEndMs: 600 }, { trimStartMs: 1000, trimEndMs: 1500, durationMs: 9000 }, { durationMs: 700 }]), [
    { srcStartMs: 100, srcEndMs: 600, outStartMs: 0 }, { srcStartMs: 1000, srcEndMs: 1500, outStartMs: 500 }, { srcStartMs: 0, srcEndMs: 700, outStartMs: 1000 },
  ]);
  const path = waveformPath([0, 1, 0.5], 3, 56);
  ok("the path draws a bar per non-empty column, centred", path.startsWith("M4.5") && !path.includes("M1.5") && path.includes("M7.5"));
}

// ── 7. nothing overlaps on the smallest phone ────────────────────────────────
{
  const r = timelineRects(W);
  const rects = { nudgeBack: r.nudgeBack, readout: r.readout, nudgeFwd: r.nudgeFwd, clearBtn: r.clearBtn };
  const names = Object.keys(rects);
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const clashes = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (overlap(rects[names[i]], rects[names[j]])) clashes.push([names[i], names[j]]);
  eq("the readout, the two arrows and the close button do not overlap at 375 pt", clashes, []);
  ok("they all sit inside the info row", names.every((n) => rects[n].x >= 0 && rects[n].x + rects[n].w <= W && rects[n].y >= r.info.y && rects[n].y + rects[n].h <= r.info.y + r.info.h));
  ok("the buttons are at least 44 x 44", [r.nudgeBack, r.nudgeFwd, r.clearBtn].every((b) => b.w >= 44 && b.h >= 44));
  ok("the readout has room for m:ss.cc and the delta (at least 150 pt)", r.readout.w >= 150);
  ok("the info row is under the lane", r.info.y === r.lane.y + r.lane.h && !overlap(r.lane, r.info));
  eq("the timeline is a fixed height", LANE_TOP + LANE_H + INFO_H, 116);
  ok("(NUDGE_BTN is the 44 pt minimum)", NUDGE_BTN >= 44);
}

// ── 8. every change is one undoable edit through the existing reshape ────────
{
  const DUR = 10_000;
  const URI = "v.mov";
  const cut = (s, e) => makeDecision("silenceCut", s, e);
  const start = newEditState(URI, [cut(1000, 2000), cut(5000, 6000)]);
  const keep = (st) => keepRangesOf(st, DUR).map((k) => [k.startMs, k.endMs]);
  const fps = 30;
  // one-frame nudge of the end of the first clip (1000): later = a frame more footage comes back
  const edge = { side: "right", atMs: 1000 };
  const later = nudgeFrameMs(edge.atMs, 1, fps, DUR);
  eq("a one-frame nudge is under the default 40 ms jitter gate, so the default would ignore it", reshapeCutAtEdge(start, edge, later, DUR) === start, true);
  const nudged = reshapeCutAtEdge(start, edge, later, DUR, 1);
  eq("with the lowered gate the nudge reveals exactly one frame", keep(nudged), [[0, 1033], [2000, 5000], [6000, 10000]]);
  ok("the describe call gives the same clamped result for the drag line", describeEdgeDrag(start, edge, later, DUR, 1).clampedMs === 1033 && describeEdgeDrag(start, edge, later, DUR).kind === "none");
  // and back
  const back = reshapeCutAtEdge(nudged, { side: "right", atMs: 1033 }, nudgeFrameMs(1033, -1, fps, DUR), DUR, 1);
  eq("nudging back cuts the frame again", keep(back), [[0, 1000], [2000, 5000], [6000, 10000]]);
  // the other edge of the same cut
  const leftEdge = reshapeCutAtEdge(start, { side: "left", atMs: 2000 }, nudgeFrameMs(2000, -1, fps, DUR), DUR, 1);
  eq("the start of the next clip moves one frame earlier", keep(leftEdge), [[0, 1000], [1967, 5000], [6000, 10000]]);
  // snapped drags: edge dragged to a word end 25 ms from the start of the drag (under 40 ms) still counts
  const snapped = reshapeCutAtEdge(start, edge, 1025, DUR, 1);
  eq("a precise 25 ms drag (a snap to a nearby word end) is applied", keep(snapped), [[0, 1025], [2000, 5000], [6000, 10000]]);

  // undo / redo through the existing history
  let h = pushEdit(emptyHistory(), start);
  const u = undoEdit(h, nudged);
  eq("undo brings back the state before the nudge, exactly", u.state === start, true);
  const rd = redoEdit(u.history, u.state);
  eq("redo brings the nudge back", keep(rd.state), keep(nudged));
  // several nudges are several undo steps, each undoable
  let st = start;
  h = emptyHistory();
  let atMs = 1000;
  for (let i = 0; i < 3; i++) {
    const next = reshapeCutAtEdge(st, { side: "right", atMs }, nudgeFrameMs(atMs, 1, fps, DUR), DUR, 1);
    h = pushEdit(h, st);
    st = next;
    atMs = nudgeFrameMs(atMs, 1, fps, DUR);
  }
  eq("three nudges reveal three frames", keep(st)[0], [0, 1100]);
  let back3 = st;
  for (let i = 0; i < 3; i++) { const r = undoEdit(h, back3); h = r.history; back3 = r.state; }
  eq("three undos return to the AI edit", back3 === start, true);

  // Restore (the existing restoreRange) works over nudged cuts; Reset to AI edit replaces the state and is undoable
  eq("Restore of the whole video brings everything back after a nudge", keep(restoreRange(nudged, 0, DUR)), [[0, 10000]]);
  const fresh = newEditState(URI, [cut(1000, 2000), cut(5000, 6000)]);
  h = pushEdit(emptyHistory(), nudged);
  eq("Reset to AI edit gives the AI cuts again", keep(fresh), keep(start));
  eq("...and undoing the reset returns to the nudged edit", undoEdit(h, fresh).state === nudged, true);

  // the clips the handles are built from follow the new decisions (the handle atMs is where the next nudge starts)
  const clipsOf = (s) => renderClipsOf(s, DUR).map((c, i) => ({ id: `c${i}`, uri: URI, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs, durationMs: DUR }));
  const handles = buildSeamHandles(clipsOf(nudged), URI);
  eq("the new handle for the nudged edge is exactly one frame later", handles[1].prev.atMs, 1033);

  // captions and text overlays stay in sync: overlay times are remapped from the old clips to the new ones
  const before = renderClipsOf(start, DUR).map((c) => ({ uri: URI, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));
  const after = renderClipsOf(nudged, DUR).map((c) => ({ uri: URI, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));
  const overlays = [{ id: "a", startMs: 200, endMs: 800 }, { id: "b", startMs: 1500, endMs: 3000 }, { id: "all" }];
  const moved = remapOverlayTimes(overlays, before, after, URI);
  eq("text before the edge stays; text after it moves by the revealed frame; whole-video text is untouched", [moved[0].startMs, moved[0].endMs, moved[1].startMs, moved[1].endMs, moved[2].startMs], [200, 800, 1533, 3033, undefined]);
}

// ── 9. wiring (static checks) ────────────────────────────────────────────────
{
  const comp = read("../components/PrecisionTimeline.tsx");
  const edit = read("../app/edit.tsx");
  const code = comp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The crash fix: nothing runs on the UI thread except transform / opacity styles (the only reanimated use that
  // has run in this app before, in the text overlays); every other gesture of the app is runOnJS(true) too.
  const gestures = (code.match(/Gesture\.(Pan|Tap|Pinch)\(\)/g) || []).length;
  const jsGestures = (code.match(/Gesture\.(Pan|Tap|Pinch)\(\)\s*\.runOnJS\(true\)/g) || []).length;
  eq("every gesture runs on the JS thread (runOnJS(true)): Pinch + Pan + two Taps", [gestures, jsGestures], [4, 4]);
  ok("no worklets, UI-thread loops or animation drivers: no \"worklet\", runOnJS(), useFrameCallback, useAnimatedReaction, withDecay, withTiming, withSpring, cancelAnimation", !/"worklet"|(?<!\.)\brunOnJS\(|useFrameCallback|useAnimatedReaction|withDecay|withTiming|withSpring|\bcancelAnimation\(|runOnUI|scheduleOnUI/.test(code));
  ok("reanimated is used only for shared values and animated styles", /from "react-native-reanimated"/.test(code) && /import Animated, \{ useAnimatedStyle, useSharedValue, type SharedValue \} from "react-native-reanimated"/.test(code));
  const styleBodies = [...code.matchAll(/useAnimatedStyle\(\(\) => (?:\{([\s\S]*?)\n  \}\)|\(\{([\s\S]*?)\}\)\))/g)].map((m) => m[1] ?? m[2] ?? "");
  ok(`all ${styleBodies.length} animated styles return only transform and opacity (no width, height, top, left, colors)`, styleBodies.length >= 9 && styleBodies.every((b) => !/\b(width|height|top|left|right|bottom|backgroundColor|borderRadius)\s*:/.test(b)));
  ok("animated styles read only shared values and plain numbers (no objects or functions captured)", styleBodies.every((b) => !/\b(geom|marker|clip|seams|props|live|view\.current)\b/.test(b)));
  ok("pinch zoom keeps the moment under the centre line; double tap animates back to the whole video", /offsetForCenter\(p\.centerMs, sc/.test(comp) && /numberOfTaps\(2\)/.test(comp) && /fitScale\(totalRef/.test(comp));
  ok("one-finger pan scrolls and flings (flingStep, a JS frame loop)", /flingStep\(/.test(comp) && /requestAnimationFrame/.test(comp) && /\.maxPointers\(1\)/.test(comp));
  ok("edge drags snap with snapStep and buzz when they catch", /snapStep\(/.test(comp) && /if \(r\.caught\) haptic\("light"\)/.test(comp));
  ok("the waveform comes from the analysis cache (silence detection's loudness, computed once)", /analysis\.cachedLoudness\(/.test(comp) && /analysis\.loudness\(/.test(comp) && /waveformColumns\(/.test(comp));
  ok("the waveform is a few hundred bars per drawn window (3 points per bar, three screens wide)", /const WAVE_PITCH = 3/.test(comp) && /const width = 3 \* viewW/.test(comp));
  ok("every edit ends in the existing seam handler with the lowered jitter gate", /cfg\.onDragEnd\(d\.edge, drag\.clampedMs, \{ minDragMs: 1 \}\)/.test(comp) && /l\.seams\.onDragEnd\(e, drag\.clampedMs, \{ minDragMs: 1 \}\)/.test(comp));
  ok("the nudge uses the video's frame rate", /nudgeFrameMs\(e\.atMs, direction, fps/.test(comp) && /safeFps\(seams\.frameRate\)/.test(comp));
  ok("the preview is throttled while dragging (50 ms) and the readout is m:ss.cc", /const PREVIEW_EVERY_MS = 50/.test(comp) && /now - d\.lastPreviewAt >= PREVIEW_EVERY_MS/.test(comp) && /formatTimeCs\(/.test(comp));
  // the trim-style handles
  ok("the selected clip has a thick rounded red handle on each end, each with two white grip lines", /handle: \{[^}]*width: HANDLE_W[^}]*height: LANE_H[^}]*backgroundColor: theme\.accent/.test(comp) && /borderTopLeftRadius: HANDLE_RADIUS, borderBottomLeftRadius: HANDLE_RADIUS/.test(comp) && /borderTopRightRadius: HANDLE_RADIUS, borderBottomRightRadius: HANDLE_RADIUS/.test(comp) && (comp.match(/<View style=\{styles\.grip\} \/>/g) || []).length === 4 && /grip: \{ width: 2, height: 16[^}]*backgroundColor: "#FFFFFF"/.test(comp));
  ok("a red outline of 2.5 pt runs along the top and bottom of the selected clip", /frameBar: \{[^}]*height: FRAME_LINE[^}]*backgroundColor: theme\.accent/.test(comp) && /top: LANE_TOP \}/.test(comp) && /top: LANE_TOP \+ LANE_H - FRAME_LINE/.test(comp));
  ok("a touched handle scales up (transform scale, 1.15) and gives a light haptic at touch-down; it goes back on release", /\{ scale: pressLeft\.value \}/.test(comp) && /\{ scale: pressRight\.value \}/.test(comp) && /press\(hit\.side\);\s*haptic\("light"\);/.test(comp) && /if \(g1\.current\.mode === "edge"\) press\(null\)/.test(comp) && /HANDLE_PRESS_SCALE/.test(comp));
  ok("cuts are slim striped chips in the gap between rounded clips; the grey dividers and dots are gone", /function CutChip/.test(comp) && /function ClipBar/.test(comp) && !/<Divider /.test(comp) && !/cutDot/.test(comp) && !/Pills/.test(comp));
  ok("the frame follows the selected edge through edits (clips get new ids), else the tapped clip", /selectedHandle\?\.edge\.clipId \?\? selectedClipId/.test(comp));
  ok("tapping empty space ends both the edge selection and the clip selection", /if \(l\.selectedClipId\) l\.onDeselectAndPreview\?\.\(\);/.test(comp));
  ok("the pure helpers are plain functions (no worklet directive anywhere)", !/"worklet"/.test(read("../lib/autoEdit/timelineView.ts") + read("../lib/autoEdit/edgeSnap.ts")));
  ok("haptics are called from JS only", !/"worklet"/.test(code) && /function haptic\(/.test(code));
  ok("Cuts screen: edit.tsx shows the guarded precision timeline for the automatic edit's seams and the old timeline otherwise", /<GuardedTimeline/.test(edit) && /\{isVideo && timelineSeams && \(/.test(edit) && /\{isVideo && !timelineSeams && \(/.test(edit));
  ok("edit.tsx passes the transcript words, the frame rate and the edge preview", /words: \(captions\.words \?\? \[\]\)/.test(edit) && /frameRate: sourceFps/.test(edit) && /onEdgePreview: handleEdgePreview/.test(edit));
  ok("the edit goes through reshapeCutAtEdge with the optional gate", /reshapeCutAtEdge\(st, edge, newSourceMs, model\.durationMs, opts\?\.minDragMs\)/.test(edit) && /userEdit\(/.test(edit));
  ok("the frame rate comes from the player (JS only)", /videoTrack\?\.frameRate/.test(edit));
  ok("the edge preview is its own paused player and ends when playback starts", /const edgePlayer = useVideoPlayer/.test(edit) && /if \(isPlaying && edgePreviewing\) handleEdgePreview\(null\)/.test(edit));
  ok("the timeline sits inside the editor's GestureHandlerRootView", /<GestureHandlerRootView style=\{\{ flex: 1 \}\}>/.test(edit));
  ok("the app version is untouched", /"version": "1\.0\.4"/.test(read("../app.json")));
}

// fling and zoom animation steps (JS, one call per frame)
{
  const v = flingStep(100, 800, 0.016, 5000);
  ok("a fling keeps moving and slows down", v.offset > 100 && v.velocity < 800 && v.velocity > 0 && !v.done);
  let o = 100, vel = 800, frames = 0, done = false;
  while (!done && frames < 1000) { const st = flingStep(o, vel, 0.016, 100000); o = st.offset; vel = st.velocity; done = st.done; frames++; }
  ok("...and ends by itself within a few seconds", done && frames < 400);
  eq("a fling stops at the start of the content", flingStep(3, -900, 0.016, 5000), { offset: 0, velocity: 0, done: true });
  eq("a fling stops at the end of the content", flingStep(4990, 900, 0.05, 5000), { offset: 5000, velocity: 0, done: true });
  eq("a long pause between frames never jumps far (the step is capped at 50 ms)", flingStep(0, 1000, 5, 100000).offset, 50);
  const a = { scale: 1, offset: 0 }, b = { scale: 3, offset: 100 };
  eq("the zoom animation starts at the old view and ends on the new one", [lerpView(a, b, 0), lerpView(a, b, 1)], [a, b]);
  ok("...eased: it moves fast first", lerpView(a, b, 0.5).scale > 2);
  eq("a bad easing input is clamped", [easeOutCubic(-1), easeOutCubic(2)], [0, 1]);
}

// ── 10. fail safe: the previous timeline takes over ──────────────────────────
{
  const memory = () => {
    const m = new Map();
    return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  };
  const B1 = "1.0.4+9:update-a";
  const B2 = "1.0.4+9:update-b";
  let st = memory();
  eq("nothing stored: the precision timeline is on", await readGuard(st, B1), { enabled: true, reason: null });
  await armGuard(st, B1, 1000);
  await disarmGuard(st, B1);
  eq("armed then disarmed (a normal visit): still on at the next start", (await readGuard(st, B1)).enabled, true);
  await armGuard(st, B1, 2000);
  eq("the app died while it was showing (still armed at the next start): off for this build", await readGuard(st, B1), { enabled: false, reason: "crash" });
  eq("...and it stays off at every start after", (await readGuard(st, B1)).enabled, false);
  eq("a new build or update gets another try", (await readGuard(st, B2)).enabled, true);
  await armGuard(st, B2, 3000);
  await disarmGuard(st, B2);
  eq("...and a visit of the new build that ends normally keeps it on", (await readGuard(st, B2)).enabled, true);
  // a caught error
  st = memory();
  await armGuard(st, B1, 1);
  await disableGuard(st, B1, "tap: boom");
  await disarmGuard(st, B1);   // the screen unmounts right after the failure
  eq("an error caught in the timeline turns it off, and the late disarm does not undo that", await readGuard(st, B1), { enabled: false, reason: "tap: boom" });
  await armGuard(st, B1, 5);
  eq("arming again does not turn it back on", (await readGuard(st, B1)).enabled, false);
  // writes happen in order even when asked for at the same moment
  st = memory();
  await Promise.all([armGuard(st, B1, 1), disableGuard(st, B1, "x"), disarmGuard(st, B1), armGuard(st, B1, 2)]);
  eq("arm, failure, disarm and arm in the same moment end as failed", JSON.parse(st.m.get(GUARD_KEY)).disabled, true);
  // storage trouble never blocks the screen
  const broken = { get: async () => { throw new Error("no storage"); }, set: async () => { throw new Error("no storage"); } };
  eq("unreadable storage: on, no throw", (await readGuard(broken, B1)).enabled, true);
  await armGuard(broken, B1, 1);
  await disableGuard(broken, B1, "x");
  ok("writing to broken storage does not throw", true);
  eq("garbage in storage is ignored", (await readGuard({ get: async () => "{nope", set: async () => {} }, B1)).enabled, true);

  const comp = read("../components/PrecisionTimeline.tsx");
  const guarded = read("../components/GuardedTimeline.tsx");
  const edit = read("../app/edit.tsx");
  ok("a render error shows the previous timeline (error boundary around the new one, fallback while unknown)", /getDerivedStateFromError/.test(guarded) && /componentDidCatch/.test(guarded) && /status !== "on"\) return <>\{fallback\}<\/>/.test(guarded));
  ok("the failure is recorded (client_errors) and remembered for this build", /recordClientError\(/.test(guarded) && /kind: "precisionTimeline"/.test(guarded) && /disableGuard\(/.test(guarded));
  ok("the crash marker is armed while it shows and disarmed on unmount / background", /armGuard\(/.test(guarded) && /disarmGuard\(/.test(guarded) && /AppState\.addEventListener/.test(guarded));
  const guardedHandlers = [...comp.matchAll(/guard\("([a-zA-Z.]+)"/g)].map((m) => m[1]);
  ok(`every gesture handler, the edge ticker and the buttons are guarded (${guardedHandlers.length} guards)`, ["pan.begin", "pan.start", "pan.update", "pan.end", "pan.finalize", "tap", "doubleTap", "pinch.begin", "pinch.start", "pinch.update", "pinch.finalize", "edgeTick", "nudge", "clear"].every((n) => guardedHandlers.includes(n)));
  ok("a guarded error goes to onFatal (the owner switches to the previous timeline)", /live\.current\.onFatal\?\.\(e, where\)/.test(comp));
  ok("a waveform failure only drops the waveform", /setWave\(null\)/.test(comp));
  ok("breadcrumbs: mounted, waveform ready, first gesture, edge drag started, guard on, edge preview player", /precision timeline: mounted/.test(comp) && /precision timeline: waveform ready/.test(comp) && /precision timeline: first \$\{kind\}/.test(comp) && /precision timeline: edge drag started/.test(comp) && /precision timeline: guard on, mounting/.test(guarded) && /onBreadcrumb=\{recordBreadcrumb\}/.test(guarded) && /precision timeline: edge preview player loading/.test(edit));
  ok("the fallback is the previous timeline, with the same props it had", /fallback=\{\s*<TimelineEditor/.test(edit) && /onReorderClips=\{handleReorderClips\}/.test(edit));
  ok("the frame rate and the edge preview player cannot throw into the screen", /Only reads: a player that does not answer/.test(edit) && /The frame preview is a nicety/.test(edit));
  ok("the waveform waits for the screen to settle, uses the cache first, and swallows failures", /setTimeout\(\(\) => \{\s*\(async \(\) => \{\s*try \{\s*let d = usable\(await analysis\.cachedLoudness/.test(comp) && /if \(!d && canAnalyze\)/.test(comp) && /canAnalyze: !autoEditRunning/.test(edit));
  // the cache lookup never starts an analysis
  let runsLoud = 0;
  const cache = createAnalysisCache({ stat: async (u) => ({ uri: u, size: 1, mtime: 1 }), loadLoudness: async () => { runsLoud++; return { durationMs: 1000, windows: [-30, -30] }; }, transcribe: async () => ({ status: "ok", words: [] }) });
  eq("cachedLoudness is null when nothing is cached and starts no analysis", [await cache.cachedLoudness("a.mov"), runsLoud], [null, 0]);
  await cache.loudness("a.mov");
  eq("after the analysis ran once, cachedLoudness returns it without running again", [(await cache.cachedLoudness("a.mov"))?.windows.length, runsLoud], [2, 1]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
