#!/usr/bin/env node
/**
 * Full-screen editor, TikTok style: the slim progress bar with replay and time above Next (nothing overlaps on a 375 pt
 * iPhone), the tool column and top bar stepping back while playing / dragging, and new texts placed left of the column.
 *   node --experimental-strip-types --no-warnings scripts/test-editor-transport.mjs
 */
import { readFileSync } from "node:fs";
import { E_NEXT, E_PROGRESS, E_TOOLS, E_TRANSPORT, chromeVisibility, editorRects, overlappingPairs, transportRects } from "../lib/editorChrome.ts";
import { PLAYING_CHROME_OPACITY, chromeFade, estimateTextSize, newTextPlacement, overlayScreenRect, toolColumnLeft } from "../lib/editorFade.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const idle = { step: "edit", textEditing: false, panelOpen: false, keyboardUp: false, hasSelection: false, isPlaying: false, pendingPlay: false, readyLabelActive: false };

// ── the bottom of the editor ──
{
  const phones = [{ w: 320, h: 568, b: 0 }, { w: 375, h: 667, b: 0 }, { w: 375, h: 812, b: 34 }, { w: 390, h: 844, b: 34 }, { w: 430, h: 932, b: 34 }];
  for (const p of phones) {
    const screen = { w: p.w, h: p.h, insetTop: p.b ? 47 : 20, insetBottom: p.b };
    for (const playing of [false, true]) {
      const rects = editorRects(screen, chromeVisibility({ ...idle, isPlaying: playing }));
      eq(`${p.w}x${p.h} ${playing ? "playing" : "paused"}: nothing overlaps (progress bar, replay, time, Next, tools, top bar, play icon)`, overlappingPairs(rects), []);
    }
    const t = transportRects({ w: p.w, h: p.h, insetBottom: p.b });
    const next = { x: p.w - E_NEXT.right - E_NEXT.width, y: p.h - p.b - E_NEXT.bottomOffset - E_NEXT.height, w: E_NEXT.width, h: E_NEXT.height };
    ok(`${p.w}: the time ("0:03 / 0:48") has ${E_TRANSPORT.timeWidth} pt and ends left of where Next begins; the bar sits above Next`, t.time.x + t.time.w < next.x && t.progress.y + t.progress.h <= next.y - E_PROGRESS.gapAboveNext + 0.5);
    ok(`${p.w}: the progress bar spans the width between the side margins, replay and time sit above it on the left`, t.progress.x === E_PROGRESS.side && t.progress.w === p.w - 2 * E_PROGRESS.side && t.replay.y + t.replay.h <= t.progress.y && t.replay.x === t.progress.x && t.time.x > t.replay.x + t.replay.w);
  }
  eq("the bottom controls are there when nothing is selected or open, and give way to a selection, a panel, typing", [chromeVisibility(idle).transport, chromeVisibility({ ...idle, hasSelection: true }).transport, chromeVisibility({ ...idle, panelOpen: true }).transport, chromeVisibility({ ...idle, textEditing: true }).transport, chromeVisibility({ ...idle, step: "cuts" }).transport], [true, false, false, false, false]);
  eq("the center play icon shows only while paused", [chromeVisibility(idle).playButton, chromeVisibility({ ...idle, isPlaying: true }).playButton], [true, false]);
}

// ── fading ──
{
  const column = { x: 309, y: 120, w: 56, h: 160 };
  eq("paused: everything at full strength", chromeFade({ isPlaying: false, gesturing: false, selectedRect: null, columnRect: column }), { topBar: 1, toolColumn: 1 });
  eq("playing: the top bar and the tool column step back to 40%", chromeFade({ isPlaying: true, gesturing: false, selectedRect: null, columnRect: column }), { topBar: PLAYING_CHROME_OPACITY, toolColumn: PLAYING_CHROME_OPACITY });
  eq("dragging or pinching an overlay or the caption: both fade out", chromeFade({ isPlaying: false, gesturing: true, selectedRect: null, columnRect: column }), { topBar: 0, toolColumn: 0 });
  eq("...also while playing", chromeFade({ isPlaying: true, gesturing: true, selectedRect: null, columnRect: column }), { topBar: 0, toolColumn: 0 });
  eq("a selected overlay under the column fades the column (the top bar stays)", chromeFade({ isPlaying: false, gesturing: false, selectedRect: { x: 250, y: 150, w: 120, h: 40 }, columnRect: column }), { topBar: 1, toolColumn: 0 });
  eq("...one clear of it does not", chromeFade({ isPlaying: false, gesturing: false, selectedRect: { x: 20, y: 150, w: 200, h: 40 }, columnRect: column }).toolColumn, 1);
  eq("...nor one at the same height but left of it", chromeFade({ isPlaying: false, gesturing: false, selectedRect: { x: 100, y: 130, w: 200, h: 40 }, columnRect: column }).toolColumn, 1);
}

// ── new texts left of the tool column ──
{
  const W = 375, left = toolColumnLeft(W);
  eq("the column starts 66 pt from the right edge", [left, W - E_TOOLS.right - E_TOOLS.width], [309, 309]);
  const maxWidth = W * 0.86;
  for (const text of ["Hi", "Make it count", "This is a much longer sentence for a title", "A\nB\nC"]) {
    const spot = newTextPlacement({ text, fontSize: 30, frameW: W, maxWidth });
    const size = estimateTextSize(text, 30, spot.scale, maxWidth);
    ok(`"${text.replace(/\n/g, "/")}": centred left of the column and inside it (right edge ${Math.round(spot.centerPx + size.w / 2)} <= ${left})`, spot.centerPx - size.w / 2 >= 11 && spot.centerPx + size.w / 2 <= left && spot.scale >= 0.5 && spot.scale <= 1);
  }
  eq("a short text keeps full size, a long one is made smaller so its box fits (never below half)", [newTextPlacement({ text: "Hi", fontSize: 30, frameW: W, maxWidth }).scale, newTextPlacement({ text: "x".repeat(60), fontSize: 30, frameW: W, maxWidth }).scale], [1, 0.88]);
  const near = overlayScreenRect({ text: "Hello there", fontSize: 30, scale: 1, centerX: 300, centerY: 150, maxWidth });
  ok("an estimated overlay rectangle is centred where the overlay is", Math.abs(near.x + near.w / 2 - 300) < 1 && Math.abs(near.y + near.h / 2 - 150) < 1);
}

// ── the screen ──
{
  const edit = read("../app/edit.tsx");
  const tr = read("../components/EditorTransport.tsx");
  ok("one play control: the red bottom play button is gone; the soft round icon shows while paused", !/<PlaybackControls\s+floating/.test(edit) && /<PlayIndicator visible=\{vis\.playButton\}/.test(edit));
  ok("tapping the video toggles play/pause, below the overlays and controls", /accessibilityLabel=\{isPlaying \? "Pause" : "Play"\}[\s\S]{0,700}togglePlay\(\)/.test(edit));
  ok("the progress bar scrubs (seek) and plays on after a scrub that interrupted playback; replay restarts from 0", /onSeek=\{handleSeekAny\}/.test(edit) && /onResume=\{\(\) => setTimeout\(\(\) => setIsPlaying\(true\), 60\)\}/.test(edit) && /onReplay=\{handleReplay\}/.test(edit));
  ok("the top bar and the tool column fade (FadeView) from chromeFade", /<FadeView style=\{\[styles\.eTopBar/.test(edit) && /<FadeView style=\{\[styles\.eTools/.test(edit) && /const fade = chromeFade\(/.test(edit) && /guideGesture\.active/.test(edit));
  ok("new texts are placed and sized left of the tool column", /newTextPlacement\(\{/.test(edit) && /spot\.scale < 1/.test(edit));
  ok("crash-safe: the scrub gesture runs on the JS thread and the animated styles are transform only", /Gesture\.Pan\(\)\s*\.runOnJS\(true\)/.test(tr) && !/['"]worklet['"]|runOnUI|useAnimatedReaction|withTiming|withSpring/.test(tr) && (tr.match(/useAnimatedStyle\(\(\) => \(\{ transform:/g) ?? []).length === 2);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
