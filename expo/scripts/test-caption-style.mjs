#!/usr/bin/env node
/**
 * Clip selection while the rendered preview plays, and the clip-wide caption box
 * (size and position): clamp, snap, edit state, undo/redo, caption lines, render JSON.
 *
 *   node --experimental-strip-types scripts/test-caption-style.mjs
 */
import { clipOutputStartMs, planSelectionSeek, previewModeFor } from "../lib/previewSelection.ts";
import {
  CAPTION_STYLE_CONFIG, MIN_TOUCH_PT, captionBoxRect, clampCaptionStyle, defaultCaptionStyle, effectiveCaptionStyle, estimateBoxSize, halfBoxHeight,
  nativeCenterY, previewCenterY, settleCaptionStyle, snapCaptionStyle, touchRect, yCenterFromNative,
} from "../lib/transcription/captionStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { resolveOverlayStyle, toRenderJson } from "../lib/editStyles.ts";
import { clearCaptionStyle, mergePlan, newEditState, setCaptionStyle, setCategoryEnabled, makeDecision } from "../lib/autoEdit/decisions.ts";
import { emptyHistory, pushEdit, undoEdit, redoEdit, canUndo, canRedo } from "../lib/autoEdit/history.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });

// ── A: selecting a clip does not leave the rendered preview ──
{
  const durationOf = (c) => (c.trimEndMs ?? c.durationMs) - (c.trimStartMs ?? 0);
  const clips = [
    { id: "a", uri: "f", durationMs: 5000, trimStartMs: 500, trimEndMs: 2500 }, // 2000 ms
    { id: "b", uri: "f", durationMs: 5000, trimStartMs: 3000, trimEndMs: 4500 }, // 1500 ms
    { id: "c", uri: "f", durationMs: 5000, trimStartMs: 0, trimEndMs: 1000 }, // 1000 ms
  ];
  const before = JSON.stringify(clips);
  eq("rendered preview stays on whatever clip is selected (or none)", [null, "a", "b", "c"].map((selectedClipId) => previewModeFor({ aheadMatches: true, selectedClipId })), [true, true, true, true]);
  eq("...and an unmatched render is never preview, selected or not", [null, "b"].map((selectedClipId) => previewModeFor({ aheadMatches: false, selectedClipId })), [false, false]);
  eq("a clip starts at the sum of the effective durations before it on the output timeline", ["a", "b", "c", "zzz"].map((id) => clipOutputStartMs(clips, id, durationOf)), [0, 2000, 3500, null]);
  const rendered = (clipId, activeIndex = 0) => planSelectionSeek({ clips, clipId, activeIndex, previewMode: true, durationOf });
  eq("selecting in rendered preview only seeks the rendered file to the clip's output start", ["a", "b", "c"].map((id) => rendered(id)), [
    { kind: "rendered", outputMs: 0 }, { kind: "rendered", outputMs: 2000 }, { kind: "rendered", outputMs: 3500 },
  ]);
  eq("...even when that clip is the active one (no live player is involved)", rendered("b", 1), { kind: "rendered", outputMs: 2000 });
  eq("selection does not change the clips (so the render signature, a function of clips and captions, is untouched)", JSON.stringify(clips), before);
  eq("live playback: selecting another clip switches to it at its trim start", planSelectionSeek({ clips, clipId: "b", activeIndex: 0, previewMode: false, durationOf }), { kind: "live", index: 1, outputMs: 2000, sourceMs: 3000 });
  eq("live playback: selecting the active clip does nothing", planSelectionSeek({ clips, clipId: "a", activeIndex: 0, previewMode: false, durationOf }), null);
  eq("an unknown clip does nothing", planSelectionSeek({ clips, clipId: "x", activeIndex: 0, previewMode: true, durationOf }), null);
  // an actual edit (a trim) changes the clips, so the render no longer matches: that is the only way out
  const trimmed = clips.map((c) => (c.id === "b" ? { ...c, trimEndMs: 4000 } : c));
  eq("a trim changes what the render must show", JSON.stringify(trimmed) !== before, true);
}

// ── B: the caption box ──
const C = CAPTION_STYLE_CONFIG;
const ASPECT = 16 / 9;
{
  eq("config", [C.minScale, C.maxScale, C.safeTop, C.safeBottom, C.horizontalNative], [0.6, 2, 0.1, 0.75, false]);
  eq("the default is the preset's own box", [defaultCaptionStyle(), effectiveCaptionStyle(null), effectiveCaptionStyle(undefined)], [{ scale: 1, yCenter: 0.72, xCenter: 0.5 }, { scale: 1, yCenter: 0.72, xCenter: 0.5 }, { scale: 1, yCenter: 0.72, xCenter: 0.5 }]);
  eq("a stored style wins", effectiveCaptionStyle({ scale: 1.5, yCenter: 0.4, xCenter: 0.5 }).scale, 1.5);

  // scale limits
  eq("scale is limited to 0.6x..2x", [0.2, 0.6, 1, 2, 5].map((scale) => clampCaptionStyle({ scale, yCenter: 0.5, xCenter: 0.5 }, ASPECT).scale), [0.6, 0.6, 1, 2, 2]);
  // safe zone: the whole box stays between 10% and 75% of the frame height
  for (const scale of [0.6, 1, 2]) {
    const half = halfBoxHeight(scale, ASPECT);
    const lowest = clampCaptionStyle({ scale, yCenter: 0.99, xCenter: 0.5 }, ASPECT);
    const highest = clampCaptionStyle({ scale, yCenter: 0.0, xCenter: 0.5 }, ASPECT);
    eq(`scale ${scale}: dragged to the very bottom, the box's bottom edge stops at 75%`, Math.round((lowest.yCenter + half) * 1000), 750);
    eq(`scale ${scale}: dragged to the very top, the box's top edge stops at 10%`, Math.round((highest.yCenter - half) * 1000), 100);
  }
  eq("a position inside the safe zone is left alone", clampCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.5 }, ASPECT).yCenter, 0.5);
  eq("growing the box (pinch) near the bottom pushes it back inside the zone", (() => { const s = clampCaptionStyle({ scale: 2, yCenter: 0.7, xCenter: 0.5 }, ASPECT); return s.yCenter + halfBoxHeight(2, ASPECT) <= 0.75 + 1e-9; })(), true);

  // snap
  eq("within 4% of the horizontal centre snaps to it", [snapCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.53 }).snappedX, snapCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.53 }).style.xCenter], [true, 0.5]);
  eq("beyond that it does not", [snapCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.6 }).snappedX, snapCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.6 }).style.xCenter], [false, 0.6]);
  const h = { ...C, horizontalNative: true };
  eq("with native horizontal placement, x moves, snaps near the centre and is clamped inside the frame", [0.52, 0.56, 0.99, 0.01].map((x) => Math.round(settleCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: x }, ASPECT, h).style.xCenter * 1000) / 1000), [0.5, 0.56, 0.57, 0.43]);
  eq("while the renderer cannot place horizontally, x is locked to the centre", settleCaptionStyle({ scale: 1, yCenter: 0.5, xCenter: 0.9 }, ASPECT).style.xCenter, 0.5);
}

// ── B: the style lives in the edit state; undo / redo cover it ──
{
  const s0 = newEditState("file:///a.mov");
  const style = { scale: 1.4, yCenter: 0.55, xCenter: 0.5 };
  const s1 = setCaptionStyle(s0, style);
  eq("the style is stored in the edit state", [s0.captionStyle, s1.captionStyle], [undefined, style]);
  eq("setting the same style is not a change (not an undo step)", setCaptionStyle(s1, { ...style }) === s1, true);
  eq("the style survives planning, switches and a draft save", [
    mergePlan(s1, [makeDecision("silenceCut", 1000, 2000)], ["silenceCut"]).state.captionStyle,
    setCategoryEnabled(s1, "umCut", false).captionStyle,
    JSON.parse(JSON.stringify(s1)).captionStyle,
  ], [style, style, style]);

  let h = emptyHistory();
  h = pushEdit(h, s0);
  const s2 = setCaptionStyle(s1, { scale: 2, yCenter: 0.3, xCenter: 0.5 });
  h = pushEdit(h, s1);
  eq("two style changes are two undo steps", canUndo(h), true);
  const u1 = undoEdit(h, s2);
  eq("undo brings back the previous box", u1.state.captionStyle, style);
  const u2 = undoEdit(u1.history, u1.state);
  eq("undo again brings back the preset's own box", u2.state.captionStyle, undefined);
  eq("nothing left to undo", undoEdit(u2.history, u2.state), null);
  const r1 = redoEdit(u2.history, u2.state);
  const r2 = redoEdit(r1.history, r1.state);
  eq("redo walks forward again", [r1.state.captionStyle, r2.state.captionStyle, canRedo(r2.history)], [style, { scale: 2, yCenter: 0.3, xCenter: 0.5 }, false]);
}

// ── B: every caption follows the style, across lines and cut changes ──
{
  const style = { scale: 1.3, yCenter: 0.45, xCenter: 0.5 };
  const talk = [w("one", 0, 400), w("two", 450, 800), w("three", 850, 1200), w("four", 2500, 2900), w("five", 2950, 3300), w("six", 3350, 3700)];
  const whole = [{ startMs: 0, endMs: 4000 }];
  const cut = [{ startMs: 0, endMs: 1500 }, { startMs: 2400, endMs: 4000 }];
  const a = captionLinesToEditOverlays(buildCaptionLines(talk, {}, whole, style), style);
  const b = captionLinesToEditOverlays(buildCaptionLines(talk, {}, cut, style), style);
  eq("every caption line carries the same style", [a.length > 1, a.every((o) => JSON.stringify(o.captionStyle) === JSON.stringify(style))], [true, true]);
  eq("...and still does after the cuts change (the lines move, the style does not)", [b.length > 1, b.every((o) => JSON.stringify(o.captionStyle) === JSON.stringify(style)), JSON.stringify(a.map((o) => [o.startMs, o.endMs])) !== JSON.stringify(b.map((o) => [o.startMs, o.endMs]))], [true, true, true]);
  eq("without a style the overlays are as before (no captionStyle field)", captionLinesToEditOverlays(buildCaptionLines(talk, {}, whole)).some((o) => "captionStyle" in o), false);

  // a bigger box means narrower lines
  const long = [w("something", 0, 300), w("different", 350, 650), w("tomorrow", 700, 1000), w("afternoon", 1050, 1300), w("remember", 1350, 1600), w("absolutely", 1650, 1900)];
  const k = [{ startMs: 0, endMs: 2000 }];
  const normal = buildCaptionLines(long, {}, k, { scale: 1, yCenter: 0.72, xCenter: 0.5 });
  const big = buildCaptionLines(long, {}, k, { scale: 2, yCenter: 0.72, xCenter: 0.5 });
  eq("at 2x fewer words fit on a line (lines never overflow the box)", [normal.length >= 1, Math.max(...big.map((l) => l.text.split(" ").length)) < Math.max(...normal.map((l) => l.text.split(" ").length))], [true, true]);
}

// ── B: the render JSON reflects scale and position ──
{
  const style = { scale: 1.5, yCenter: 0.4, xCenter: 0.5 };
  const lines = buildCaptionLines([w("hi", 100, 400), w("there", 450, 900)], {}, [{ startMs: 0, endMs: 1000 }], style);
  const json = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(lines, style) }));
  const spec = json.overlays[0].styleSpec;
  eq("render JSON: font size, padding and corner scaled by the box's scale", [spec.fontSize, spec.backgroundPadding, spec.cornerRadius], [38 * 1.5, 15 * 1.5, 10 * 1.5]);
  eq("render JSON: vertical position comes from the box; the centred x is left out (the default)", [spec.yCenter, spec.xCenter], [0.4, undefined]);
  const moved = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(lines, { ...style, xCenter: 0.6 }) })).overlays[0].styleSpec;
  eq("render JSON: an x other than the centre is sent", moved.xCenter, 0.6);
  eq("render JSON: the fades stay at least 1 ms", [spec.fadeInMs, spec.fadeOutMs], [1, 1]);
  const plain = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([w("hi", 100, 400)], {}, [{ startMs: 0, endMs: 1000 }])) })).overlays[0].styleSpec;
  eq("without a style the preset is sent unchanged", [plain.fontSize, plain.yCenter, plain.xCenter], [38, 0.72, undefined]);
  // the default style reproduces the look from before the controls existed
  const preset = resolveOverlayStyle("caption", "trial");
  const before = JSON.stringify({ ...preset, fadeInMs: 1, fadeOutMs: 1 });
  const lone = [w("hi", 100, 400)];
  const keep = [{ startMs: 0, endMs: 1000 }];
  const noStyle = JSON.stringify(JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines(lone, {}, keep)) })).overlays[0].styleSpec);
  const defStyle = JSON.stringify(JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines(lone, {}, keep, defaultCaptionStyle()), defaultCaptionStyle()) })).overlays[0].styleSpec);
  eq("no style: the render spec is exactly the preset (yCenter 0.70, scale 1) with the 1 ms fades", noStyle, before);
  eq("the DEFAULT style gives the identical render spec", defStyle, before);
  eq("...and the same caption lines", JSON.stringify(buildCaptionLines(lone, {}, keep, defaultCaptionStyle())), JSON.stringify(buildCaptionLines(lone, {}, keep)));
  eq("a different scale or position changes the overlay JSON (so the render signature changes and re-renders)", JSON.stringify(captionLinesToEditOverlays(lines, style)) !== JSON.stringify(captionLinesToEditOverlays(lines, { ...style, yCenter: 0.5 })), true);
}

// ── the overlay layout: measured box, 44 pt touch target, position mapping ──
{
  const frame = { w: 360, h: 640 };
  const style = defaultCaptionStyle();
  const LONGER = "so I have to go now please ok but only if it is really truly quite alright with you today";
  const est = estimateBoxSize("SO I HAVE", style, frame.w);
  eq("the estimated box has a real size (never collapsed)", [est.w > 0, est.h > 0], [true, true]);
  eq("it is as tall as the text plus padding (38 * 1.25 + 30 units, at 360/1080)", Math.round(est.h * 100) / 100, Math.round(((38 * 1.25 + 30) * 360 / 1080) * 100) / 100);
  eq("a longer text is wider, and wraps at the maximum width into two lines (taller)", [estimateBoxSize(LONGER, style, frame.w).h > est.h, estimateBoxSize(LONGER, style, frame.w).w <= 0.86 * frame.w + 1e-6], [true, true]);
  const box = { w: 200, h: 60 };
  const rect = captionBoxRect(frame, style, box);
  eq("the overlay rect is the text box: same height, centred at the style's position (72% from the top)", [rect.height, rect.width, rect.top + rect.height / 2, rect.left + rect.width / 2], [60, 200, 0.72 * 640, 0.5 * 360]);
  eq("a box taller than 44 pt is its own touch target", touchRect(rect), rect);
  const thin = captionBoxRect(frame, style, { w: 200, h: 12 });
  const t = touchRect(thin);
  eq("a thin box gets a 44 pt target, same centre, never smaller than the box", [t.height, t.top + t.height / 2, thin.top + thin.height / 2, t.width >= 200], [MIN_TOUCH_PT, thin.top + thin.height / 2, thin.top + thin.height / 2, true]);
  const tiny = touchRect(captionBoxRect(frame, style, { w: 10, h: 0 }));
  eq("even a zero-height box has a 44 x 44 touch target", [tiny.width, tiny.height], [44, 44]);

  // preview <-> native: Core Animation's origin is bottom-left, VideoRenderModule flips: y = height * (1 - yCenter)
  eq("native flips: yCenter 0.70 from the top is 30% of the height from the bottom", Math.round(nativeCenterY(1920, 0.7) * 1e6) / 1e6, 576);
  eq("preview and native centres add up to the frame height (same spot, mirrored axis)", [0.1, 0.4, 0.7, 0.75].map((y) => Math.abs(previewCenterY(1920, y) + nativeCenterY(1920, y) - 1920) < 1e-9), [true, true, true, true]);
  eq("the mapping round-trips preview -> native -> preview", [0.1, 0.35, 0.7, 0.75].map((y) => Math.abs(yCenterFromNative(1920, nativeCenterY(1920, y)) - y) < 1e-9), [true, true, true, true]);
  eq("the default caption is drawn at 72% in the preview and at 28% from the bottom natively", [previewCenterY(640, style.yCenter), Math.round(nativeCenterY(640, style.yCenter) * 1e6) / 1e6].map((n) => Math.round(n * 100) / 100), [460.8, 179.2].map((n) => Math.round(n * 100) / 100));

  // the stored style can be cleared again (Reset); undoable like any change
  const s1 = setCaptionStyle(newEditState("u"), { scale: 1.2, yCenter: 0.5, xCenter: 0.5 });
  eq("Reset removes the stored style and keeps nothing else", [clearCaptionStyle(s1).captionStyle, "captionStyle" in clearCaptionStyle(s1), clearCaptionStyle(newEditState("u")) === clearCaptionStyle(newEditState("u"))], [undefined, false, false]);
  const fresh = newEditState("u");
  eq("clearing a state without a style changes nothing", clearCaptionStyle(fresh) === fresh, true);
  // a box too tall for the zone stays inside it (not thrown to the middle)
  const tall = clampCaptionStyle({ scale: 2, yCenter: 0.12, xCenter: 0.5 }, 0.2);
  eq("a box taller than the zone keeps its centre inside the zone", [tall.yCenter >= 0.1, tall.yCenter <= 0.75, tall.yCenter], [true, true, 0.12]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
