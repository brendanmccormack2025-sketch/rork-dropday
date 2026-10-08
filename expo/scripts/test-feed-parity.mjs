#!/usr/bin/env node
/**
 * The editor preview matches the feed: cover-crop math, safe-zone rectangles, text overlay layout
 * (preview vs render numbers), cleaner default styles, and an unchanged render JSON otherwise.
 *
 *   node --experimental-strip-types scripts/test-feed-parity.mjs
 */
import { readFileSync } from "node:fs";
import {
  FEED_CHROME, TAB_BAR_HEIGHT, TEXT_LINE_HEIGHT_EM, TEXT_MAX_WIDTH, TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_RADIUS_EM, VIDEO_ASPECT,
  DEFAULT_TEXT_OVERLAY_POS, computeCoverCrop, feedAspect, textBoxHeight, fitFrame, fracToFrame, frameToFrac, safeZones, textLayout, textOverlayRenderSpec, videoDisplayWidth, wrapLines,
} from "../lib/feedLayout.ts";
import { CAPTION_STYLES, TEXT_STYLES, resolveOverlayStyle, toRenderJson } from "../lib/editStyles.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function ok(name, cond) { eq(name, !!cond, true); }

// ── A: the preview's crop is the feed's crop ──
{
  // The feed's original in-component formula, kept here as the reference.
  const feedOriginal = (cw, ch, va) => {
    const ca = cw / ch;
    if (va < ca) { const vh = ch / (cw / va); return { visibleW: 1, visibleH: vh, cropLeft: 0, cropTop: (1 - vh) / 2 }; }
    const vw = cw / (ch * va);
    return { visibleW: vw, visibleH: 1, cropLeft: (1 - vw) / 2, cropTop: 0 };
  };
  const screens = [[390, 844], [393, 852], [430, 932], [375, 667], [360, 800], [820, 1180]];
  let same = true;
  for (const [w, h] of screens) {
    same &&= JSON.stringify(computeCoverCrop(w, h, VIDEO_ASPECT)) === JSON.stringify(feedOriginal(w, h, VIDEO_ASPECT));
    // The editor frame is the same shape, so it crops the same fractions at any size.
    const frame = fitFrame(300, 420, feedAspect(w, h));
    same &&= near(computeCoverCrop(frame.w, frame.h, VIDEO_ASPECT).visibleW, computeCoverCrop(w, h, VIDEO_ASPECT).visibleW, 1e-9);
    same &&= near(computeCoverCrop(frame.w, frame.h, VIDEO_ASPECT).cropTop, computeCoverCrop(w, h, VIDEO_ASPECT).cropTop, 1e-9);
  }
  ok("editor crop == feed crop on phones and a tablet, at any frame size", same);
  const tall = computeCoverCrop(390, 844, VIDEO_ASPECT);
  ok("a tall phone crops the sides of a 9:16 video", tall.visibleW < 1 && tall.cropLeft > 0 && tall.visibleH === 1);
  ok("an exactly 9:16 screen crops nothing", near(computeCoverCrop(360, 640, VIDEO_ASPECT).visibleW, 1) && computeCoverCrop(360, 640, VIDEO_ASPECT).cropLeft === 0);
  eq("a degenerate container is uncropped", computeCoverCrop(0, 0, VIDEO_ASPECT), { visibleW: 1, visibleH: 1, cropLeft: 0, cropTop: 0 });
  const f = fitFrame(300, 420, 390 / 844);
  ok("the frame has the feed's aspect and fits the area", near(f.w / f.h, 390 / 844, 1e-9) && f.w <= 300 + 1e-9 && f.h <= 420 + 1e-9);
  const feed = readFileSync(new URL("../components/FeedItem.tsx", import.meta.url), "utf8");
  const edit = readFileSync(new URL("../app/edit.tsx", import.meta.url), "utf8");
  ok("FeedItem uses the shared crop (no local copy)", feed.includes('from "@/lib/feedLayout"') && !/function computeCoverCrop/.test(feed));
  ok("the editor uses the shared crop and fills (cover) the preview", edit.includes("computeCoverCrop(frameDims.w") && !edit.includes('contentFit="contain"'));
  const p = fracToFrame(0.3, 0.4, 200, 400, tall);
  const q = frameToFrac(p.x, p.y, 200, 400, tall);
  ok("frame pixels and video fractions convert back and forth", near(q.x, 0.3) && near(q.y, 0.4));
  ok("the video centre is the frame centre", near(fracToFrame(0.5, 0.5, 200, 400, tall).x, 100) && near(fracToFrame(0.5, 0.5, 200, 400, tall).y, 200));
}

// ── B: safe zones ──
{
  const sw = 390, sh = 844, top = 47;
  const z = safeZones(sw, sh, sw, top);
  const c = FEED_CHROME;
  eq("logo: left padding, below the top inset, 72 x 22", [z.logo.x, z.logo.y, z.logo.w, z.logo.h], [c.headerPadX, top + c.headerPadTop, 72, 22]);
  eq("bell: 36 square, right padding 18", [z.bell.w, z.bell.h, z.bell.x + z.bell.w], [36, 36, sw - c.headerPadX]);
  eq("rail: 12 from the right edge, 36 wide", [z.rail.x + z.rail.w, z.rail.w], [sw - c.railRight, c.railIcon]);
  eq("rail: bottom edge 22 above the tab bar", z.rail.y + z.rail.h, sh - (TAB_BAR_HEIGHT + c.railBottomOffset));
  eq("bottom bar: left 18, stops 84 from the right, bottom 24 above the tab bar", [z.bottom.x, z.bottom.x + z.bottom.w, z.bottom.y + z.bottom.h], [c.bottomLeft, sw - c.bottomRight, sh - (TAB_BAR_HEIGHT + c.bottomOffset)]);
  const inside = (r, w, h) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  ok("every zone is inside the frame", Object.values(z).every((r) => inside(r, sw, sh)));
  ok("no two zones overlap", !overlap(z.logo, z.bell) && !overlap(z.rail, z.bottom) && !overlap(z.rail, z.bell) && !overlap(z.bottom, z.logo));
  // Scaled to a small editor frame, the zones keep their proportions.
  const small = safeZones(195, 422, sw, top);
  ok("zones scale with the frame (half size = half the numbers)", near(small.rail.w * 2, z.rail.w) && near(small.bottom.h * 2, z.bottom.h) && near(small.logo.x * 2, z.logo.x));
  ok("scaled zones still sit at the same fractions of the frame", near(small.rail.y / 422, z.rail.y / sh, 1e-9) && near(small.bell.x / 195, z.bell.x / sw, 1e-9));
}

// ── C: text overlay layout, preview vs render ──
{
  const texts = {
    "a long text": "Lease trouble? Here is everything the landlord does not want you to know before you sign",
    "an emoji": "Lease trouble 😳",
    "multi-line text": "First line\nSecond line is a little longer\nThird",
  };
  for (const fontSize of [26, 40, 72]) {
    const render = textOverlayRenderSpec(fontSize);
    for (const [label, text] of Object.entries(texts)) {
      const refLines = wrapLines(text, render.fontSize, render.maxWidth * 1080 - 2 * render.backgroundPaddingX);
      let same = true;
      for (const videoW of [180, 250, 390, 520, 1080]) {
        const l = textLayout(fontSize, videoW);
        same &&= JSON.stringify(wrapLines(text, l.fontSize, l.maxWidth - 2 * l.padX)) === JSON.stringify(refLines);
      }
      ok(`${label} @${fontSize}: same lines in the preview (any width) and the render`, same);
    }
    const l = textLayout(fontSize, 390);
    ok(`size @${fontSize}: preview numbers are the render's, scaled by width (font, padding, corner, max width)`,
      near(l.fontSize / 390, render.fontSize / 1080) && near(l.padX / 390, render.backgroundPaddingX / 1080) && near(l.padY / 390, render.backgroundPaddingY / 1080) && near(l.cornerRadius / 390, render.cornerRadius / 1080) && near(l.maxWidth / 390, render.maxWidth));
  }
  eq("a long text wraps to several lines, a short emoji greeting at a modest size to one", [wrapLines(texts["a long text"], 26 * 1.56, 390 * 0.86 - 2 * 26 * 1.56 * 0.3).length > 2, wrapLines("Lease trouble 😳", 16 * 1.56, 390 * 0.86 - 2 * 16 * 1.56 * 0.3).length], [true, 1]);
  eq("multi-line text keeps its three lines", wrapLines(texts["multi-line text"], 20, 4000).length, 3);
  const l = textLayout(26, 250);
  eq("cleaner style: radius 0.25 em, padding 0.6 em across / 0.35 em down, line height 1.25 em", [l.cornerRadius / l.fontSize, l.padX / l.fontSize, l.padY / l.fontSize, l.lineHeight / l.fontSize], [TEXT_RADIUS_EM, TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_LINE_HEIGHT_EM]);
  eq("the text box never exceeds 0.86 of the video width", textLayout(26, 400).maxWidth, 400 * TEXT_MAX_WIDTH);
  // On a tall phone the video is wider than the screen: text is sized from the whole video, as the render does.
  const crop = computeCoverCrop(390, 844, VIDEO_ASPECT);
  ok("text is sized from the whole video width (wider than a tall screen)", videoDisplayWidth(390, crop) > 390 && near(videoDisplayWidth(390, crop), 844 * VIDEO_ASPECT));
}

// ── C2: the box around the text (emoji must not inflate it) ──
{
  const spec = textOverlayRenderSpec(26);
  for (const videoW of [250, 390, 1080]) {
    const l = textLayout(26, videoW);
    const plain = textBoxHeight("Bruhh", l);
    const emoji = textBoxHeight("Bruhh \u{1F633}", l);
    ok(`@${videoW}: "Bruhh" and "Bruhh 😳" boxes are the same height (one fixed line)`, near(plain, emoji));
    ok(`@${videoW}: box height = one line + 0.35 em above and below (equal space)`, near(emoji, l.lineHeight + 2 * l.padY));
    ok(`@${videoW}: the preview's box height is the render's, scaled`, near(emoji / videoW, (spec.fontSize * spec.lineHeight + 2 * spec.backgroundPaddingY) / 1080));
  }
  const l = textLayout(26, 390);
  eq("two lines are two line heights plus the same padding", textBoxHeight("one\ntwo", l), 2 * l.lineHeight + 2 * l.padY);
  ok("padding is wider across (0.6 em) than down (0.35 em), like captions", near(l.padX / l.padY, 0.6 / 0.35));
  // New overlays start clear of the feed's logo and bell.
  const frameW = 195, frameH = 422;
  const z = safeZones(frameW, frameH, 390, 47);
  const lay = textLayout(26, frameW);
  const top = DEFAULT_TEXT_OVERLAY_POS.y * frameH - textBoxHeight("Bruhh \u{1F633}", lay) / 2;
  ok("a new overlay's top edge is below the logo and the bell", top > Math.max(z.logo.y + z.logo.h, z.bell.y + z.bell.h));
  eq("a new overlay is horizontally centred", DEFAULT_TEXT_OVERLAY_POS.x, 0.5);
  const edit = readFileSync(new URL("../app/edit.tsx", import.meta.url), "utf8");
  ok("the editor creates new text overlays at that position", edit.includes("DEFAULT_TEXT_OVERLAY_POS.y"));
}

// ── D: default styles ──
{
  const trial = resolveOverlayStyle("caption", "trial");
  const hook = resolveOverlayStyle("text", undefined);
  eq("Trial caption: corner radius about 0.3 x font size", Math.abs(trial.cornerRadius - trial.fontSize * 0.3) < 1, true);
  ok("Trial caption: even padding of about 0.4 em (the old renderer's one value)", Math.abs(trial.backgroundPadding - 0.475 * trial.fontSize) < 1);
  eq("default text style: corner radius 0.25 x font size", hook.cornerRadius, hook.fontSize * 0.25);
  const json = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: [
    { kind: "caption", text: "x", style: "trial", startMs: 0, endMs: 500 },
    { kind: "text", text: "y", startMs: 0, endMs: 500 },
  ] }));
  ok("render JSON of the default caption includes cornerRadius", json.overlays[0].styleSpec.cornerRadius === 11);
  ok("render JSON of the default text overlay includes cornerRadius", json.overlays[1].styleSpec.cornerRadius === 21);
  // Nothing else changed: the old specs with only these numbers put back are exactly today's.
  eq("Trial caption: the new default (smaller, normal case, lower, rounded)",
    json.overlays[0].styleSpec,
    { fontSize: 38, fontWeight: "heavy", color: "#FFFFFF", backgroundColor: "#000000", backgroundPadding: 18, cornerRadius: 11, yCenter: 0.72, maxWidth: 0.86, fadeInMs: 1, fadeOutMs: 1 });
  eq("default text style: only padding and corner differ from before",
    (({ backgroundPadding, cornerRadius, ...rest }) => rest)(json.overlays[1].styleSpec),
    { fontSize: 84, fontWeight: "black", color: "#FFFFFF", yCenter: 0.22, uppercase: true, shadow: true, letterSpacing: 1, fadeInMs: 150, fadeOutMs: 150 });
  const others = [...CAPTION_STYLES.filter((p) => p.id !== "trial"), ...TEXT_STYLES.filter((p) => p.id !== "hook")].map((p) => p.id);
  eq("every other preset is untouched (ids)", others, ["clean", "bold", "highlight", "minimal", "creator", "emphasis", "quote", "callout", "title"]);
  eq("clean caption preset is unchanged", resolveOverlayStyle("caption", "clean"), { fontSize: 54, fontWeight: "bold", color: "#FFFFFF", yCenter: 0.74, shadow: true, fadeInMs: 80, fadeOutMs: 80 });
  eq("creator caption preset is unchanged", resolveOverlayStyle("caption", "creator").cornerRadius, 20);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
