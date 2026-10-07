#!/usr/bin/env node
/**
 * The editor's panels: preview vs final render, the contextual caption toolbar, the Captions panel's
 * effects, and the one Cuts sheet.
 *
 *   node --experimental-strip-types scripts/test-editor-panels.mjs
 */
import { isFresh, planPostRender, postRenderSource, renderSignature } from "../lib/renderSignature.ts";
import { CAPTION_TOOLS, MIN_TOOL_TARGET_PT, toolWidth, toolbarMode } from "../lib/editorToolbar.ts";
import { allCategoriesOff, categoryRows, cutsRows, cutsSummary, setCutsRowEnabled } from "../lib/autoEdit/editPanel.ts";
import { keepRangesOf, makeDecision, newEditState, setCaptionEdits, setCaptionStyle, setCategoryEnabled, setDecisionState } from "../lib/autoEdit/decisions.ts";
import { applyLineEdit, buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { withCaptionLook } from "../lib/transcription/captionStyle.ts";
import { toRenderJson } from "../lib/editStyles.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const SIZE = { width: 720, height: 1280 };
const clips = [{ uri: "file:///a.mov", trimStartMs: 0, trimEndMs: 4000, durationMs: 9000 }, { uri: "file:///a.mov", trimStartMs: 5000, trimEndMs: 8000, durationMs: 9000 }];
const talk = [w("one", 100, 500), w("two", 550, 900), w("three", 950, 1300), w("four", 5200, 5600), w("five", 5650, 6000)];
const ranges = [{ startMs: 0, endMs: 4000 }, { startMs: 5000, endMs: 8000 }];
const lines = (edits = {}, style) => buildCaptionLines(talk, edits, ranges, style);
const overlays = (edits = {}, style) => captionLinesToEditOverlays(lines(edits, style), style);
const preview = (c, o) => renderSignature({ clips: c, captions: o, includeCaptions: false, size: SIZE });
const final = (c, o) => renderSignature({ clips: c, captions: o, includeCaptions: true, size: SIZE });

// ── the preview render never has captions; the final one does ──
{
  const base = overlays();
  const style = withCaptionLook(undefined, { fontId: "serif", textColor: "yellow", backgroundColor: "blue" });
  const variants = {
    "a caption text edit": overlays({ 0: "ONE!" }),
    "a deleted line": overlays({ 3: "", 4: "" }),
    "a style change": overlays({}, style),
    "a moved and resized box": overlays({}, { scale: 1.5, yCenter: 0.4, xCenter: 0.5 }),
    "captions off (no overlays)": [],
  };
  for (const [name, o] of Object.entries(variants)) {
    eq(`${name}: the PREVIEW signature does not change (no re-render)`, preview(clips, o), preview(clips, base));
    eq(`${name}: the FINAL signature does change (it is stale)`, final(clips, o) !== final(clips, base), true);
  }
  const trimmed = clips.map((c, i) => (i === 1 ? { ...c, trimEndMs: 7500 } : c));
  eq("a cut / trim changes both signatures", [preview(trimmed, base) !== preview(clips, base), final(trimmed, base) !== final(clips, base)], [true, true]);
  eq("the final signature contains the captions; the preview's does not", [final(clips, base).includes("one two three"), preview(clips, base).includes("one two three")], [true, false]);
  eq("the final render's instructions carry every caption overlay (burned in)", JSON.parse(toRenderJson({ version: 1, clips: [], overlays: base })).overlays.every((o) => o.kind === "caption" && o.styleSpec && o.text), true);
  eq("...and are the same overlays the signature is made from", final(clips, base).includes(JSON.stringify(base).slice(0, 40)), true);
  eq("the same clips and captions again: both signatures are stable", [preview(clips, overlays()) === preview(clips, base), final(clips, overlays()) === final(clips, base)], [true, true]);
}

// ── Post uses a fresh final render ──
{
  const sig = final(clips, overlays());
  eq("with captions Post uses the final render; without, the preview's", [postRenderSource(3), postRenderSource(0)], ["final", "preview"]);
  eq("a finished render for exactly this timeline is fresh", isFresh({ kind: "ready", signature: sig }, sig), true);
  eq("a finished render for an older edit is not", isFresh({ kind: "ready", signature: final(clips, overlays({ 0: "X" })) }, sig), false);
  eq("fresh -> use it; running for this edit -> wait (\"Finishing video…\"); anything else -> render now", [
    planPostRender({ state: { kind: "ready", signature: sig }, current: sig }),
    planPostRender({ state: { kind: "rendering", signature: sig }, current: sig }),
    planPostRender({ state: { kind: "rendering", signature: "old" }, current: sig }),
    planPostRender({ state: { kind: "ready", signature: "old" }, current: sig }),
    planPostRender({ state: { kind: "waiting" }, current: sig }),
    planPostRender({ state: { kind: "idle" }, current: null }),
  ], ["use-ready", "wait-for-running", "render-now", "render-now", "render-now", "render-now"]);
  eq("an edit after the final render finished makes Post render again", planPostRender({ state: { kind: "ready", signature: sig }, current: final(clips, overlays({ 3: "" })) }), "render-now");
}

// ── captions on/off never touch the cuts ──
{
  const D = 20000;
  const s = newEditState("u", [makeDecision("silenceCut", 4000, 5000), makeDecision("umCut", 8000, 8400), makeDecision("hookTrim", 0, 300)]);
  const before = JSON.stringify(keepRangesOf(s, D));
  const styled = setCaptionStyle(setCaptionEdits(s, { 0: "" }), { scale: 1.4, yCenter: 0.5, xCenter: 0.5 });
  eq("keep ranges are identical with caption edits, a style, or the caption category switched off", [
    JSON.stringify(keepRangesOf(styled, D)), JSON.stringify(keepRangesOf(setCategoryEnabled(styled, "caption", false), D)),
  ], [before, before]);
  eq("the preview signature is the same with captions on or off", preview(clips, overlays()) === preview(clips, []), true);
}

// ── the toolbar follows the selection ──
{
  eq("nothing selected: the main toolbar", toolbarMode({ captionSelected: false, captionsOn: true, hasLines: true }), "main");
  eq("a caption selected: the caption toolbar", toolbarMode({ captionSelected: true, captionsOn: true, hasLines: true }), "caption");
  eq("Done (deselect) goes back to the main toolbar", toolbarMode({ captionSelected: false, captionsOn: true, hasLines: true }), "main");
  eq("captions off, or no caption on screen: the main toolbar, whatever was selected", [
    toolbarMode({ captionSelected: true, captionsOn: false, hasLines: true }), toolbarMode({ captionSelected: true, captionsOn: true, hasLines: false }),
  ], ["main", "main"]);
  eq("the caption toolbar: Edit, Style, Delete line, Done", CAPTION_TOOLS.map((t) => t.label), ["Edit", "Style", "Delete line", "Done"]);
  eq("at 375 pt the six main tools are about 60 pt each and the four caption tools about 89 pt: all above the 44 pt target", [toolWidth(375, 6, 8) >= MIN_TOOL_TARGET_PT, toolWidth(375, 4, 8) >= MIN_TOOL_TARGET_PT, Math.round(toolWidth(375, 6, 8))], [true, true, 60]);
  eq("even on a 320 pt phone six tools stay above 44 pt", toolWidth(320, 6, 8) >= MIN_TOOL_TARGET_PT, true);
  // Delete line from the toolbar: the words of the line on screen are deleted (reversible, stored by source word)
  const first = lines();
  eq("Delete line deletes the caption on screen and only it", [applyLineEdit(talk, {}, first[1], ""), lines(applyLineEdit(talk, {}, first[1], "")).map((l) => l.text)], [{ 3: "", 4: "" }, ["one two three"]]);
}

// ── the one Cuts sheet ──
{
  const D = 60000;
  const decisions = [
    makeDecision("silenceCut", 2000, 4000), makeDecision("silenceCut", 9000, 9500), makeDecision("umCut", 12000, 12300), makeDecision("fillerCut", 15000, 15250),
    makeDecision("hookTrim", 0, 400), makeDecision("laughProtect", 20000, 22000), makeDecision("zoom", 30000, 31000),
  ];
  const s = newEditState("u", decisions);
  eq("the switches: Silences, Ums, Slow start/end, Protect laughs (Zooms are owner-only)", [cutsRows(s, { owner: false }).map((r) => r.label), cutsRows(s, { owner: true }).map((r) => r.label)], [
    ["Silences", "Ums", "Slow start/end", "Protect laughs"], ["Silences", "Ums", "Slow start/end", "Protect laughs", "Zooms"],
  ]);
  eq("each switch drives the same decision categories as before", cutsRows(s, { owner: true }).map((r) => [r.id, r.types]), [
    ["silences", ["silenceCut"]], ["ums", ["umCut", "fillerCut"]], ["hook", ["hookTrim"]], ["protect", ["laughProtect"]], ["zooms", ["zoom"]],
  ]);
  eq("the counts are the applied decisions of those categories", cutsRows(s, { owner: true }).map((r) => r.count), [2, 2, 1, 1, 1]);
  for (const row of cutsRows(s, { owner: true })) {
    const viaRow = setCutsRowEnabled(s, row, false);
    const viaCategories = row.types.reduce((acc, t) => setCategoryEnabled(acc, t, false), s);
    eq(`switching ${row.label} off equals switching its categories off one by one (same keep ranges and states)`, [JSON.stringify(viaRow.categoryEnabled), JSON.stringify(keepRangesOf(viaRow, D))], [JSON.stringify(viaCategories.categoryEnabled), JSON.stringify(keepRangesOf(viaCategories, D))]);
  }
  const noUms = setCutsRowEnabled(s, cutsRows(s, { owner: false })[1], false);
  eq("Ums off restores both the um and the filler footage; silences stay cut", [keepRangesOf(noUms, D).some((k) => k.startMs <= 12000 && k.endMs >= 12300), keepRangesOf(noUms, D).some((k) => k.startMs <= 2000 && k.endMs >= 4000)], [true, false]);
  eq("the row reads off only when all its categories are off", [cutsRows(setCategoryEnabled(s, "umCut", false), { owner: false })[1].enabled, cutsRows(noUms, { owner: false })[1].enabled], [false, false]);
  eq("switching it on again restores the cuts", cutsRows(setCutsRowEnabled(noUms, cutsRows(noUms, { owner: false })[1], true), { owner: false })[1].enabled, true);
  const sum = cutsSummary(s, D);
  eq("summary: the cuts that remove footage and the time they save", [sum.cuts, Math.round(sum.savedMs), sum.text], [5, 2000 + 500 + 300 + 250 + 400, "5 cuts · saved 3.5 s"]);
  eq("a reverted cut is not counted", cutsSummary(setDecisionState(s, "silenceCut:2000-4000", "reverted"), D).cuts, 4);
  eq("one cut reads \"1 cut\"", cutsSummary(newEditState("u", [makeDecision("silenceCut", 1000, 2000)]), 10000).text, "1 cut · saved 1.0 s");
  const orig = allCategoriesOff(s);
  eq("Restore all: nothing is cut (the original video), and every decision is kept for switching back on", [JSON.stringify(keepRangesOf(orig, D)), orig.decisions.length], [JSON.stringify([{ startMs: 0, endMs: D }]), 7]);
  eq("the old category rows are untouched (they still work for the owner)", categoryRows(s, { owner: true, captionLines: 2, captionsOn: true }).length, 7);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
