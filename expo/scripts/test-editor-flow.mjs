#!/usr/bin/env node
/**
 * The editor's three steps (Cuts -> full-screen editor -> Post): navigation, state kept going back and forth,
 * and the Post screen still posting through safePost with the camera-roll switch.
 *
 *   node --experimental-strip-types scripts/test-editor-flow.mjs
 */
import { readFileSync } from "node:fs";
import { backStep, cutsStep, initialStep, nextStep, selectionBarSide, stepLayout } from "../lib/editorFlow.ts";
import { CAPTION_TOOLS } from "../lib/editorToolbar.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const edit = read("../app/edit.tsx");

// ── navigation ──
{
  eq("a new video starts on the Cuts screen", initialStep({ isDraft: false, isVideo: true }), "cuts");
  eq("a draft reopens in the full-screen editor", initialStep({ isDraft: true, isVideo: true }), "edit");
  eq("a photo has nothing to cut: it starts in the editor", initialStep({ isDraft: false, isVideo: false }), "edit");
  eq("Done on the Cuts screen continues to the editor", nextStep("cuts"), "edit");
  eq("Next in the editor goes to the Post screen", nextStep("edit"), "post");
  eq("Back from the Post screen returns to the full-screen editor", backStep("post", { isVideo: true }), "edit");
  eq("Back from the editor goes to the Cuts screen (a video)", backStep("edit", { isVideo: true }), "cuts");
  eq("Back from the editor leaves for a photo", backStep("edit", { isVideo: false }), "exit");
  eq("Back from the Cuts screen leaves the editor", backStep("cuts", { isVideo: true }), "exit");
  eq("the editor's Cuts tool returns to the Cuts screen (videos only)", [cutsStep({ isVideo: true }), cutsStep({ isVideo: false })], ["cuts", null]);
  // A whole trip
  let step = initialStep({ isDraft: false, isVideo: true });
  const trip = [step];
  step = nextStep(step); trip.push(step);
  step = nextStep(step); trip.push(step);
  step = backStep(step, { isVideo: true }); trip.push(step);
  step = "cuts"; trip.push(step);
  step = nextStep(step); trip.push(step);
  eq("a trip: cuts, edit, post, back to edit, Cuts tool, Done, edit", trip, ["cuts", "edit", "post", "edit", "cuts", "edit"]);
}

// ── what shows where ──
{
  const c = stepLayout("cuts"), e = stepLayout("edit"), p = stepLayout("post");
  ok("Cuts: the timeline and the Cuts panel, nothing editable on the video", c.timeline && c.cutsPanel && !c.touchOverlays && !c.editTools && !c.postForm);
  ok("Editor: the video fills the screen, with the tools; no timeline, no post form", e.fullScreenVideo && e.editTools && e.touchOverlays && e.guides && !e.timeline && !e.postForm);
  ok("Post: only the form", p.postForm && !p.timeline && !p.fullScreenVideo && !p.editTools);
  eq("the selected-item bar goes to the top for items in the lower half, so it never covers them", [selectionBarSide(0.22), selectionBarSide(0.72), selectionBarSide(0.55), selectionBarSide(0.56)], ["bottom", "top", "bottom", "top"]);
}

// ── state is kept ──
{
  ok("one component, one step state: moving between steps only sets the step", /const \[step, setStep\] = useState<EditorStep>/.test(edit));
  const stepFns = edit.slice(edit.indexOf("const handleBackPress"), edit.indexOf("const selectedOverlay ="));
  ok("going back or forward never touches clips, overlays, captions or history", !/setClips|setTextOverlays|setEditModel|historyRef|pushSnapshot|userEdit|captions\.\w+\(/.test(stepFns));
  ok("the video players are hooks of the component, so they survive the steps", /useVideoPlayer\(/.test(edit) && !/step === "[a-z]+" && useVideoPlayer/.test(edit));
  ok("Android's back button walks the steps", /BackHandler\.addEventListener\("hardwareBackPress"/.test(edit) && /backStep\(stepRef\.current/.test(edit));
  ok("the separate Preview button and modal are gone", !/EditPreviewModal|handleOpenFullPreview|accessibilityLabel="Preview"/.test(edit));
}

// ── the full-screen editor ──
{
  ok("the video fills the screen with the feed's crop: the frame is the whole area in this step", /step === "edit" \? previewAreaSize :/.test(edit) && /previewAreaFull/.test(edit));
  ok("tap on empty video plays or pauses (a selection is dropped first)", /accessibilityLabel=\{isPlaying \? "Pause" : "Play"\}/.test(edit) && /togglePlay\(\);/.test(edit));
  ok("text overlays and captions are edited on the video (touch layer on only in the editor)", /pointerEvents=\{flow\.touchOverlays \? "box-none" : "none"\}/.test(edit));
  ok("top: back, undo, redo, guides toggle", /label="Back"[\s\S]{0,300}label="Undo"[\s\S]{0,300}label="Redo"[\s\S]{0,300}label="Feed guides"/.test(edit));
  ok("right column: Text, Captions, Style, Cuts", /label="Text"[\s\S]{0,700}label="Captions"[\s\S]{0,400}label="Style"[\s\S]{0,400}label="Cuts"/.test(edit));
  ok("Next, bottom-right", /styles\.eNext/.test(edit) && /right: 16,\s*minHeight: 48/.test(edit));
  eq("the caption bar: Edit, Style, Delete line, Done", CAPTION_TOOLS.map((t) => t.label), ["Edit", "Style", "Delete line", "Done"]);
  ok("the text overlay bar: Edit, Style, Delete, Done", /label="Edit text"|accessibilityLabel="Edit text"/.test(edit) && /accessibilityLabel="Change text style"/.test(edit) && /accessibilityLabel="Delete text"/.test(edit));
  ok("the bar sits on the side away from the item", /barSide === "top" \?/.test(edit));
  ok("the Text tool adds a new text (it drops any selection first)", /label="Text" onPress=\{\(\) => \{ setSelectedOverlayId\(null\)/.test(edit));
}

// ── the Post screen ──
{
  const post = edit.slice(edit.indexOf('{step === "post" && (\n          <ScrollView'), edit.indexOf("Full-screen editor: tools"));
  ok("thumbnail, the Trial line, mature content, camera roll switch, Save Draft and Post are on the Post screen", /thumbWrap/.test(post) && /On Trial, people who don't know you/.test(post) && /Mark as mature content/.test(post) && /Save to camera roll/.test(post) && /Save Draft/.test(post) && /handlePostPress/.test(post));
  ok("the camera-roll switch is still remembered per user", /setSaveEditedToRoll\(v, user\?\.id\)/.test(post));
  ok("the retry-after-failed-post row is here too", /POST_FAILED_TEXT/.test(post));
  ok("Post still goes through safePost", /void safePost\(/.test(edit) && /POST_FAILED_TEXT/.test(edit));
  ok("and the posted video is still saved to the camera roll after the upload starts", /startPostExport\(\{/.test(edit) && /saveToRollRef\.current/.test(edit));
  ok("none of the post form is on the Cuts or editor screens", !/Mark as mature content/.test(edit.slice(0, edit.indexOf('{step === "post" && (\n          <ScrollView'))));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
