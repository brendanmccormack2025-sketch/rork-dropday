#!/usr/bin/env node
/**
 * Delete a part / undo a cut from the Cuts screen, the safe-zone guides, and the "no thanks" options
 * (Keep original, Captions off, text Cancel): each independent of the other edit types.
 *
 *   node --experimental-strip-types scripts/test-cuts-and-guides.mjs
 */
import { readFileSync } from "node:fs";
import { addManualCut, keepRangesOf, makeDecision, newEditState, renderClipsOf, restoreRange, setCaptionStyle } from "../lib/autoEdit/decisions.ts";
import { LAST_PART_MESSAGE, markerAction, planDeletePart, undoThisCut } from "../lib/autoEdit/deletePart.ts";
import { buildCutMarkers } from "../lib/autoEdit/markers.ts";
import { cutCategoriesOff, cutsRows } from "../lib/autoEdit/editPanel.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { CENTER_SNAP_PT, GUIDE_FADE_MS, GUIDE_TINT, guideTarget, guidesVisible, shouldBuzz, snapToCenter } from "../lib/guides.ts";
import { cancelTextEdit } from "../lib/textOverlayStyle.ts";
import { videoTapAction } from "../lib/editorFlow.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const edit = read("../app/edit.tsx");

const DURATION = 20000;
const base = () => newEditState("file:///a.mov", [
  makeDecision("silenceCut", 4000, 5000),
  makeDecision("fillerCut", 9000, 9600),
  makeDecision("umCut", 13000, 13400),
]);
const clipsOf = (st) => renderClipsOf(st, DURATION).map((c, i) => ({ id: `c${i}`, uri: c.uri, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs }));
const model = (st) => ({ state: st, durationMs: DURATION });

// ── delete this part ──
{
  const st = base();
  const clips = clipsOf(st);
  eq("the AI cuts leave four parts", clips.length, 4);
  const plan = planDeletePart({ clips, clipId: "c1", model: model(st), matches: true });
  eq("Delete this part with the automatic edit behind it is a user cut for that source range", [plan.kind, plan.range], ["user-cut", { startMs: 5000, endMs: 9000 }]);
  const d = plan.next.decisions.find((x) => x.sourceStartMs === 5000 && x.sourceEndMs === 9000);
  eq("it is a cut decision by the creator (origin user, applied)", [d.origin, d.state, d.type], ["user", "applied", "silenceCut"]);
  eq("the part is gone from the timeline", clipsOf(plan.next).length, 3);
  ok("and its footage is no longer kept", !keepRangesOf(plan.next, DURATION).some((r) => r.startMs < 9000 && r.endMs > 5000));

  // undo / redo through the decisions history
  let h = emptyHistory();
  h = pushEdit(h, st);
  const u = undoEdit(h, plan.next);
  eq("undo brings the part back", clipsOf(u.state).length, 4);
  const r = redoEdit(u.history, u.state);
  eq("redo deletes it again", clipsOf(r.state).length, 3);

  // restoring the range (the existing restoreRange) brings it back too
  eq("restoreRange reverts the deletion (reversible)", clipsOf(restoreRange(plan.next, 5000, 9000)).length, 4);

  const manual = planDeletePart({ clips, clipId: "c1", model: model(st), matches: false });
  eq("with manual edits the timeline does not match the decisions: the part is removed from the timeline instead", manual, { kind: "remove-clip", clipId: "c1" });
  eq("without an automatic edit the part is removed from the timeline", planDeletePart({ clips, clipId: "c2", model: null, matches: false }).kind, "remove-clip");
  eq("an unknown part is refused", planDeletePart({ clips, clipId: "zzz", model: model(st), matches: true }), { kind: "blocked", reason: "unknown-part" });
}

// ── never the last part ──
{
  const st = newEditState("file:///a.mov", []);
  const one = [{ id: "only", uri: "file:///a.mov", trimStartMs: 0, trimEndMs: DURATION }];
  eq("a single part cannot be deleted", planDeletePart({ clips: one, clipId: "only", model: model(st), matches: true }), { kind: "blocked", reason: "last-part" });
  eq("without an automatic edit either", planDeletePart({ clips: one, clipId: "only", model: null, matches: false }).reason, "last-part");
  // Deleting parts one by one stops at the last one
  let state = base();
  let steps = 0;
  for (;;) {
    const clips = clipsOf(state);
    const p = planDeletePart({ clips, clipId: clips[0].id, model: model(state), matches: true });
    if (p.kind !== "user-cut") { eq("the last remaining part is refused", [p.kind, clips.length], ["blocked", 1]); break; }
    state = p.next;
    if (++steps > 10) { eq("loop guard", true, false); break; }
  }
  ok("the video always keeps at least one part", keepRangesOf(state, DURATION).length >= 1);
  eq("the message says why", LAST_PART_MESSAGE, "A video needs at least one part.");
  ok("the screen shows that message", /showAlert\("Can't delete", LAST_PART_MESSAGE\)/.test(edit));
}

// ── undo this cut ──
{
  const st = base();
  const markers = buildCutMarkers(st, DURATION);
  const cut = markers.find((m) => m.kind === "cut");
  eq("a red cut marker offers one action", markerAction(cut), { label: "Undo this cut" });
  eq("other markers do not", [markerAction({ kind: "restored" }), markerAction({ kind: "laugh" }), markerAction(null)], [null, null, null]);
  const restored = undoThisCut(st, cut);
  ok("Undo this cut restores that range", keepRangesOf(restored, DURATION).some((r) => r.startMs <= cut.srcStartMs && r.endMs >= cut.srcEndMs));
  ok("and only that cut", renderClipsOf(restored, DURATION).length === renderClipsOf(st, DURATION).length - 1);
  let h = pushEdit(emptyHistory(), st);
  eq("it is one undo step", undoEdit(h, restored).state, st);
  ok("a selected part still shows Delete this part and a marker opens its sheet", /setMarkerSheet\(marker\);/.test(edit));
  ok("a selected part shows Delete this part", /selectedClipId && clips\.length > 0 && \(/.test(edit) && /accessibilityLabel="Delete this part"/.test(edit));
}

// ── Keep original ──
{
  let st = base();
  st = setCaptionStyle(st, { scale: 1.4, yCenter: 0.6, xCenter: 0.5 });
  st = { ...st, captionEdits: { 0: "hello" } };
  const mine = addManualCut(st, 15000, 16000);
  const off = cutCategoriesOff(mine);
  eq("Keep original turns off the four cut categories", ["silenceCut", "hookTrim", "fillerCut", "umCut"].map((t) => off.categoryEnabled[t]), [false, false, false, false]);
  eq("and only those: laugh protection, zooms, captions are as they were", ["laughProtect", "zoom", "caption", "audio"].map((t) => off.categoryEnabled[t]), ["laughProtect", "zoom", "caption", "audio"].map((t) => mine.categoryEnabled[t]));
  eq("the caption box and the caption edits are untouched", [off.captionStyle, off.captionEdits], [mine.captionStyle, mine.captionEdits]);
  eq("no decision changes", off.decisions, mine.decisions);
  eq("the AI's cuts are gone from the timeline", renderClipsOf(off, DURATION).length, 2);
  ok("a part the creator deleted by hand stays deleted", !keepRangesOf(off, DURATION).some((r) => r.startMs < 16000 && r.endMs > 15000));
  eq("the cuts list is all off", cutsRows(off, { owner: false }).filter((r) => r.types.some((t) => ["silenceCut", "umCut", "hookTrim"].includes(t))).every((r) => !r.enabled), true);
  // reversible
  const h = pushEdit(emptyHistory(), mine);
  eq("undo brings the AI cuts back", undoEdit(h, off).state.categoryEnabled.silenceCut, true);
  ok("it asks before replacing manual edits (userEdit / guardAction), and sits beside Done", /userEdit\(cutCategoriesOff\)/.test(edit) && /accessibilityLabel="Keep original"[\s\S]{0,400}accessibilityLabel="Done with cuts"/.test(edit));
  ok("it leaves text overlays and captions alone (it only calls the cut-categories edit)", !/handleKeepOriginal[\s\S]{0,200}(setTextOverlays|setCaptionsOn)/.test(edit));
}

// ── Captions off ──
{
  const sheet = read("../components/CaptionsSheet.tsx");
  ok("the Captions panel starts with a clean row: the name and the switch (no bordered card)", sheet.indexOf("styles.titleRow") < sheet.indexOf("styles.styleRow") && /Captions off/.test(sheet) && !/offCard/.test(sheet));
  ok("the switch only calls onToggle (captions on/off)", /onValueChange=\{onToggle\}/.test(sheet));
  const use = read("../lib/transcription/useCaptions.ts");
  const setOn = use.slice(use.indexOf("setCaptionsOn"), use.indexOf("setCaptionsOn") + 600);
  ok("switching captions off does not touch the cuts or the text", !/userEdit|categoryEnabled|setCutsRowEnabled|textOverlays/.test(setOn));
  ok("the panel opens from the Captions tool", /label="Captions" onPress=\{\(\) => setCaptionsPanelOpen\(true\)\}/.test(edit));
  ok("editing a caption line uses sentence case, not capitals", !/autoCapitalize="characters"/.test(sheet + read("../components/CaptionPreview.tsx")));
}

// ── text Cancel ──
{
  const list = [{ id: "a", text: "one" }, { id: "b", text: "two" }];
  const fresh = cancelTextEdit(list, null);
  eq("Cancel on a new text discards it and changes nothing", [fresh.overlays === list, fresh.snapshot], [true, false]);
  const existing = cancelTextEdit(list, "a");
  eq("Cancel on an existing text removes that overlay only", [existing.overlays.map((o) => o.id), existing.snapshot], [["b"], true]);
  eq("an unknown id changes nothing", cancelTextEdit(list, "zzz").overlays === list, true);
  // undo brings it back: the snapshot is taken before the removal
  const undoStack = [];
  let current = list;
  const r = cancelTextEdit(current, "a");
  if (r.snapshot) undoStack.push(current);
  current = r.overlays;
  eq("after Cancel the overlay is gone", current.length, 1);
  current = undoStack.pop();
  eq("undo brings it back", current.map((o) => o.id), ["a", "b"]);
  ok("the handler takes the snapshot before removing and uses the Cancel button", /result\.snapshot\) \{\s*pushSnapshot\(clips, textOverlays\);\s*setTextOverlays\(result\.overlays\)/.test(edit) && /onPress=\{onRemove \?\? onCancel\}/.test(read("../components/TextOverlayEditor.tsx")));
  ok("Cancel only touches text overlays (no cuts, no captions)", !/handleTextEditorRemove[\s\S]{0,700}(userEdit|setCaptionsOn|categoryEnabled)/.test(edit));
}

// ── guides ──
{
  eq("hidden at rest", guidesVisible({ dragging: false, pinching: false }), false);
  eq("shown while dragging, and while pinching", [guidesVisible({ dragging: true, pinching: false }), guidesVisible({ dragging: false, pinching: true })], [true, true]);
  eq("the guides fade in 200 ms toward 1 or 0", [GUIDE_FADE_MS, guideTarget(true), guideTarget(false)], [200, 1, 0]);
  eq("a soft translucent tint, not dashed", GUIDE_TINT, "rgba(0,0,0,0.15)");
  eq("within 6 pt of the centre it snaps and is centred", [snapToCenter(195 + 5, 390), snapToCenter(195 - 5.9, 390)], [{ x: 195, centered: true }, { x: 195, centered: true }]);
  eq("beyond 6 pt it does not", [snapToCenter(195 + 6.1, 390), snapToCenter(100, 390)], [{ x: 201.1, centered: false }, { x: 100, centered: false }]);
  eq("the snap distance is 6 pt", CENTER_SNAP_PT, 6);
  eq("a light haptic only when arriving at the centre", [shouldBuzz(false, true), shouldBuzz(true, true), shouldBuzz(true, false), shouldBuzz(false, false)], [true, false, false, false]);
  const zones = read("../components/FeedSafeZones.tsx");
  ok("the zones are a rounded tint with no dashed borders", /backgroundColor: GUIDE_TINT/.test(zones) && /borderRadius: GUIDE_RADIUS/.test(zones) && !/dashed/.test(zones));
  ok("they fade with a 200 ms animation and take no touches", /duration: GUIDE_FADE_MS/.test(zones) && /pointerEvents="none"/.test(zones));
  ok("a thin vertical centre line when centred", /centered && <View style=\{\[styles\.centerLine/.test(zones));
  ok("the toggle button and its state are gone", !/showGuides|Feed guides|Grid3x3 size/.test(edit));
  ok("visible only while an overlay or caption is being moved", /visible=\{guidesVisible\(\{ dragging: guideGesture\.active, pinching: false \}\)\}/.test(edit));
  const drag = read("../components/DraggableTextOverlay.tsx");
  const cap = read("../components/CaptionPreview.tsx");
  ok("a text overlay reports every gesture (drag, pinch, rotate) and when it is centred", /onEditStart: \(\) => \{[\s\S]{0,200}onGestureState\?\.\(true, false\)/.test(drag) && /onEnd: \(\) => propsRef\.current\.onGestureState\?\.\(false, false\)/.test(drag) && /onGestureState\?\.\(true, snapped\.centered\)/.test(drag));
  ok("so does a caption", /onGestureState\?\.\(true, next\.snappedX\)/.test(cap) && /onGestureState\?\.\(false, false\)/.test(cap));
  ok("both snap to the centre with a light haptic", /shouldBuzz\(wasCentered, snapped\.centered\)\) buzz\(\)/.test(drag) && /shouldBuzz\(g\.current\.wasCentered, next\.snappedX\)\) buzz\(\)/.test(cap) && /expo-haptics/.test(drag + cap));
  ok("the old separate center lines are gone", !/snapGuide/.test(drag) && !/styles\.guide\b/.test(cap));
}

// ── tap a red diamond: the sheet, and Undo this cut restores only that range ──
{
  const st = base();
  const markers = buildCutMarkers(st, DURATION).filter((m) => m.kind === "cut");
  eq("three cuts make three red diamonds", markers.length, 3);
  const labels = markers.map((m) => m.items.map((i) => i.label));
  eq("each lists what was cut there (Silence 1.0s, Filler 'text', Um)", labels.map((l) => l[0].split(" ")[0]), ["Silence", "Filler", "Um"]);
  const middle = markers[1];
  const restored = undoThisCut(st, middle);
  const applied = (state) => state.decisions.filter((d) => d.state === "applied").map((d) => d.type);
  eq("Undo this cut restores just that range: the other two stay cut", applied(restored), ["silenceCut", "umCut"]);
  eq("the footage of that cut is back, the others are still gone", [
    keepRangesOf(restored, DURATION).some((r) => r.startMs <= 9000 && r.endMs >= 9600),
    keepRangesOf(restored, DURATION).some((r) => r.startMs < 5000 && r.endMs > 4000),
    keepRangesOf(restored, DURATION).some((r) => r.startMs < 13400 && r.endMs > 13000),
  ], [true, false, false]);
  const h = pushEdit(emptyHistory(), st);
  const u = undoEdit(h, restored);
  eq("undo cuts it again, redo restores it again", [applied(u.state).length, applied(redoEdit(u.history, u.state).state).length], [3, 2]);

  const sheet = read("../components/MarkerSheet.tsx");
  ok("the sheet lists the marker's items and has a big Undo this cut button for a cut", /marker\?\.items\.map/.test(sheet) && /marker\?\.kind === "cut"[\s\S]{0,200}styles\.undoBtn/.test(sheet) && /minHeight: 48/.test(sheet) && /Cut here/.test(sheet));
  ok("the button calls onRestore, which is Undo this cut (restoreRange) as one undo step", /onRestore=\{\(m\) => \{\s*userEdit\(\(s\) => undoThisCut\(s, m\)\)/.test(edit));
  ok("tapping any diamond opens the sheet", /const handleMarkerPress[\s\S]{0,500}setMarkerSheet\(marker\)/.test(edit) && /onMarkerPress=\{handleMarkerPress\}/.test(edit));
  const tl = read("../components/TimelineEditor.tsx");
  ok("the diamond's touch target is 44 x 44", /export const MARKER_TOUCH = 44/.test(tl) && /width: MARKER_TOUCH,\s*height: MARKER_TOUCH/.test(tl));
  const scrollEnd = tl.indexOf("</ScrollView>");
  const markersAt = tl.indexOf("AI edit markers (outside the scrolling content");
  const playheadAt = tl.indexOf("Playhead dot overlay (outside ScrollView)");
  ok("the markers are outside the scrolling content, after the playhead overlay (on top of it)", markersAt > scrollEnd && markersAt > playheadAt);
  const z = (name) => Number(new RegExp(name + ": \\{[^}]*zIndex: (\\d+)").exec(tl)?.[1]);
  ok("and above the scrubber's drag zone (zIndex 25) and the clip bars", z("markerHit") > z("playheadOverlay") && z("markerHit") > 25);
  ok("the clip tap still selects the clip", /onSelectClip\(layout\.clip\.id\)/.test(tl) && /const handleSelectClip[\s\S]{0,400}setSelectedClipId\(nextId\)/.test(edit));
  ok("and the empty-timeline tap still seeks (the content touch handler is unchanged)", /onTouchEnd=\{handleContentTouchEnd\}/.test(tl));
}

// ── tap the video: play / pause on the Cuts screen too ──
{
  eq("Cuts screen: a tap toggles", videoTapAction({ step: "cuts", hasSelection: false }), "toggle");
  eq("editor: a tap toggles when nothing is selected", videoTapAction({ step: "edit", hasSelection: false }), "toggle");
  eq("editor: a tap drops a selection first", videoTapAction({ step: "edit", hasSelection: true }), "drop-selection");
  ok("one tap layer serves both screens (any video), with the play icon feedback", /\{isVideo && \(\s*<Pressable\s+style=\{StyleSheet\.absoluteFill\}\s+accessibilityLabel=\{isPlaying \? "Pause" : "Play"\}/.test(edit) && /<PlayIndicator visible=\{vis\.playButton\} \/>/.test(edit));
  ok("no second, Cuts-only play button any more", !/step === "cuts" && !isPlaying && !pendingPlay/.test(edit));
  ok("it sits below the overlays, which take no touches on the Cuts screen", edit.indexOf('accessibilityLabel={isPlaying ? "Pause" : "Play"}') < edit.indexOf("flow.touchOverlays"));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
