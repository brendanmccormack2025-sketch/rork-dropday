#!/usr/bin/env node
/**
 * Editor polish: only the controls for the current task are visible and nothing overlaps (every state, every phone
 * size down to 375 pt), the Preview ready label and play button, smooth multi-line backgrounds, the Captions panel,
 * one copy of the text while typing.
 *   node --experimental-strip-types --no-warnings scripts/test-editor-polish.mjs
 */
import { readFileSync } from "node:fs";
import { CAPTIONS_EDIT_BAR_HEIGHT, CAPTIONS_SHEET_MAX_FRACTION, E_NEXT, READY_LABEL_FADE_MS, READY_LABEL_SHOW_MS, captionLift, chromeVisibility, editorRects, overlappingPairs } from "../lib/editorChrome.ts";
import { backgroundGeometry, snapNeighbours, pathPoints } from "../lib/lineBackground.ts";
import { EDITOR_TOOL_IDS } from "../lib/editorToolbar.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const base = { step: "edit", textEditing: false, panelOpen: false, keyboardUp: false, hasSelection: false, isPlaying: false, pendingPlay: false, readyLabelActive: true };
const none = { topBar: false, toolColumn: false, next: false, selectionBar: false, playButton: false, readyLabel: false };

// ── visibility ──
eq("idle editor: top bar, tools, Next, play button and the ready label", chromeVisibility(base), { topBar: true, toolColumn: true, next: true, selectionBar: false, playButton: true, readyLabel: true });
eq("typing text: no top bar, no tool column, no ready label, no play button (only the text editor's own Cancel / Aa / check)", chromeVisibility({ ...base, textEditing: true, keyboardUp: true }), none);
eq("any open panel hides everything else", chromeVisibility({ ...base, panelOpen: true }), none);
eq("the keyboard alone hides everything else", chromeVisibility({ ...base, keyboardUp: true }), none);
eq("a selection shows its bar and hides the tool column, Next, play button and label", chromeVisibility({ ...base, hasSelection: true }), { ...none, topBar: true, selectionBar: true });
eq("playing: the play button is gone", chromeVisibility({ ...base, isPlaying: true }).playButton, false);
eq("waiting for the preview: no play button", chromeVisibility({ ...base, pendingPlay: true }).playButton, false);
eq("the controls return when the panel closes", chromeVisibility({ ...base, panelOpen: false }), chromeVisibility(base));
eq("the Cuts screen has no editor chrome; its play button follows the same rules", [chromeVisibility({ ...base, step: "cuts" }).topBar, chromeVisibility({ ...base, step: "cuts" }).playButton, chromeVisibility({ ...base, step: "cuts", panelOpen: true }).playButton], [false, true, false]);
eq("the tool column: Text, Captions, Cuts (no Style: it lives in the Captions panel and the caption's own bar)", [...EDITOR_TOOL_IDS], ["text", "captions", "cuts"]);

// ── nothing overlaps: every state on every phone size ──
const phones = [
  { name: "iPhone SE 375x667", w: 375, h: 667, insetTop: 20, insetBottom: 0 },
  { name: "iPhone mini 375x812", w: 375, h: 812, insetTop: 50, insetBottom: 34 },
  { name: "iPhone 15 393x852", w: 393, h: 852, insetTop: 59, insetBottom: 34 },
  { name: "iPhone Pro Max 430x932", w: 430, h: 932, insetTop: 59, insetBottom: 34 },
];
let overlapsFound = [];
for (const ph of phones) {
  for (const hasSelection of [false, true])
    for (const barOnTop of [false, true])
      for (const isPlaying of [false, true]) {
        const v = chromeVisibility({ ...base, hasSelection, isPlaying });
        const pairs = overlappingPairs(editorRects(ph, v, { barOnTop }));
        if (pairs.length) overlapsFound.push(`${ph.name} sel=${hasSelection} top=${barOnTop} play=${isPlaying}: ${pairs.map((p) => p.join("/")).join(",")}`);
      }
}
eq("no two controls overlap in any state on any phone size (375 pt included)", overlapsFound, []);

// ── Preview ready ──
eq("Preview ready: about 1.5 s, then a short fade", [READY_LABEL_SHOW_MS, READY_LABEL_FADE_MS], [1500, 300]);
const bits = read("../components/EditorChromeBits.tsx"), edit = read("../app/edit.tsx");
ok("the label fades out after its window and never shows under a panel / selection", /setTimeout\([\s\S]*READY_LABEL_SHOW_MS/.test(bits) && /toValue: 0/.test(bits) && /hidden=\{!vis\.readyLabel\}/.test(edit));
ok("play button: round, semi-transparent, fades out", /borderRadius: E_PLAY\.size \/ 2/.test(bits) && /rgba\(0,0,0,0\.35\)/.test(bits) && /toValue: visible \? 1 : 0/.test(bits) && /<PlayIndicator visible=\{vis\.playButton\}/.test(edit));

// ── smooth multi-line backgrounds ──
eq("neighbouring lines that differ by less than two corner radii join at the wider width (no staircase / T)", snapNeighbours([200, 215, 100], 12), [215, 215, 100]);
eq("lines that differ more keep their width (they meet through a concave corner)", snapNeighbours([200, 100, 200], 12), [200, 100, 200]);
{
  const g = backgroundGeometry([{ width: 100 }, { width: 108 }, { width: 100 }], 40, 18, 10, 12, "lines");
  eq("near-equal lines draw one smooth block", g.rects.map((r) => r.w), [144, 144, 144]);
  const g2 = backgroundGeometry([{ width: 80 }, { width: 200 }], 40, 18, 10, 12, "lines");
  ok("a narrow line over a wide one has an inward-curving (concave) corner and a convex outer corner", /A12 12 0 0 0/.test(g2.path) && /A12 12 0 0 1/.test(g2.path));
  ok("the outline stays inside the shape", pathPoints(g2.path).every((p) => p.x >= -1e-6 && p.x <= g2.width + 1e-6));
}
ok("editor, feed and captions draw the same shape (one component)", ["../components/DraggableTextOverlay.tsx", "../components/CaptionPreview.tsx", "../components/FeedItem.tsx"].every((f) => /HuggingText/.test(read(f))));

// ── text editing: one copy, in place ──
const te = read("../components/TextOverlayEditor.tsx");
ok("the field is the finished text's own look (HuggingText mirror + TextInput), not a separate boxed input", /<HuggingText[\s\S]*<TextInput/.test(te) && !/fieldBox/.test(te));
ok("the overlay being edited is hidden on the video (no dimmed duplicate)", /textEditorVisible && editingOverlayId \? textOverlays\.filter/.test(edit) && !/liveText/.test(edit));
ok("the editor's own row is Cancel, Aa and the check", /Cancel/.test(te) && /Change text style/.test(te) && /accessibilityLabel="Done"/.test(te));
ok("while typing: top bar, tools, labels and play button are driven by one visibility object", /\{vis\.topBar && \(/.test(edit) && /\{vis\.toolColumn && \(/.test(edit) && /vis\.selectionBar \?/.test(edit) && /vis\.next \?/.test(edit));

// ── Captions panel ──
const sheet = read("../components/CaptionsSheet.tsx");
ok("a clean row with a switch replaces the red-bordered card", /styles\.titleRow/.test(sheet) && !/offCard|borderWidth: 1\.5/.test(sheet));
ok("half height at most, with the keyboard avoided", CAPTIONS_SHEET_MAX_FRACTION <= 0.5 && /maxHeight: Math\.round\(windowH \* CAPTIONS_SHEET_MAX_FRACTION\)/.test(sheet) && /KeyboardAvoidingView/.test(sheet));
ok("editing a line: a compact bar above the keyboard, the line always visible", CAPTIONS_EDIT_BAR_HEIGHT <= 80 && /editingLine \? \(/.test(sheet) && /autoFocus/.test(sheet));
ok("the video slides up so the caption stays visible above the panel / keyboard", /previewLift > 0 && \{ transform: \[\{ translateY: -previewLift \}\] \}/.test(edit) && /onHeight=\{setCaptionsSheetH\}/.test(edit));
eq("caption lift: none when it is already above the panel; the exact overlap otherwise", [captionLift({ frameTop: 0, frameHeight: 800, captionYFrac: 0.4, captionHalfHeight: 40, visibleBottom: 480 }), captionLift({ frameTop: 0, frameHeight: 800, captionYFrac: 0.8, captionHalfHeight: 40, visibleBottom: 480 })], [0, 212]);
ok("Style has one entry in the editor's tools: none (the Captions panel and the caption bar keep it)", !/label="Style" onPress=\{\(\) => setStyleSheetOpen/.test(edit) && /onStyle=\{\(\) =>/.test(edit));
ok("the speech note never sits over the tool column or the selection bar", /\(step !== "edit" \|\| vis\.next\)/.test(edit) && E_NEXT.height > 0);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
