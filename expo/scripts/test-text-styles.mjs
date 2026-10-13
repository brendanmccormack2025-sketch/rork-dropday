#!/usr/bin/env node
/**
 * Text overlay and caption styles: the fonts and the shared palette, the defaults, the stored fields (drafts, undo),
 * the older looks unchanged, font fallback, the editor's layout, and the exhaustive style -> render-parameters matrix
 * (every font x text color x background x outline x shadow), for text overlays and for captions.
 *   node --experimental-strip-types --no-warnings scripts/test-text-styles.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DEFAULT_TEXT_FONT_ID, LEGACY_TEXT_FONT_ID, NEW_TEXT_APPEARANCE, NEW_TEXT_FONT_SIZE, STROKE_EM, STROKE_SIZES, TEXT_FONTS,
  appearancePatch, applyTextEdit, burnedFontName, editorStateOf, parseHexColor, resolveAppearance, textFont, textFontFamily,
} from "../lib/textLook.ts";
import { PALETTE, TRANSLUCENT, paletteFor } from "../lib/palette.ts";
import { overlayRenderStyle, toRenderJson } from "../lib/editStyles.ts";
import { CAPTION_BACKGROUNDS, CAPTION_FONTS, CAPTION_TEXT_COLORS, TEXT_FONT_FAMILY, TEXT_FONT_NAME } from "../lib/transcription/captionPresets.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { defaultCaptionStyle } from "../lib/transcription/captionStyle.ts";
import { PANEL_ROW_H, editorLayout, panelHeight } from "../lib/textEditorLayout.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const require = createRequire(import.meta.url);

// ── 1. the fonts ──
{
  eq("nine fonts, TikTok Sans first", TEXT_FONTS.map((f) => f.id), ["tiktok-sans", "anton", "archivo-black", "montserrat", "poppins", "marker", "caveat", "dm-serif", "space-grotesk"]);
  eq("TikTok Sans is the default; Montserrat stays the font of older texts", [DEFAULT_TEXT_FONT_ID, LEGACY_TEXT_FONT_ID], ["tiktok-sans", "montserrat"]);
  eq("TikTok Sans Bold family and PostScript name", [textFont("tiktok-sans").family, textFont("tiktok-sans").psName], ["TikTokSans_700Bold", "TikTokSans-Bold"]);
  eq("families and PostScript names are unique", [new Set(TEXT_FONTS.map((f) => f.family)).size, new Set(TEXT_FONTS.map((f) => f.psName)).size], [9, 9]);
  eq("Montserrat's PostScript name is the one the caption renderer already embeds", textFont("montserrat").psName, TEXT_FONT_NAME);
  const layout = read("../app/_layout.tsx");
  const imports = [...layout.matchAll(/from "(@expo-google-fonts\/[^"]+)"/g)].map((m) => m[1]);
  ok("every font is imported one weight at a time", imports.length === 15 && imports.every((i) => /^@expo-google-fonts\/[a-z-]+\/\d{3}[A-Za-z]+$/.test(i)));
  ok("every imported font file exists", imports.every((i) => { try { require.resolve(i); return true; } catch { return false; } }));
  ok("TikTok Sans Bold is among them", imports.includes("@expo-google-fonts/tiktok-sans/700Bold"));
  eq("a font that is not loaded falls back to Montserrat Bold", [textFontFamily("anton", () => false), textFontFamily("anton", () => true), textFontFamily("nope")], [TEXT_FONT_FAMILY, "Anton_400Regular", TEXT_FONT_FAMILY]);
  eq("burned in: the font's own name only when the build embeds it, else Montserrat Bold", [burnedFontName("tiktok-sans"), burnedFontName("tiktok-sans", ["TikTokSans-Bold"]), burnedFontName("unknown", ["TikTokSans-Bold"])], [TEXT_FONT_NAME, "TikTokSans-Bold", TEXT_FONT_NAME]);
}

// ── 2. the shared palette ──
{
  eq("eleven solids, in this order", PALETTE.map((c) => c.id), ["white", "black", "red", "yellow", "orange", "green", "teal", "blue", "purple", "pink", "grey"]);
  eq("Trial red", PALETTE.find((c) => c.id === "red").hex, "#E8291C");
  eq("text and outline use the solids; a background adds black 60% and white 60%", [paletteFor("text").length, paletteFor("outline").length, paletteFor("background").map((c) => c.id).slice(-2)], [11, 11, ["black-60", "white-60"]]);
  eq("captions use the very same colors, same order", CAPTION_TEXT_COLORS.map((c) => c.color), PALETTE.map((c) => c.hex));
  eq("caption backgrounds: the same, the translucent ones, then None", CAPTION_BACKGROUNDS.map((c) => c.color), [...PALETTE.map((c) => c.hex), ...TRANSLUCENT.map((c) => c.hex), null]);
  const sheet = read("../components/CaptionStyleSheet.tsx"), editor = read("../components/TextOverlayEditor.tsx");
  ok("both editors take the colors from the shared palette", /paletteFor|PALETTE|CAPTION_TEXT_COLORS/.test(sheet) && /paletteFor/.test(editor));
}

// ── 3. defaults and stored fields ──
{
  eq("a new text: TikTok Sans, white, thin black outline, soft shadow, no background", NEW_TEXT_APPEARANCE, { fontId: "tiktok-sans", color: "#FFFFFF", outline: true, outlineColor: "#000000", stroke: "thin", shadow: true, background: false, bgColor: "#000000" });
  eq("editorStateOf(null) is the default", editorStateOf(null), NEW_TEXT_APPEARANCE);
  eq("stroke sizes", [STROKE_SIZES, STROKE_EM], [["thin", "medium", "thick"], { thin: 0.035, medium: 0.065, thick: 0.1 }]);
  ok("a new text starts at a sensible size", NEW_TEXT_FONT_SIZE >= 24 && NEW_TEXT_FONT_SIZE <= 40);
  const st = { fontId: "poppins", color: "#FFD400", outline: true, outlineColor: "#E8291C", stroke: "thick", shadow: false, background: true, bgColor: "#00000099" };
  eq("the fields survive a round trip through a draft (JSON)", editorStateOf(JSON.parse(JSON.stringify(appearancePatch(st)))), st);
  const r = applyTextEdit([{ id: "a", text: "x", fontSize: 30 }], "a", "hi", st, () => ({}));
  eq("editing an overlay keeps what is not the look, replaces the look", [r.overlays[0].text, r.overlays[0].fontSize, r.overlays[0].bgColor, r.created], ["hi", 30, "#00000099", null]);
  const n = applyTextEdit([], null, "new", NEW_TEXT_APPEARANCE, () => ({ id: "n", text: "", fontSize: 30 }));
  eq("a new text gets the look", [n.overlays.length, n.created.fontId, n.created.outline, n.created.background], [1, "tiktok-sans", true, false]);
  eq("hex input", [parseHexColor("ff00aa"), parseHexColor("#12AB34"), parseHexColor("nope")], ["#FF00AA", "#12AB34", null]);
}

// ── 4. older overlays are drawn as before ──
{
  const legacy = resolveAppearance({});
  eq("no look fields: white text, soft shadow, no box, Montserrat (the first Text button)", [legacy.legacy, legacy.textColor, legacy.boxColor, legacy.shadow, legacy.fontId, legacy.stroke], [true, "#FFFFFF", null, true, "montserrat", null]);
  eq("black-box", (({ textColor, boxColor, shadow }) => [textColor, boxColor, shadow])(resolveAppearance({ backgroundStyle: "black-box" })), ["#FFFFFF", "#000000", false]);
  eq("white-box", (({ textColor, boxColor }) => [textColor, boxColor])(resolveAppearance({ backgroundStyle: "white-box" })), ["#000000", "#FFFFFF"]);
  eq("translucent-box has its opacity", resolveAppearance({ backgroundStyle: "translucent-box" }).boxOpacity, 0.55);
  const o = resolveAppearance({ look: "box", color: "#FFD400" });
  eq("generation 2 box: yellow box, readable text", [o.boxColor, o.textColor], ["#FFD400", "#000000"]);
  const p = resolveAppearance({ look: "outline", color: "#FFFFFF", stroke: "medium" });
  eq("generation 2 outline", [p.stroke, p.boxColor], [{ color: "#000000", em: 0.065 }, null]);
}

// ── 5. the editor's layout ──
{
  eq("the panel has one row more with the fonts", panelHeight({ fonts: true }) - panelHeight({ fonts: false }), PANEL_ROW_H + 8);
  const l = editorLayout(800, 300, 40, panelHeight({ fonts: true }));
  ok("the field area fits above the panel", l.fieldArea.top + l.fieldArea.height <= l.panel.top);
}

// ── 6. THE MATRIX: style -> render parameters ──
const OUTLINE_CAPS = { outline: true, fontNames: TEXT_FONTS.map((f) => f.psName) };
const NO_CAPS = {};
const BACKGROUNDS = [{ on: false, hex: "#000000" }, ...[...PALETTE, ...TRANSLUCENT].map((c) => ({ on: true, hex: c.hex }))];
{
  let n = 0, bad = [];
  for (const font of TEXT_FONTS) for (const text of PALETTE) for (const bg of BACKGROUNDS) for (const outline of [null, ...STROKE_SIZES]) for (const shadow of [false, true]) {
    n++;
    const ov = { fontSize: 30, fontId: font.id, color: text.hex, outline: outline !== null, outlineColor: "#1E5BFF", stroke: outline ?? "thin", shadow, background: bg.on, bgColor: bg.hex };
    const a = overlayRenderStyle(ov, OUTLINE_CAPS);
    const old = overlayRenderStyle(ov, NO_CAPS);
    const fail = (why) => bad.push(`${font.id}/${text.id}/${bg.on ? bg.hex : "no-bg"}/${outline}/${shadow}: ${why}`);
    if (a.color !== text.hex) fail("text color changed");
    if (old.color !== text.hex) fail("text color changed on the 1.0.4 build");
    if (a.fontName !== font.psName) fail("font name");
    if (old.fontName !== TEXT_FONT_NAME) fail("1.0.4 build must fall back to Montserrat");
    if (bg.on ? a.backgroundColor !== bg.hex || a.lineBackground !== true : "backgroundColor" in a) fail("background");
    if (bg.on !== ("backgroundColor" in old)) fail("background (1.0.4)");
    if (!!a.shadow !== shadow || !!old.shadow !== shadow) fail("shadow is not independent");
    if (outline === null ? "outlineColor" in a || "outlineWidth" in a : a.outlineColor !== "#1E5BFF" || Math.abs(a.outlineWidth - STROKE_EM[outline] * 30) > 1e-9) fail("outline");
    if ("outlineColor" in old || "outlineWidth" in old) fail("outline keys sent to a build that cannot draw them");
    const r = resolveAppearance(ov);
    if (r.textColor !== text.hex || (r.boxColor !== null) !== bg.on || (r.stroke !== null) !== (outline !== null) || r.shadow !== shadow) fail("preview (resolveAppearance) differs from the render");
  }
  eq(`overlay matrix: ${n} combinations (9 fonts x 11 colors x 14 backgrounds x 4 outlines x 2 shadows), each independent`, bad.slice(0, 5), []);
  eq("...and it really covered 9 x 11 x 14 x 4 x 2", n, 9 * 11 * 14 * 4 * 2);
}
{
  const ov = (c) => overlayRenderStyle({ fontSize: 30, ...c }, OUTLINE_CAPS);
  eq("changing the background never changes the text color", ov({ color: "#FFFFFF", background: true, bgColor: "#FFD400" }).color, "#FFFFFF");
  eq("white text on a yellow background renders white on yellow", [ov({ color: "#FFFFFF", background: true, bgColor: "#FFD400" }).color, ov({ color: "#FFFFFF", background: true, bgColor: "#FFD400" }).backgroundColor], ["#FFFFFF", "#FFD400"]);
  eq("the same color for text and background is allowed", ov({ color: "#FFFFFF", background: true, bgColor: "#FFFFFF" }).color, "#FFFFFF");
  eq("semi-transparent backgrounds keep their alpha", ov({ color: "#FFFFFF", background: true, bgColor: "#00000099" }).backgroundColor, "#00000099");
  eq("the shadow is the box's when there is a box, the letters' when not (renderer: container layer)", [ov({ shadow: true, background: true, bgColor: "#000000" }).shadow, ov({ shadow: true }).shadow], [true, true]);
}

// ── 7. the same matrix for captions ──
{
  const KEEP = [{ startMs: 0, endMs: 3000 }];
  const spec = (style, options) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([{ text: "hi", startMs: 100, endMs: 400 }], {}, KEEP, style), style) }, options)).overlays[0].styleSpec;
  const embedded = CAPTION_FONTS.map((f) => f.fontName).filter(Boolean);
  const base = defaultCaptionStyle();
  let n = 0, bad = [];
  for (const font of CAPTION_FONTS) for (const t of CAPTION_TEXT_COLORS) for (const b of CAPTION_BACKGROUNDS) for (const outline of [undefined, "thin", "medium", "thick"]) for (const shadow of [false, true]) {
    n++;
    const style = { ...base, fontId: font.id, textColor: t.id, backgroundColor: b.id, shadow, ...(outline ? { outline, outlineColor: "blue" } : {}) };
    const s = spec(style, { supportsFont: true, supportsOutline: true, fontNames: embedded });
    const fail = (why) => bad.push(`${font.id}/${t.id}/${b.id}/${outline}/${shadow}: ${why}`);
    if (s.color !== t.color) fail("text color");
    if (b.color === null ? "backgroundColor" in s : s.backgroundColor !== b.color) fail("background");
    if (!!s.shadow !== shadow) fail("shadow");
    if (outline ? s.outlineColor !== "#1E5BFF" || !(s.outlineWidth > 0) : "outlineColor" in s) fail("outline");
    if ((s.fontName ?? null) !== font.fontName) fail("font");
    const old = spec(style, { supportsFont: true, fontNames: [] });
    if ("outlineColor" in old || old.color !== t.color) fail("1.0.4: outline keys or color");
  }
  eq(`caption matrix: ${n} combinations (${CAPTION_FONTS.length} fonts x ${CAPTION_TEXT_COLORS.length} colors x ${CAPTION_BACKGROUNDS.length} backgrounds x 4 outlines x 2 shadows)`, bad.slice(0, 5), []);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
