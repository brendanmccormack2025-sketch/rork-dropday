#!/usr/bin/env node
/**
 * TikTok-style text backgrounds (a rounded background per line, as wide as that line, never full width), the
 * padding and corner proportions, and pinch resizing of text overlays and captions.
 *
 *   node --experimental-strip-types scripts/test-text-backgrounds.mjs
 */
import { readFileSync } from "node:fs";
import { BG_PAD_X_EM, BG_PAD_Y_EM, BG_RADIUS_EM, backgroundGeometry, pathPoints } from "../lib/lineBackground.ts";
import { TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_RADIUS_EM, textLayout } from "../lib/feedLayout.ts";
import { toRenderJson, withTextBox, resolveOverlayStyle } from "../lib/editStyles.ts";
import { CAPTION_STYLE_CONFIG, settleCaptionStyle, defaultCaptionStyle } from "../lib/transcription/captionStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { MAX_OVERLAY_SCALE, MIN_OVERLAY_SCALE, clampScale } from "../lib/textOverlayStyle.ts";
import { emptyHistory, pushEdit, undoEdit, redoEdit } from "../lib/autoEdit/history.ts";
import { newEditState, setCaptionStyle } from "../lib/autoEdit/decisions.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── per-line backgrounds ──
{
  const padX = 24, padY = 14, r = 12, L = 40;
  const lines = [{ width: 200 }, { width: 120 }, { width: 160 }];
  const g = backgroundGeometry(lines, L, padX, padY, r, "lines");
  eq("each line's background is exactly its text width + 2 x padding", g.rects.map((x) => x.w), [248, 168, 208]);
  eq("the shape is as wide as the widest line + padding, never more", g.width, 248);
  ok("lines are centred on one axis", g.rects.every((x) => near(x.x + x.w / 2, 124)));
  ok("the lines stack touching, top and bottom padding on the ends", near(g.rects[0].y, 0) && near(g.rects[0].y + g.rects[0].h, g.rects[1].y) && near(g.rects[1].y + g.rects[1].h, g.rects[2].y) && near(g.rects[2].y + g.rects[2].h, g.height) && near(g.height, 3 * L + 2 * padY));
  const pts = pathPoints(g.path);
  ok("the outline never leaves the widest line's width (no banner)", pts.every((p) => p.x >= -1e-6 && p.x <= 248 + 1e-6 && p.y >= -1e-6 && p.y <= g.height + 1e-6));
  ok("a narrower line's side is inset from the wider one (the outline follows each line)", pts.some((p) => near(p.x, 124 + 84)) && pts.some((p) => near(p.x, 124 - 84)));
  ok("closed outline", g.path.endsWith("Z") && g.path.startsWith("M"));

  const wrapped = backgroundGeometry([{ width: 90 }, { width: 70 }], L, padX, padY, r, "lines");
  ok("two short lines in a wide slot (maxWidth 400): the background is 138 wide, not 400", wrapped.width === 138 && wrapped.width < 400);

  const one = backgroundGeometry([{ width: 100 }], L, padX, padY, r, "lines");
  eq("one line: a single rounded box of that line's width", [one.rects.length, one.width], [1, 148]);

  const box = backgroundGeometry(lines, L, padX, padY, r, "box");
  eq("box mode (older builds): one box hugging the widest line", [box.rects.length, box.width, box.rects[0].w], [1, 248, 248]);

  const equal = backgroundGeometry([{ width: 100 }, { width: 100 }], L, padX, padY, r, "lines");
  ok("lines of equal width form a plain rounded rectangle outline", equal.rects[0].w === equal.rects[1].w && pathPoints(equal.path).every((p) => p.x >= 0 && p.x <= 148));
}

// ── proportions ──
{
  eq("0.6 em across, 0.35 em down, corners 0.3 em", [BG_PAD_X_EM, BG_PAD_Y_EM, BG_RADIUS_EM], [0.6, 0.35, 0.3]);
  const l = textLayout(26, 390);
  eq("text overlays use them (editor and feed share textLayout)", [l.padX / l.fontSize, l.padY / l.fontSize, l.cornerRadius / l.fontSize], [TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_RADIUS_EM]);
  eq("and the same numbers", [TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_RADIUS_EM], [0.6, 0.35, 0.3]);
  const trial = resolveOverlayStyle("caption", "trial");
  const modern = withTextBox(trial, true, true);
  eq("captions on 1.0.4: 0.6 em across, 0.35 em down, per-line backgrounds", [modern.backgroundPaddingX / modern.fontSize, modern.backgroundPaddingY / modern.fontSize, modern.lineBackground], [0.6, 0.35, true]);
  const j = (caps) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([{ text: "break my lease", startMs: 0, endMs: 900 }], {}, [{ startMs: 0, endMs: 1000 }])) }, caps)).overlays[0].styleSpec;
  eq("build 39: no per-line key, no new padding keys: one box hugging the widest line", [j({}).lineBackground, j({}).backgroundPaddingX], [undefined, undefined]);
  eq("1.0.4 with the capability: lineBackground in the render JSON", j({ supportsTextBox: true, supportsLineBackgrounds: true }).lineBackground, true);
  eq("1.0.4 text box without per-line support: still no lineBackground", j({ supportsTextBox: true }).lineBackground, undefined);

  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("Swift draws a background per line for captions, gated by the key and the flag", /style\["lineBackground"\]/.test(swift) && /supportsLineBackgrounds/.test(swift) && /lineBackgroundPath/.test(swift));
  ok("Swift without the key still draws one box as wide as the widest line (textWidth)", /container\.bounds = CGRect\(x: 0, y: 0, width: textWidth \+ 2 \* padX/.test(swift));
  ok("the module exposes the flag", /supportsLineBackgrounds/.test(read("../modules/video-render/index.ts")));
}

// ── one component draws them everywhere ──
{
  const hug = read("../components/HuggingText.tsx");
  ok("the background comes from the measured line widths", /onTextLayout/.test(hug) && /backgroundGeometry\(/.test(hug));
  ok("the Text itself never carries a background color (that is the banner)", !/backgroundColor/.test(hug.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  const drag = read("../components/DraggableTextOverlay.tsx");
  const feed = read("../components/FeedItem.tsx");
  const cap = read("../components/CaptionPreview.tsx");
  ok("editor and feed text overlays use HuggingText in per-line mode", /<HuggingText[\s\S]{0,400}mode="lines"/.test(drag) && /<HuggingText[\s\S]{0,500}mode="lines"/.test(feed));
  ok("captions use it too: per line where the build can, else one hugging box", /mode=\{supportsLineBackgrounds \? "lines" : "box"\}/.test(cap));
}

// ── pinch: text overlays and captions ──
{
  eq("text overlay scale limits", [MIN_OVERLAY_SCALE, MAX_OVERLAY_SCALE, clampScale(0.01), clampScale(99)], [0.4, 4, 0.4, 4]);
  const drag = read("../components/DraggableTextOverlay.tsx");
  ok("text overlay pinch is live and smooth (box scale while the fingers are down)", /pinchSv\.value = clampScale\(baseScale \* e\.scale\) \/ baseScale/.test(drag) && /scalePulse\.value \* pinchSv\.value/.test(drag));
  ok("and is stored on release (persists), together with a simultaneous drag", /scale: clampScale\(scaleSv\.value \* pinchSv\.value\)/.test(drag) && /Gesture\.Simultaneous\(/.test(drag));
  ok("not tied to selection", !/isSelected/.test(drag.slice(drag.indexOf("const gesture = useMemo"), drag.indexOf("// ── Animated styles"))));

  const aspect = 16 / 9;
  const grown = settleCaptionStyle({ scale: 10, yCenter: 0.72, xCenter: 0.5 }, aspect).style;
  const shrunk = settleCaptionStyle({ scale: 0.01, yCenter: 0.72, xCenter: 0.5 }, aspect).style;
  eq("caption size is clamped to the config's min and max", [grown.scale <= CAPTION_STYLE_CONFIG.maxScale, shrunk.scale >= CAPTION_STYLE_CONFIG.minScale], [true, true]);
  let st = newEditState([], []);
  let h = emptyHistory();
  const before = st;
  h = pushEdit(h, before);
  st = setCaptionStyle(st, { ...defaultCaptionStyle(), scale: 1.6 });
  eq("a caption pinch is stored in the edit state", st.captionStyle.scale, 1.6);
  const u = undoEdit(h, st);
  eq("undo returns to the old size", u.state.captionStyle, undefined);
  const r = redoEdit(u.history, u.state);
  eq("redo brings the pinched size back", r.state.captionStyle.scale, 1.6);
  const c = read("../components/CaptionPreview.tsx");
  ok("caption pinch is live and smooth (the drawn box is scaled while the fingers are down)", /transform: \[\{ scale: pinchLive \}\]/.test(c) && /setPinchLive\(/.test(c));
  ok("and commits the clip-wide size on release", /onStyleCommit\?\.\(result\)/.test(c));
  ok("captions pinch whether selected or not, with a generous touch area", /TOUCH_PAD/.test(c) && !/if \(!selected\) return/.test(c));
  // The export uses the same clip-wide scale
  const spec = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([{ text: "hi", startMs: 0, endMs: 500 }], {}, [{ startMs: 0, endMs: 1000 }], { ...defaultCaptionStyle(), scale: 1.6 }), { ...defaultCaptionStyle(), scale: 1.6 }) }, {})).overlays[0].styleSpec;
  eq("the export render carries the pinched size (38 x 1.6)", Math.round(spec.fontSize * 100) / 100, 60.8);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
