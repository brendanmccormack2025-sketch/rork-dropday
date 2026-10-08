#!/usr/bin/env node
/**
 * Montserrat as the default caption and text overlay font, only where the build can render it
 * (native supportsCaptionFont). The old build's preview and render are unchanged.
 *
 *   node --experimental-strip-types scripts/test-montserrat.mjs
 */
import { readFileSync } from "node:fs";
import { CAPTION_FONTS, TEXT_FONT_FAMILY, TEXT_FONT_NAME, previewFontFamily } from "../lib/transcription/captionPresets.ts";
import { defaultCaptionStyle, resetCaptionLook, styledSpec, usableCaptionStyle, withCaptionLook } from "../lib/transcription/captionStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { resolveOverlayStyle, toRenderJson } from "../lib/editStyles.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const lines = (style) => buildCaptionLines([w("hi", 100, 400), w("there", 450, 900)], {}, [{ startMs: 0, endMs: 1000 }], style);
const captionSpec = (style) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(lines(style), style) })).overlays[0].styleSpec;
const textSpec = (supportsFont) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: [{ kind: "text", text: "y", startMs: 0, endMs: 500 }] }, { supportsFont })).overlays[0].styleSpec;

// ── the fonts ──
{
  eq("Classic is the first font, Montserrat ExtraBold", [CAPTION_FONTS[0].id, CAPTION_FONTS[0].fontName], ["classic", "Montserrat-ExtraBold"]);
  eq("the other presets are kept", CAPTION_FONTS.slice(1).map((f) => f.id), ["trial", "avenir", "futura", "condensed", "serif", "typewriter"]);
  eq("JS family names for the editor preview", [previewFontFamily("Montserrat-ExtraBold"), previewFontFamily(TEXT_FONT_NAME), previewFontFamily("Futura-Bold")], ["Montserrat_800ExtraBold", "Montserrat_700Bold", "Futura-Bold"]);
  eq("text overlay font", [TEXT_FONT_NAME, TEXT_FONT_FAMILY], ["Montserrat-Bold", "Montserrat_700Bold"]);
  const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
  const plugin = app.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font");
  eq("app.json embeds both Montserrat files via expo-font", plugin?.[1].fonts.map((f) => f.split("/").pop()), ["Montserrat_800ExtraBold.ttf", "Montserrat_700Bold.ttf"]);
  eq("app.json version is 1.0.4 (bumped by the owner)", app.version, "1.0.4");
  const ttf = (f) => readFileSync(new URL(`../node_modules/@expo-google-fonts/montserrat/${f}/Montserrat_${f}.ttf`, import.meta.url));
  const psNames = (buf) => {
    // name table, nameID 6 (PostScript name), platform 3 (UTF-16BE) or 1 (Mac Roman)
    const n = buf.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const tag = buf.toString("latin1", 12 + i * 16, 16 + i * 16);
      if (tag !== "name") continue;
      const off = buf.readUInt32BE(20 + i * 16);
      const count = buf.readUInt16BE(off + 2), strOff = buf.readUInt16BE(off + 4);
      for (let r = 0; r < count; r++) {
        const rec = off + 6 + r * 12;
        if (buf.readUInt16BE(rec + 6) !== 6) continue;
        const len = buf.readUInt16BE(rec + 8), so = off + strOff + buf.readUInt16BE(rec + 10);
        return buf.readUInt16BE(rec) === 3 ? Buffer.from(buf.subarray(so, so + len)).swap16().toString("utf16le") : buf.toString("latin1", so, so + len);
      }
    }
    return null;
  };
  eq("PostScript names read from the font files", [psNames(ttf("800ExtraBold")), psNames(ttf("700Bold"))], ["Montserrat-ExtraBold", "Montserrat-Bold"]);
}

// ── default caption: Montserrat only with the capability ──
{
  const none = usableCaptionStyle(undefined, true);
  eq("capable build, nothing chosen: the default box with Classic", none, { ...defaultCaptionStyle(), fontId: "classic" });
  eq("capable build: the render JSON carries fontName Montserrat-ExtraBold", captionSpec(none).fontName, "Montserrat-ExtraBold");
  eq("capable build: the preview spec has the same fontName", styledSpec(none).fontName, "Montserrat-ExtraBold");
  eq("capable build: white on black, rounded", [captionSpec(none).color, captionSpec(none).backgroundColor, captionSpec(none).cornerRadius], ["#FFFFFF", "#000000", 11]);
  eq("capable build: a chosen font is kept", usableCaptionStyle(withCaptionLook(undefined, { fontId: "futura" }), true).fontId, "futura");
  eq("capable build: a chosen system font (Trial) is kept", captionSpec(usableCaptionStyle(withCaptionLook(undefined, { fontId: "trial" }), true)).fontName, undefined);
  eq("capable build: a stored style without a font gets Classic, size and place kept",
    usableCaptionStyle({ scale: 1.3, yCenter: 0.6, xCenter: 0.5 }, true), { scale: 1.3, yCenter: 0.6, xCenter: 0.5, fontId: "classic" });
}

// ── the old build (build 39) ──
{
  eq("old build, nothing chosen: no style, as before", usableCaptionStyle(undefined, false), undefined);
  eq("old build: the render JSON has no fontName", captionSpec(usableCaptionStyle(undefined, false)).fontName, undefined);
  const stored = { scale: 1, yCenter: 0.7, xCenter: 0.5, fontId: "classic", textColor: "yellow" };
  const old = usableCaptionStyle(stored, false);
  eq("old build: a stored Classic is dropped in preview and render, colors stay", [old.fontId, old.textColor, captionSpec(old).fontName], [undefined, "yellow", undefined]);
  eq("old build: an unknown or missing font is the system font (not Classic)", styledSpec({ ...defaultCaptionStyle() }).fontName, undefined);
  eq("old build: the text overlay render spec has no fontName", textSpec(false).fontName, undefined);
  eq("old build: the text overlay spec is exactly the preset", textSpec(false), resolveOverlayStyle("text"));
  eq("toRenderJson without options equals the old build's", toRenderJson({ version: 1, clips: [], overlays: [{ kind: "text", text: "y", startMs: 0, endMs: 500 }] }), toRenderJson({ version: 1, clips: [], overlays: [{ kind: "text", text: "y", startMs: 0, endMs: 500 }] }, { supportsFont: false }));
}

// ── text overlays ──
{
  eq("capable build: text overlays render in Montserrat-Bold", textSpec(true).fontName, "Montserrat-Bold");
  const { fontName, ...rest } = textSpec(true);
  eq("capable build: nothing else changes in a text overlay's spec", rest, resolveOverlayStyle("text"));
}

// ── reset ──
{
  const edited = { scale: 1.4, yCenter: 0.5, xCenter: 0.5, fontId: "futura", textColor: "yellow", backgroundColor: "red" };
  const r = resetCaptionLook(edited, true);
  eq("Reset (capable build): Classic, default colors, size and place kept", r, { scale: 1.4, yCenter: 0.5, xCenter: 0.5, fontId: "classic" });
  const spec = captionSpec(usableCaptionStyle(r, true));
  eq("Reset renders Montserrat, white text, rounded black background", [spec.fontName, spec.color, spec.backgroundColor, spec.cornerRadius > 0], ["Montserrat-ExtraBold", "#FFFFFF", "#000000", true]);
  eq("Reset (old build): the same as before", resetCaptionLook(edited), { scale: 1.4, yCenter: 0.5, xCenter: 0.5 });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
