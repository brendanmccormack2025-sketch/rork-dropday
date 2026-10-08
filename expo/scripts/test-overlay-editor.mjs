#!/usr/bin/env node
/**
 * The editor shows a text overlay exactly as it posts: the same lines and box (scaled) in the editor's
 * small preview, the full-screen Preview, the feed and the render; and one set of code behind them.
 *
 *   node --experimental-strip-types scripts/test-overlay-editor.mjs
 */
import { readFileSync } from "node:fs";
import { usableCaptionStyle } from "../lib/transcription/captionStyle.ts";
import {
  MONTSERRAT_BOLD_EM, TEXT_MAX_WIDTH, VIDEO_ASPECT, computeCoverCrop, fitFrame, feedAspect, lineWidth, overlayBox, overlayFont, overlayFontFamily, textLayout, textOverlayRenderSpec, textSlot, videoDisplayWidth, wrapLines,
} from "../lib/feedLayout.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const texts = {
  short: "Hi",
  long: "Lease trouble? Here is everything the landlord does not want you to know before you sign the paper",
  emoji: "Bruhh \u{1F633}",
  "multi-line": "First line\nSecond line is a little longer\nThird",
};

// ── the editor's frame, the full-screen Preview, the feed and the render, all through the same crop ──
const screens = [[390, 844], [430, 932], [375, 667]];
for (const [label, text] of Object.entries(texts)) {
  for (const fontSize of [20, 26, 48]) {
    for (const [sw, sh] of screens) {
      const editorFrame = fitFrame(300, 380, feedAspect(sw, sh));
      const editorVideoW = videoDisplayWidth(editorFrame.w, computeCoverCrop(editorFrame.w, editorFrame.h, VIDEO_ASPECT));
      const feedVideoW = videoDisplayWidth(sw, computeCoverCrop(sw, sh, VIDEO_ASPECT));
      const renderSpec = textOverlayRenderSpec(fontSize);
      const editor = overlayBox(text, fontSize, editorVideoW);
      const feed = overlayBox(text, fontSize, feedVideoW);
      const render = overlayBox(text, fontSize, 1080);
      const same = JSON.stringify(editor.lines) === JSON.stringify(feed.lines) && JSON.stringify(feed.lines) === JSON.stringify(render.lines);
      ok(`${label} @${fontSize} on ${sw}x${sh}: same line breaks in the editor, Preview and render`, same);
      ok(`${label} @${fontSize} on ${sw}x${sh}: box size scales exactly (editor / video width == render / 1080)`,
        near(editor.width / editorVideoW, render.width / 1080) && near(editor.height / editorVideoW, render.height / 1080) && near(feed.height / feedVideoW, render.height / 1080));
      ok(`${label} @${fontSize}: the render numbers give the same box height`, near(render.height, render.lines.length * renderSpec.fontSize * renderSpec.lineHeight + 2 * renderSpec.backgroundPaddingY));
    }
  }
}

// ── the width model is Montserrat Bold's ──
{
  eq("average character width: Montserrat Bold, 0.62 em", MONTSERRAT_BOLD_EM, 0.62);
  eq("a line of 10 characters is 6.2 em wide at the default; an emoji counts 1.1 em", [Math.round(lineWidth("abcdefghij", 10)), Math.round(lineWidth("\u{1F633}", 10))], [62, 11]);
  ok("Montserrat is wider than the old model, so the same text wraps no later", wrapLines(texts.long, 20, 200).length >= wrapLines(texts.long, 20, 200, 0.55).length);
  ok("the widest line fits the slot in every case", Object.values(texts).every((t) => {
    const b = overlayBox(t, 26, 250);
    return b.width <= 250 * TEXT_MAX_WIDTH + 1e-9;
  }));
}

// ── nothing editor-only ──
{
  const l = textLayout(26, 200);
  eq("max box width is 0.86 of the video width, whatever the size", [l.maxWidth, textSlot(100, 200).width], [200 * TEXT_MAX_WIDTH, 200 * TEXT_MAX_WIDTH]);
  eq("the slot is centred on the overlay's point", [textSlot(100, 200).left + textSlot(100, 200).width / 2], [100]);
  eq("the slot is the same width at any position, so the text wraps the same everywhere", [10, 100, 190].map((c) => textSlot(c, 200).width), [172, 172, 172]);
  eq("Text-button overlays are Montserrat Bold by default, on every build", [overlayFontFamily(undefined), overlayFont(undefined)], ["Montserrat_700Bold", { fontFamily: "Montserrat_700Bold", fontWeight: "400" }]);
  eq("a font chosen in Style is kept", [overlayFontFamily("avenir"), overlayFontFamily("classic")], ["AvenirNext-Heavy", "Montserrat_800ExtraBold"]);
  eq("the system font choice drops the family (no Montserrat)", overlayFontFamily("trial"), undefined);
  eq("an unknown font id falls back to Montserrat Bold", overlayFontFamily("nope"), "Montserrat_700Bold");
  eq("captions keep the capability guard: no font and no style on build 39", [usableCaptionStyle(undefined, false), usableCaptionStyle(undefined, true).fontId], [undefined, "classic"]);

  const editor = read("../components/DraggableTextOverlay.tsx");
  const feed = read("../components/FeedItem.tsx");
  const edit = read("../app/edit.tsx");
  ok("the editor takes font size, padding, line height and corner from textLayout (the feed's function)", (editor.match(/textLayout\(effectiveFontSize\(/g) ?? []).length >= 3);
  ok("the editor has no size or width constants of its own", !/maxBoxWidth|TEXT_PAD_|TEXT_RADIUS_EM|TEXT_LINE_HEIGHT_EM|TEXT_REF_WIDTH/.test(editor));
  ok("the editor lays out in a fixed slot (textSlot width), and the feed does the same", /slotW = videoW \* TEXT_MAX_WIDTH/.test(editor) && /textSlot\(left, videoW\)/.test(feed));
  ok("both use the shared overlay font (no build check)", /overlayFont\(overlay\.fontId\)/.test(editor) && /overlayFont\(overlay\.fontId\)/.test(feed) && !/supportsCaptionFont/.test(editor + feed.slice(feed.indexOf("FeedTextOverlay"), feed.indexOf("function timeAgo"))));
  ok("Montserrat Bold is loaded with the app's fonts", /Montserrat_700Bold/.test(read("../app/_layout.tsx")));
  ok("both ignore the phone's text-size setting", /allowFontScaling=\{false\}/.test(editor) && /allowFontScaling=\{false\}/.test(feed));
  ok("both draw the shadow only without a background, with the same radius", /textShadowRadius: 4/.test(editor) && /textShadowRadius: 4/.test(feed));
  ok("the full-screen Preview draws overlays with the feed's component", /FeedTextOverlay/.test(read("../components/EditPreviewModal.tsx")));
  ok("while typing, the text on the video is drawn by the same editor component and values", /displayOverlays\.map\(\(ov\) => \(\s*<DraggableTextOverlay/.test(edit));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
