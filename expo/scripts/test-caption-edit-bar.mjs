#!/usr/bin/env node
/**
 * Editing a caption from the video: the bar above the keyboard (components/CaptionEditBar.tsx). It exists, sits at the
 * keyboard's height, saves through captions.editLine on Done / the keyboard's Done key / a tap outside, discards on Back, works
 * from both entry points (double tap and the toolbar's Edit), and the text field is no longer on the video.
 *   node --experimental-strip-types --no-warnings scripts/test-caption-edit-bar.mjs
 */
import { readFileSync } from "node:fs";
import { CAPTION_BAR, captionBarBottom } from "../lib/editorChrome.ts";
import { changeCaptionDraft, discardCaptionDraft, finishCaptionDraft, startCaptionDraft } from "../lib/captionDraft.ts";
import { backAction } from "../lib/editorFlow.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── where the bar sits ──
eq("with a keyboard up the bar is exactly its height above the bottom (the keyboard's height already includes the home indicator)", [captionBarBottom(336, 34), captionBarBottom(291, 0)], [336, 291]);
eq("no keyboard (hardware keyboard, the instant before the soft one shows): the safe-area inset", [captionBarBottom(0, 34), captionBarBottom(0, 0)], [34, 0]);
eq("nonsense never moves the bar off screen", [captionBarBottom(NaN, 20), captionBarBottom(-5, 20), captionBarBottom(0, NaN), captionBarBottom(Infinity, 8)], [20, 20, 0, 8]);
ok("the video is dimmed, only slightly", CAPTION_BAR.dim > 0 && CAPTION_BAR.dim <= 0.6);

// ── the draft: Done saves once, Back saves nothing ──
{
  const d = startCaptionDraft(3, "My eye is");
  const typed = changeCaptionDraft(d, "My eye is twitching");
  eq("typing changes the draft, not the line", [d.text, typed.text, typed.index], ["My eye is", "My eye is twitching", 3]);
  eq("Done saves that line with the typed text and closes the draft", finishCaptionDraft(typed), { draft: null, save: { index: 3, text: "My eye is twitching" } });
  eq("pressing Done twice (the button, then the keyboard's Done key) saves once", [finishCaptionDraft(finishCaptionDraft(typed).draft).save], [null]);
  eq("Back discards: nothing is saved", discardCaptionDraft(), { draft: null, save: null });
  eq("typing with no draft open does nothing", changeCaptionDraft(null, "x"), null);
  eq("an emptied line is saved as the person left it (the same path as today)", finishCaptionDraft(changeCaptionDraft(d, "")).save, { index: 3, text: "" });
}

// ── Back closes the bar first, discarding ──
{
  const state = { step: "edit", isVideo: true, captionEditing: true, textEditorVisible: true, styleSheetOpen: true, captionsPanelOpen: true, markerSheetOpen: true, cutsSheetOpen: true, explainerVisible: true, hasSelection: true };
  eq("Back with the bar up closes it before anything else", backAction(state), { type: "close", what: "captionEdit" });
  eq("without it, Back is what it was", backAction({ ...state, captionEditing: false }), { type: "close", what: "textEditor" });
  eq("an older caller that does not know the flag is unaffected", backAction({ ...state, captionEditing: undefined, textEditorVisible: false, styleSheetOpen: false, captionsPanelOpen: false, markerSheetOpen: false, cutsSheetOpen: false, explainerVisible: false, hasSelection: false }), { type: "step", to: "cuts" });
}

// ── the bar component ──
{
  const bar = read("../components/CaptionEditBar.tsx");
  ok("the bar has a text field, focused at once, with a Done return key", /<TextInput[\s\S]{0,400}autoFocus/.test(bar) && /returnKeyType="done"/.test(bar));
  ok("the text field shows the caption's text (value = the draft) and reports every change", /value=\{text\}/.test(bar) && /onChangeText=\{onChangeText\}/.test(bar));
  ok("the keyboard's Done key, the Done button and a tap on the dimmed video all call onDone", /onSubmitEditing=\{onDone\}/.test(bar) && /<Pressable onPress=\{onDone\} style=\{styles\.done\}/.test(bar) && /<Pressable style=\{styles\.dim\} onPress=\{onDone\}/.test(bar));
  ok("it sits at the keyboard's height (captionBarBottom of keyboardHeight), full width", /bottom: captionBarBottom\(keyboardHeight, bottomInset\)/.test(bar) && /left: 0,\s*right: 0/.test(bar));
  ok("it does not flash at the bottom before the keyboard height is known", /keyboardHeight > 0 \|\| waited/.test(bar) && /opacity: ready \? 1 : 0/.test(bar));
  ok("it adds no dependency (no keyboard library)", !/react-native-keyboard-controller/.test(bar + read("../package.json")));
}

// ── the video no longer holds the text field ──
{
  const cap = read("../components/CaptionPreview.tsx");
  ok("CaptionPreview has no text field of its own any more", !/TextInput/.test(cap) && !/inputRef|setDraft/.test(cap));
  ok("a double tap and the toolbar's Edit both ask the editor to open the bar with the line's index and text", /cur\.onEditRequest\(cur\.index, cur\.line\.text\)/.test(cap) && /startEditing\(\)/.test(cap) && /startEditingRef\.current\(\)/.test(cap) && /editRequest/.test(cap));
  ok("the caption on the video shows the draft as it is typed", /editing && line \? editing\.text/.test(cap) && /drawn && \(/.test(cap));
  ok("no touch target or selection outline on the video while the bar is up", /showOutline = selected && editing === null/.test(cap) && /\{editing === null && \(\s*<GestureDetector/.test(cap));
}

// ── the editor ──
{
  const edit = read("../app/edit.tsx");
  ok("the bar is shown on the full-screen editor while a caption is being edited, with the keyboard height", /step === "edit" && captionDraft \? \(\s*<CaptionEditBar/.test(edit) && /keyboardHeight=\{keyboardH\}/.test(edit) && /bottomInset=\{insets\.bottom\}/.test(edit));
  ok("starting an edit (either entry point) pauses playback and opens the draft with the line's text", /onEditRequest=\{\(i, t\) => \{\s*setIsPlaying\(false\);\s*setCaptionDraft\(startCaptionDraft\(i, t\)\);/.test(edit) && /editing=\{captionDraft\}/.test(edit) && /editRequest=\{captionEditRequest\}/.test(edit));
  const done = edit.slice(edit.indexOf("const handleCaptionEditDone"), edit.indexOf("const handleCaptionEditCancel"));
  ok("Done saves through captions.editLine (the same path as before), closes the keyboard and removes the bar", /captions\.editLine\(save\.index, save\.text\)/.test(done) && /Keyboard\.dismiss\(\)/.test(done) && /setCaptionDraft\(null\)/.test(done));
  const cancel = edit.slice(edit.indexOf("const handleCaptionEditCancel"), edit.indexOf("const handleCaptionTool"));
  ok("Back discards: no editLine, keyboard closed, bar removed", !/editLine/.test(cancel) && /Keyboard\.dismiss\(\)/.test(cancel) && /setCaptionDraft\(null\)/.test(cancel));
  ok("Back (the button and Android's) closes the bar first and discards", /captionEditing: captionDraft !== null/.test(edit) && /case "captionEdit":\s*handleCaptionEditCancel\(\)/.test(edit));
  ok("the lift of the video for inline editing is gone; the Captions panel and the style sheet keep theirs", !/captionInlineEdit|inlineCaptionEdit/.test(edit) && /\(captionsPanelOpen \|\| styleSheetOpen\) && isVideo/.test(edit));
  ok("the Captions panel's own editing flow is untouched (its sheet still edits lines itself)", /onEditLine|editLine/.test(read("../components/CaptionsSheet.tsx")) && /<CaptionsSheet/.test(edit));
  ok("text overlays are untouched: TextOverlayEditor is still its own modal", /<TextOverlayEditor\s+visible=\{textEditorVisible\}/.test(edit));
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
