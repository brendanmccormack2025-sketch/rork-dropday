#!/usr/bin/env node
/**
 * Caption look (font, text color, background): presets, readability, shadow, render JSON, edit state, old builds.
 *
 *   node --experimental-strip-types scripts/test-caption-look.mjs
 */
import {
  CAPTION_BACKGROUNDS, CAPTION_FONTS, CAPTION_TEXT_COLORS, DEFAULT_CAPTION_LOOK, MIN_CONTRAST, contrastRatio, resolveCaptionLook,
} from "../lib/transcription/captionPresets.ts";
import { defaultCaptionStyle, resetCaptionLook, styledSpec, usableCaptionStyle, withCaptionLook } from "../lib/transcription/captionStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { resolveOverlayStyle, toRenderJson } from "../lib/editStyles.ts";
import { makeDecision, newEditState, sameCaptionStyle, setCaptionStyle, setCategoryEnabled, keepRangesOf, clearCaptionStyle } from "../lib/autoEdit/decisions.ts";
import { emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const KEEP = [{ startMs: 0, endMs: 3000 }];
const spec = (style) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([w("hi", 100, 400)], {}, KEEP, style), style) })).overlays[0].styleSpec;

// ── the presets ──
eq("fonts: id -> iOS PostScript name (system heavy for trial)", CAPTION_FONTS.map((f) => [f.id, f.fontName]), [
  ["classic", "Montserrat-ExtraBold"], ["trial", null], ["avenir", "AvenirNext-Heavy"], ["futura", "Futura-Bold"], ["condensed", "HelveticaNeue-CondensedBlack"], ["serif", "Georgia-Bold"], ["typewriter", "AmericanTypewriter-Bold"],
]);
eq("backgrounds: Black (default), White, None, Trial red, Yellow, Blue", CAPTION_BACKGROUNDS.map((b) => [b.id, b.color]), [
  ["black", "#000000"], ["white", "#FFFFFF"], ["none", null], ["red", "#E8291C"], ["yellow", "#FFD400"], ["blue", "#1E5BFF"],
]);
eq("text colors: White (default), Black, Yellow, Trial red, Blue", CAPTION_TEXT_COLORS.map((b) => [b.id, b.color]), [
  ["white", "#FFFFFF"], ["black", "#000000"], ["yellow", "#FFD400"], ["red", "#E8291C"], ["blue", "#1E5BFF"],
]);
eq("the defaults are the Trial look", DEFAULT_CAPTION_LOOK, { fontId: "trial", textColor: "white", backgroundColor: "black" });

// ── the default style changes nothing ──
{
  const preset = resolveOverlayStyle("caption", "trial");
  const today = JSON.stringify({ ...preset, fadeInMs: 1, fadeOutMs: 1 });
  eq("no style: the render spec is the preset's own JSON, byte for byte", JSON.stringify(spec(undefined)), today);
  eq("the default box with no look: byte-identical", JSON.stringify(spec(defaultCaptionStyle())), today);
  eq("the default box with the Trial look spelled out: byte-identical", JSON.stringify(spec({ ...defaultCaptionStyle(), ...DEFAULT_CAPTION_LOOK })), today);
  eq("...and it has no fontName and no shadow keys", ["fontName" in spec(defaultCaptionStyle()), "shadow" in spec(defaultCaptionStyle())], [false, false]);
  eq("unknown ids fall back to the Trial look", JSON.stringify(spec({ ...defaultCaptionStyle(), fontId: "nope", textColor: "nope", backgroundColor: "nope" })), today);
}

// ── each preset maps to the render JSON ──
{
  const base = defaultCaptionStyle();
  for (const f of CAPTION_FONTS) {
    const s = spec({ ...base, fontId: f.id });
    eq(`font ${f.id}: fontName ${f.fontName ?? "(none: system heavy)"}`, [s.fontName ?? null, s.fontWeight], [f.fontName, "heavy"]);
  }
  for (const c of CAPTION_BACKGROUNDS) {
    const s = spec({ ...base, backgroundColor: c.id, textColor: c.id === "white" ? "black" : "white" });
    eq(`background ${c.id}: ${c.color ?? "no backgroundColor key"}`, [s.backgroundColor ?? null, "backgroundColor" in s], [c.color, c.color !== null]);
  }
  for (const c of CAPTION_TEXT_COLORS) {
    // on a background where every text color reads, so nothing is adjusted
    const bg = c.id === "black" ? "white" : "black";
    const hex = c.color;
    const looksReadable = contrastRatio(hex, bg === "white" ? "#FFFFFF" : "#000000") >= MIN_CONTRAST;
    const s = spec({ ...base, textColor: c.id, backgroundColor: bg });
    eq(`text ${c.id} on ${bg}: ${looksReadable ? hex : "adjusted"}`, s.color, looksReadable ? hex : (bg === "black" ? "#FFFFFF" : "#000000"));
  }
  eq("the look keeps the box: size and position are untouched by a look change", [spec({ ...base, scale: 1.5, yCenter: 0.4, fontId: "futura" }).fontSize, spec({ ...base, scale: 1.5, yCenter: 0.4, fontId: "futura" }).yCenter], [57, 0.4]);
}

// ── readability ──
{
  const look = (textColor, backgroundColor) => resolveCaptionLook({ textColor, backgroundColor });
  eq("white on black is fine (21:1)", [Math.round(contrastRatio("#FFFFFF", "#000000")), look("white", "black").adjusted, look("white", "black").textHex], [21, false, "#FFFFFF"]);
  eq("white on white switches the text to black", [look("white", "white").adjusted, look("white", "white").textHex], [true, "#000000"]);
  eq("yellow on white switches to black", [look("yellow", "white").adjusted, look("yellow", "white").textHex], [true, "#000000"]);
  eq("black on black switches to white", [look("black", "black").adjusted, look("black", "black").textHex], [true, "#FFFFFF"]);
  eq("blue on blue switches to white (the higher contrast)", [look("blue", "blue").adjusted, look("blue", "blue").textHex], [true, "#FFFFFF"]);
  eq("yellow on yellow switches to black", [look("yellow", "yellow").adjusted, look("yellow", "yellow").textHex], [true, "#000000"]);
  eq("black on yellow reads (no change)", [look("black", "yellow").adjusted, look("black", "yellow").textHex], [false, "#000000"]);
  eq("every combination ends with at least 3:1 (or no background to read against)", CAPTION_TEXT_COLORS.every((t) => CAPTION_BACKGROUNDS.every((b) => {
    const r = look(t.id, b.id);
    return b.color === null || contrastRatio(r.textHex, b.color) >= MIN_CONTRAST;
  })), true);
  eq("the adjusted color is what the render gets, the chosen one stays in the style", [spec({ ...defaultCaptionStyle(), textColor: "white", backgroundColor: "white" }).color, withCaptionLook(undefined, { textColor: "white", backgroundColor: "white" }).textColor], ["#000000", "white"]);
  eq("changing the background re-evaluates (white text comes back on black)", spec({ ...defaultCaptionStyle(), textColor: "white", backgroundColor: "black" }).color, "#FFFFFF");
  eq("the note is shown only when something was adjusted", [look("white", "white").adjusted, look("white", "none").adjusted], [true, false]);
}

// ── None: no background, soft shadow ──
{
  const s = spec({ ...defaultCaptionStyle(), backgroundColor: "none" });
  eq("None: no backgroundColor in the JSON and the native shadow option on", ["backgroundColor" in s, s.shadow], [false, true]);
  eq("None keeps the chosen text color (nothing to contrast against)", spec({ ...defaultCaptionStyle(), backgroundColor: "none", textColor: "yellow" }).color, "#FFD400");
  eq("a background brings the shadow back off", "shadow" in spec({ ...defaultCaptionStyle(), backgroundColor: "yellow", textColor: "black" }), false);
  const same = [{ backgroundColor: "none" }, { backgroundColor: "white", textColor: "white" }, { fontId: "condensed", textColor: "red", backgroundColor: "blue" }, {}].every((patch) => {
    const st = { ...defaultCaptionStyle(), ...patch };
    const preview = styledSpec(st);
    const render = spec(st);
    return ["color", "backgroundColor", "shadow", "fontName", "fontSize", "yCenter"].every((k) => preview[k] === render[k]);
  });
  eq("the live preview spec matches the render spec (colors, background, shadow, font, size, position)", same, true);
  eq("preview spec: no background, shadow, same color", [styledSpec({ ...defaultCaptionStyle(), backgroundColor: "none" }).backgroundColor, styledSpec({ ...defaultCaptionStyle(), backgroundColor: "none" }).shadow], [undefined, true]);
}

// ── edit state: persists, undo/redo, reset, keep ranges untouched ──
{
  const D = 20000;
  const decisions = [makeDecision("silenceCut", 2000, 3000), makeDecision("umCut", 8000, 8400), makeDecision("hookTrim", 0, 300)];
  const s0 = newEditState("u", decisions);
  const base = keepRangesOf(s0, D);
  const look = withCaptionLook(undefined, { fontId: "serif", textColor: "yellow", backgroundColor: "blue" });
  const s1 = setCaptionStyle(s0, look);
  eq("the look is stored in the edit state", s1.captionStyle, { scale: 1, yCenter: 0.72, xCenter: 0.5, fontId: "serif", textColor: "yellow", backgroundColor: "blue" });
  eq("changing the style never changes the keep ranges", JSON.stringify(keepRangesOf(s1, D)), JSON.stringify(base));
  eq("...nor does turning captions off (their category) or on", [JSON.stringify(keepRangesOf(setCategoryEnabled(s1, "caption", false), D)), JSON.stringify(keepRangesOf(setCategoryEnabled(setCategoryEnabled(s1, "caption", false), "caption", true), D))], [JSON.stringify(base), JSON.stringify(base)]);
  eq("the same look is not a new undo step; a changed field is", [setCaptionStyle(s1, { ...look }) === s1, setCaptionStyle(s1, { ...look, fontId: "avenir" }) === s1, sameCaptionStyle(look, { ...look, textColor: "red" })], [true, false, false]);
  eq("the decisions are untouched by a style change", JSON.stringify(s1.decisions), JSON.stringify(s0.decisions));

  let h = pushEdit(emptyHistory(), s0);
  const s2 = setCaptionStyle(s1, withCaptionLook(s1.captionStyle, { backgroundColor: "none" }));
  h = pushEdit(h, s1);
  const u1 = undoEdit(h, s2);
  eq("undo brings back the previous look", u1.state.captionStyle.backgroundColor, "blue");
  const u2 = undoEdit(u1.history, u1.state);
  eq("undo again: the Trial look (no stored style)", u2.state.captionStyle, undefined);
  const r1 = redoEdit(u2.history, u2.state);
  const r2 = redoEdit(r1.history, r1.state);
  eq("redo walks forward again", [r1.state.captionStyle.fontId, r2.state.captionStyle.backgroundColor], ["serif", "none"]);

  const moved = { scale: 1.4, yCenter: 0.5, xCenter: 0.5, fontId: "futura", textColor: "red", backgroundColor: "yellow" };
  eq("Reset to Trial style: font and colors default, size and position stay", resetCaptionLook(moved), { scale: 1.4, yCenter: 0.5, xCenter: 0.5 });
  eq("...and then draws the Trial look", JSON.stringify(spec(resetCaptionLook(moved))).includes("fontName"), false);
  eq("Reset on the default style is still the default", resetCaptionLook(undefined), defaultCaptionStyle());
  eq("clearing the whole style (Reset position) also drops the look", clearCaptionStyle(s1).captionStyle, undefined);
  eq("the style survives a draft save", JSON.parse(JSON.stringify(s1)).captionStyle.fontId, "serif");
}

// ── style across caption lines and cut changes ──
{
  const style = withCaptionLook(undefined, { fontId: "futura", textColor: "black", backgroundColor: "yellow" });
  const talk = [w("one", 0, 400), w("two", 450, 800), w("three", 850, 1200), w("four", 2500, 2900), w("five", 2950, 3300), w("six", 3350, 3700)];
  const a = captionLinesToEditOverlays(buildCaptionLines(talk, {}, [{ startMs: 0, endMs: 4000 }], style), style);
  const b = captionLinesToEditOverlays(buildCaptionLines(talk, {}, [{ startMs: 0, endMs: 1500 }, { startMs: 2400, endMs: 4000 }], style), style);
  eq("every line carries the look, whatever the cuts", [a.length > 1, b.length > 1, [...a, ...b].every((o) => o.captionStyle.fontId === "futura" && o.captionStyle.backgroundColor === "yellow")], [true, true, true]);
  const json = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: a }));
  eq("every overlay in the render JSON has the same look", json.overlays.every((o) => o.styleSpec.fontName === "Futura-Bold" && o.styleSpec.backgroundColor === "#FFD400" && o.styleSpec.color === "#000000"), true);
  // a condensed font fits more words per line than a wide one
  const long = [w("think", 0, 300), w("about", 350, 650), w("this", 700, 1000)];
  const lines = (fontId) => buildCaptionLines(long, {}, KEEP, { ...defaultCaptionStyle(), scale: 2.4, fontId }).length;
  eq("line breaks follow the font's width (condensed fits more than typewriter)", lines("condensed") < lines("typewriter"), true);
}

// ── old builds: no font ──
{
  const style = { ...defaultCaptionStyle(), fontId: "avenir", textColor: "yellow", backgroundColor: "none" };
  const old = usableCaptionStyle(style, false);
  eq("without supportsCaptionFont the font is dropped, the colors stay", [old.fontId, old.textColor, old.backgroundColor], [undefined, "yellow", "none"]);
  eq("...so the preview and the render JSON have no fontName", [spec(old).fontName, styledSpec(old).fontName], [undefined, undefined]);
  eq("...while the stored style keeps the font (a newer build will use it)", style.fontId, "avenir");
  const modern = usableCaptionStyle(style, true);
  eq("with supportsCaptionFont the font is used", [modern.fontId, spec(modern).fontName], ["avenir", "AvenirNext-Heavy"]);
  eq("no stored style stays none; a style without a font is returned as is", [usableCaptionStyle(undefined, false), usableCaptionStyle(defaultCaptionStyle(), false) === undefined], [undefined, false]);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
