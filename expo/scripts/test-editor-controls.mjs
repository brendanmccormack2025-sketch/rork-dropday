#!/usr/bin/env node
/**
 * Full-screen editor controls: visible AND tappable in every state; a style change is never shown out of date; Back works
 * from every state.
 *   node --experimental-strip-types --no-warnings scripts/test-editor-controls.mjs
 */
import { readFileSync } from "node:fs";
import { CHROME_AWAKE_MS, GESTURE_CHROME_OPACITY, MIN_CHROME_OPACITY, PLAYING_CHROME_OPACITY, chromeFade } from "../lib/editorFade.ts";
import { backAction, backStep } from "../lib/editorFlow.ts";
import { captionLookKey, drawCaptionsLive, lookSignature, overlayLookKey, renderedPreviewCarriesCaptions } from "../lib/previewFreshness.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const column = { x: 320, y: 120, w: 56, h: 200 };

// ── 1. visible in every state ──
{
  let n = 0, bad = 0;
  for (const isPlaying of [false, true]) for (const gesturing of [false, true]) for (const awake of [false, true]) for (const editing of [false, true])
    for (const selectedRect of [null, { x: 330, y: 150, w: 100, h: 40 }, { x: 10, y: 10, w: 50, h: 20 }]) {
      const f = chromeFade({ isPlaying, gesturing, awake, editing, selectedRect, columnRect: column });
      n++;
      for (const v of [f.topBar, f.toolColumn]) if (!(Number.isFinite(v) && v >= MIN_CHROME_OPACITY && v <= 1)) bad++;
    }
  eq(`${n} states: both containers always between ${MIN_CHROME_OPACITY} and 1, never 0`, bad, 0);
  const calm = (a) => chromeFade({ gesturing: false, selectedRect: null, columnRect: column, ...a });
  eq("paused: full strength", calm({ isPlaying: false }), { topBar: 1, toolColumn: 1 });
  eq("playing: 60%", calm({ isPlaying: true }), { topBar: PLAYING_CHROME_OPACITY, toolColumn: PLAYING_CHROME_OPACITY });
  eq("playing but touched a moment ago: full strength", calm({ isPlaying: true, awake: true }), { topBar: 1, toolColumn: 1 });
  eq("playing with a sheet / the text editor / the keyboard open: full strength", calm({ isPlaying: true, editing: true }), { topBar: 1, toolColumn: 1 });
  eq("dragging: 35%, not hidden", calm({ isPlaying: false, gesturing: true }), { topBar: GESTURE_CHROME_OPACITY, toolColumn: GESTURE_CHROME_OPACITY });
  eq("a nonsense opacity cannot hide the controls", chromeFade({ isPlaying: NaN, gesturing: false, selectedRect: null, columnRect: null }).topBar, 1);
  ok("the controls wake for a few seconds", CHROME_AWAKE_MS >= 2000 && CHROME_AWAKE_MS <= 5000);
}

// ── 2. tappable: the container never blocks touches, icons render inside it ──
{
  const bits = read("../components/EditorChromeBits.tsx");
  const fade = bits.slice(bits.indexOf("export function FadeView"));
  ok("FadeView is a plain View (no animation driver on the controls)", /<View pointerEvents="box-none"/.test(fade) && !/Animated\./.test(fade) && !/useNativeDriver/.test(fade));
  ok("FadeView never turns touches off", !/pointerEvents=\{?["']none["']/.test(fade) && !/opacity === 0/.test(fade));
  ok("FadeView clamps to the floor (never 0)", /Math\.max\(MIN_CHROME_OPACITY/.test(fade));
  const edit = read("../app/edit.tsx");
  const top = edit.slice(edit.indexOf("<FadeView style={[styles.eTopBar"), edit.indexOf("</FadeView>", edit.indexOf("<FadeView style={[styles.eTopBar")));
  const tools = edit.slice(edit.indexOf("<FadeView style={[styles.eTools"), edit.indexOf("</FadeView>", edit.indexOf("<FadeView style={[styles.eTools")));
  ok("the top bar holds Back, Undo and Redo with their icons", /label="Back"[\s\S]*<ArrowLeft/.test(top) && /label="Undo"[\s\S]*<Undo2/.test(top) && /label="Redo"[\s\S]*<Redo2/.test(top));
  ok("the tool column holds Text, Captions and Cuts with their icons", /label="Text"[\s\S]*<Type/.test(tools) && /label="Captions"[\s\S]*<Captions/.test(tools) && /label="Cuts"[\s\S]*<Scissors/.test(tools));
  ok("no pointerEvents none on the top bar or the tool column", !/pointerEvents="none"/.test(top + tools));
  ok("the editor wakes the controls on any touch", /onTouchStart=\{wakeChrome\}/.test(edit) && /const wakeChrome = useCallback/.test(edit));
  ok("fade gets awake and editing", /awake: chromeAwake/.test(edit) && /editing: textEditorVisible \|\| panelOpen \|\| keyboardH > 0/.test(edit));
  const tr = read("../components/EditorTransport.tsx");
  const styles = tr.slice(tr.indexOf("const styles = StyleSheet.create"));
  const replay = /replay: \{[^}]*\}/.exec(styles)[0], time = /time: \{[^}]*\}/.exec(styles)[0];
  ok("no translucent panel behind the replay icon or the time", !/backgroundColor/.test(replay) && !/backgroundColor/.test(time));
  ok("the time stays readable on any video (text shadow)", /textShadowColor/.test(styles));
}

// ── 3. a style change is never shown out of date ──
{
  const base = { fontId: "anton", textColor: "white", backgroundColor: "black", uppercase: false, shadow: true, outline: "thin", outlineColor: "black" };
  const k0 = captionLookKey(base);
  for (const [name, patch] of [["font", { fontId: "caveat" }], ["text colour", { textColor: "red" }], ["background", { backgroundColor: "none" }], ["case", { uppercase: true }], ["shadow", { shadow: false }], ["outline", { outline: "thick" }], ["outline colour", { outlineColor: "red" }]]) {
    ok(`a caption ${name} change makes a new look key`, captionLookKey({ ...base, ...patch }) !== k0);
  }
  ok("moving or resizing the caption is not a look change (a drag never remounts)", captionLookKey({ ...base, scale: 2, yCenter: 0.3, xCenter: 0.2 }) === k0);
  const ov = { id: "a", fontId: "anton", color: "#FFFFFF", outline: true, outlineColor: "#000000", stroke: "thin", shadow: true, background: false, bgColor: "#000000" };
  const o0 = overlayLookKey(ov);
  for (const [name, patch] of [["font", { fontId: "caveat" }], ["text colour", { color: "#FF0000" }], ["outline", { outline: false }], ["outline colour", { outlineColor: "#FF0000" }], ["stroke", { stroke: "thick" }], ["shadow", { shadow: false }], ["background", { background: true }], ["background colour", { bgColor: "#FF0000" }], ["old preset", { backgroundStyle: "white-box" }]]) {
    ok(`a text ${name} change makes a new look key`, overlayLookKey({ ...ov, ...patch }) !== o0);
  }
  ok("moving, rotating or pinching a text is not a look change", overlayLookKey({ ...ov, x: 0.2, y: 0.9, rotation: 40, scale: 3, text: "other" }) === o0);
  const sig = lookSignature(base, [ov]);
  ok("the signature changes with any caption or text look", lookSignature({ ...base, textColor: "red" }, [ov]) !== sig && lookSignature(base, [{ ...ov, color: "#FF0000" }]) !== sig);
  ok("the signature changes when a text is added or removed", lookSignature(base, []) !== sig);
  const burned = { includesCaptions: true, lookSignature: sig };
  ok("a rendered file with burned-in captions carries them while its look is current", renderedPreviewCarriesCaptions(burned, sig) && !drawCaptionsLive(burned, sig));
  ok("...and is stale the moment the look changes: the live drawing takes over", !renderedPreviewCarriesCaptions(burned, lookSignature({ ...base, textColor: "red" }, [ov])) && drawCaptionsLive(burned, lookSignature({ ...base, textColor: "red" }, [ov])));
  ok("a rendered file without captions never hides the live ones", drawCaptionsLive({ includesCaptions: false, lookSignature: sig }, sig) && drawCaptionsLive(null, sig));
  const edit = read("../app/edit.tsx");
  ok("the caption preview is remounted by its look key and is never told to hide itself while stale", /<CaptionPreview\s+key=\{captionLookKey\(captionStyle\)\}/.test(edit) && /invisible=\{!drawCaptionsLive\(null, lookSignature\(captionStyle, textOverlays\)\)\}/.test(edit));
  ok("a text's drawing is remounted by its look key", /<OverlayText key=\{overlayLookKey\(overlay\)\}/.test(read("../components/DraggableTextOverlay.tsx")));
  ok("the editor never plays a file with burned-in captions (the preview render has none)", /new RenderAhead\(\{ includeCaptions: false \}\)/.test(edit));
  const sheet = read("../components/CaptionStyleSheet.tsx");
  ok("the caption style sheet does not dim the video and reports its height", /backdrop: \{[^}]*backgroundColor: "transparent"/.test(sheet) && /onHeight\?\.\(e\.nativeEvent\.layout\.height\)/.test(sheet));
  ok("the video lifts clear of the style sheet so the caption stays visible while styling", /\(captionsPanelOpen \|\| styleSheetOpen\) && isVideo/.test(edit) && /styleSheetOpen \? styleSheetH : captionsSheetH/.test(edit));
  ok("a caption edited on the video no longer depends on lifting the video: it has its own bar above the keyboard (test-caption-edit-bar.mjs)", !/captionInlineEdit|inlineCaptionEdit/.test(edit) && /<CaptionEditBar/.test(edit));
}

// ── 4. Back from every state ──
{
  const closed = { textEditorVisible: false, styleSheetOpen: false, captionsPanelOpen: false, markerSheetOpen: false, cutsSheetOpen: false, explainerVisible: false, hasSelection: false };
  const st = (step, over = {}, isVideo = true) => ({ step, isVideo, ...closed, ...over });
  eq("Cuts screen -> leave", backAction(st("cuts")), { type: "exit" });
  eq("full-screen editor -> Cuts screen (video)", backAction(st("edit")), { type: "step", to: "cuts" });
  eq("full-screen editor of a photo -> leave", backAction(st("edit", {}, false)), { type: "exit" });
  eq("Post -> full-screen editor", backAction(st("post")), { type: "step", to: "edit" });
  const order = [
    ["textEditorVisible", "textEditor"], ["styleSheetOpen", "styleSheet"], ["captionsPanelOpen", "captionsPanel"],
    ["markerSheetOpen", "markerSheet"], ["cutsSheetOpen", "cutsSheet"], ["explainerVisible", "explainer"],
  ];
  for (const step of ["cuts", "edit", "post"]) for (const [flag, what] of order) {
    eq(`${step}: ${flag} -> closes it first`, backAction(st(step, { [flag]: true })), { type: "close", what });
  }
  eq("the full-screen editor drops a selection first", backAction(st("edit", { hasSelection: true })), { type: "close", what: "selection" });
  eq("a selection does not block Back on the other screens", backAction(st("cuts", { hasSelection: true })), { type: "exit" });
  eq("everything open at once: topmost first", backAction(st("edit", Object.fromEntries([...order.map(([f]) => [f, true]), ["hasSelection", true]]))), { type: "close", what: "textEditor" });
  // walk: from the worst state, Back always gets all the way out, and never loops
  let state = st("edit", Object.fromEntries([...order.map(([f]) => [f, true]), ["hasSelection", true]]));
  const flagOf = { textEditor: "textEditorVisible", styleSheet: "styleSheetOpen", captionsPanel: "captionsPanelOpen", markerSheet: "markerSheetOpen", cutsSheet: "cutsSheetOpen", explainer: "explainerVisible", selection: "hasSelection" };
  let presses = 0, last = null;
  for (; presses < 20; presses++) {
    const a = backAction(state);
    if (a.type === "exit") { last = a; break; }
    state = a.type === "close" ? { ...state, [flagOf[a.what]]: false } : { ...state, step: a.to };
  }
  eq("from every sheet open on the full-screen editor, Back closes 7 things and steps once, then the 9th press leaves", [last?.type, presses], ["exit", 8]);
  eq("the step order agrees with backStep", [backStep("post", { isVideo: true }), backStep("edit", { isVideo: true }), backStep("cuts", { isVideo: true })], ["edit", "cuts", "exit"]);
  const edit = read("../app/edit.tsx");
  ok("the Back buttons on every screen call the same decision", (edit.match(/onPress=\{handleBackPress\}/g) ?? []).length === 3 && /const handleBackPress = \(\) => \{\s*performBack\(\);/.test(edit));
  ok("Back pauses playback before changing the step", /setIsPlaying\(false\);\s*if \(action\.type === "exit"\)/.test(edit));
  ok("each sheet has its closing call", /handleTextEditorCancel\(\)/.test(edit) && /setStyleSheetOpen\(false\)/.test(edit) && /setCaptionsPanelOpen\(false\)/.test(edit) && /setMarkerSheet\(null\)/.test(edit) && /handleCloseCuts\(\)/.test(edit) && /captions\.onNotNow\(\)/.test(edit));
  ok("Android's back button closes a sheet first, then walks the steps; it leaves through the navigator", /return backRef\.current\(true\)/.test(edit) && /if \(fromHardware\) return false/.test(edit));
  ok("the Back decision is set after every hook (no hook after an early return)", edit.indexOf("backRef.current = performBack") > edit.indexOf("// ── Empty state"));
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
