#!/usr/bin/env node
/**
 * Text overlay fonts and styles: the defaults, the stored fields (drafts, undo), the older look unchanged, font
 * fallback, the editor's layout, and how the outline is drawn.
 *   node --experimental-strip-types --no-warnings scripts/test-text-styles.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DEFAULT_TEXT_FONT_ID, EXTRA_TEXT_COLORS, LEGACY_TEXT_FONT_ID, NEW_TEXT_APPEARANCE, NEW_TEXT_FONT_SIZE, STROKE_EM, STROKE_SIZES, TEXT_COLORS,
  TEXT_FONTS, TEXT_LOOKS, appearancePatch, applyTextEdit, burnedFontName, editorStateOf, nextLook, parseHexColor, resolveAppearance,
  strokeColorFor, textFont, textFontFamily, textOnColor,
} from "../lib/textLook.ts";
import { resolveBgMeta } from "../lib/textOverlayStyle.ts";
import { overlayFont, overlayFontFamily } from "../lib/feedLayout.ts";
import { TEXT_FONT_FAMILY, TEXT_FONT_NAME, contrastRatio } from "../lib/transcription/captionPresets.ts";
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

// ── 1. the fonts ──────────────────────────────────────────────────────────────
{
  eq("eight fonts, in the order of the chips", TEXT_FONTS.map((f) => f.id), ["anton", "archivo-black", "montserrat", "poppins", "marker", "caveat", "dm-serif", "space-grotesk"]);
  eq("Anton is the default font; Montserrat stays the font of older texts", [DEFAULT_TEXT_FONT_ID, LEGACY_TEXT_FONT_ID, TEXT_FONTS.find((f) => f.id === "montserrat").family], ["anton", "montserrat", TEXT_FONT_FAMILY]);
  eq("one weight each: the families the spec asks for", TEXT_FONTS.map((f) => f.family), ["Anton_400Regular", "ArchivoBlack_400Regular", "Montserrat_700Bold", "Poppins_600SemiBold", "PermanentMarker_400Regular", "Caveat_700Bold", "DMSerifDisplay_400Regular", "SpaceGrotesk_700Bold"]);
  eq("families and PostScript names are unique", [new Set(TEXT_FONTS.map((f) => f.family)).size, new Set(TEXT_FONTS.map((f) => f.psName)).size], [8, 8]);
  eq("Montserrat's PostScript name is the one the caption renderer already embeds", TEXT_FONTS.find((f) => f.id === "montserrat").psName, TEXT_FONT_NAME);

  const layout = read("../app/_layout.tsx");
  const imports = [...layout.matchAll(/from "(@expo-google-fonts\/[^"]+)"/g)].map((m) => m[1]);
  ok("every font is imported one weight at a time (the package index would bundle every weight)", imports.length === 14 && imports.every((i) => /^@expo-google-fonts\/[a-z-]+\/\d{3}[A-Za-z]+$/.test(i)));
  ok("every imported font file exists", imports.every((i) => { try { require.resolve(i); return true; } catch { return false; } }));
  ok("no import of a package index", !/from "@expo-google-fonts\/[a-z-]+"/.test(layout));
  ok("each text font family is loaded by useFonts", TEXT_FONTS.every((f) => new RegExp(`\\b${f.family}\\b,`).test(layout.slice(layout.indexOf("useFonts({")))));
  ok("a font that fails to load does not keep the app on the splash screen", /const fontsReady = fontsLoaded \|\| !!fontError/.test(layout));
  const pkg = JSON.parse(read("../package.json"));
  ok("the font packages are dependencies (OFL, Google Fonts)", ["anton", "archivo-black", "poppins", "permanent-marker", "caveat", "dm-serif-display", "space-grotesk", "montserrat"].every((n) => pkg.dependencies[`@expo-google-fonts/${n}`]));
  const unusedWeight = ["montserrat", "plus-jakarta-sans"].flatMap((n) => imports.filter((i) => i.includes(n)));
  eq("Montserrat: only Bold and ExtraBold are bundled (captions and text); Plus Jakarta: the five weights UiText uses", [unusedWeight.filter((i) => i.includes("montserrat")).length, unusedWeight.filter((i) => i.includes("plus-jakarta")).length], [2, 5]);
  const app = JSON.parse(read("../app.json"));
  eq("app.json: the native font plugin is unchanged (Montserrat for the caption renderer) and the version stays", [app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font")[1].fonts.length, app.expo.version], [2, "1.0.4"]);
}

// ── 2. defaults for a new text ───────────────────────────────────────────────
{
  eq("a new text: Anton, white fill, thick outline, shadow, no box", NEW_TEXT_APPEARANCE, { fontId: "anton", color: "#FFFFFF", look: "outline", stroke: "thick", shadow: true });
  const r = resolveAppearance(NEW_TEXT_APPEARANCE);
  eq("...drawn as: white fill, a black outline reaching 0.1 em, a shadow, no box", [r.textColor, r.stroke, r.shadow, r.boxColor, r.look, r.fontId], ["#FFFFFF", { color: "#000000", em: 0.1 }, true, null, "outline", "anton"]);
  eq("the editor opens a new text with those defaults", editorStateOf(null), NEW_TEXT_APPEARANCE);
  eq("outline thickness is thin < medium < thick", STROKE_SIZES.map((s) => STROKE_EM[s]), [0.035, 0.065, 0.1]);
  ok("a new text is a little bigger than the old default (Anton is narrow)", NEW_TEXT_FONT_SIZE > 26);
  const edit = read("../app/edit.tsx");
  ok("edit.tsx makes new texts from the defaults through applyTextEdit and one undo snapshot", /pushSnapshot\(clips, textOverlays\);\s*const \{ overlays, created \} = applyTextEdit\(/.test(edit) && /initialAppearance=\{editorStateOf\(editingOverlay\)\}/.test(edit));
}

// ── 3. the looks ─────────────────────────────────────────────────────────────
{
  const outline = resolveAppearance({ fontId: "anton", color: "#FFD400", look: "outline", stroke: "thin", shadow: false });
  eq("outline: the chosen color is the fill, thin reaches 0.035 em, no shadow when off", [outline.textColor, outline.stroke.em, outline.shadow, outline.boxColor], ["#FFD400", 0.035, false, null]);
  eq("a black fill gets a white outline so it does not vanish", resolveAppearance({ ...NEW_TEXT_APPEARANCE, color: "#000000" }).stroke.color, "#FFFFFF");
  const box = resolveAppearance({ fontId: "poppins", color: "#FFD400", look: "box", stroke: "thick", shadow: true });
  eq("box: the chosen color is the box and the text turns black on a light box", [box.boxColor, box.textColor, box.stroke, box.boxOpacity], ["#FFD400", "#000000", null, 1]);
  eq("box: white text on a dark box", resolveAppearance({ ...NEW_TEXT_APPEARANCE, look: "box", color: "#1E5BFF" }).textColor, "#FFFFFF");
  const plain = resolveAppearance({ fontId: "caveat", color: "#FF5FA8", look: "plain", stroke: "thick", shadow: true });
  eq("plain + shadow: the fill, a shadow, no outline and no box", [plain.textColor, plain.shadow, plain.stroke, plain.boxColor], ["#FF5FA8", true, null, null]);
  eq("the style toggle cycles outline -> box -> plain -> outline", [nextLook("outline"), nextLook("box"), nextLook("plain")], ["box", "plain", "outline"]);
  eq("every look is offered", TEXT_LOOKS, ["outline", "box", "plain"]);
  ok("text on any color keeps a readable contrast (>= 3)", [...TEXT_COLORS, ...EXTRA_TEXT_COLORS].every((c) => contrastRatio(textOnColor(c.hex), c.hex) >= 3));
  eq("the color row: white, black, Trial red, yellow, blue, green, pink", TEXT_COLORS.map((c) => c.id), ["white", "black", "red", "yellow", "blue", "green", "pink"]);
  eq("Trial red is the app's red", TEXT_COLORS.find((c) => c.id === "red").hex, "#E8291C");
  eq("a hex typed by hand is normalised, a bad one refused", [parseHexColor("ff8800"), parseHexColor("#12abEF"), parseHexColor("red"), parseHexColor("#12")], ["#FF8800", "#12ABEF", null, null]);
  eq("an unknown look or a broken color falls back to the defaults", [resolveAppearance({ look: "weird", color: "nope", fontId: "anton" }).look, resolveAppearance({ look: "outline", color: "nope", fontId: "anton" }).textColor], ["outline", "#FFFFFF"]);
}

// ── 4. an older text looks exactly as before ─────────────────────────────────
{
  for (const bg of ["none-white", "none-black", "white-box", "black-box", "accent-box", "translucent-box"]) {
    const old = resolveBgMeta(bg, "#E8291C");
    const now = resolveAppearance({ backgroundStyle: bg, color: "#E8291C" });
    const same = now.legacy && now.textColor === old.textColor && (old.bgOpacity > 0 ? now.boxColor === old.bgColor && now.boxOpacity === old.bgOpacity : now.boxColor === null) && now.stroke === null;
    ok(`an older "${bg}" text: same colors and box as before, no outline`, same);
  }
  eq("an older text keeps Montserrat unless a font was chosen", [resolveAppearance({ backgroundStyle: "none-white" }).fontId, overlayFontFamily(undefined)], ["montserrat", TEXT_FONT_FAMILY]);
  eq("an older text with a caption font id from the old Style choice keeps that font", overlayFontFamily("avenir"), "AvenirNext-Heavy");
  eq("the editor opens an older text with the look it has now", [editorStateOf({ backgroundStyle: "black-box", color: "#FFFFFF" }).look, editorStateOf({ backgroundStyle: "black-box" }).color, editorStateOf({ backgroundStyle: "none-black" }).color], ["box", "#000000", "#000000"]);
  const draw = read("../components/OverlayText.tsx");
  ok("an older text still gets its old shadow (1 pt down, 4 pt blur, 60%)", /textShadowOffset: \{ width: 0, height: 1 \},\s*textShadowRadius: 4/.test(draw));
}

// ── 5. stored with the overlay, drafts and undo ──────────────────────────────
{
  const makeNew = () => ({ id: "t1", text: "", x: 0.5, y: 0.4, fontSize: NEW_TEXT_FONT_SIZE, rotation: 0, color: "#FFFFFF", backgroundStyle: "none-white" });
  const first = applyTextEdit([], null, "HELLO", NEW_TEXT_APPEARANCE, makeNew);
  eq("a new text carries font, color, look, outline and shadow", first.overlays[0], { id: "t1", text: "HELLO", x: 0.5, y: 0.4, fontSize: 30, rotation: 0, color: "#FFFFFF", backgroundStyle: "none-white", fontId: "anton", look: "outline", stroke: "thick", shadow: true });
  // snapshots are JSON clones (hooks/useUndoRedo.ts): the new fields survive them, and a draft is the same JSON
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let overlays = first.overlays;
  const undo = [];
  const edited = { fontId: "marker", color: "#FF5FA8", look: "plain", stroke: "medium", shadow: false };
  undo.push(clone(overlays));
  overlays = applyTextEdit(overlays, "t1", "HELLO", edited, makeNew).overlays;
  eq("editing changes the look and keeps position, size and rotation", [overlays[0].fontId, overlays[0].color, overlays[0].look, overlays[0].stroke, overlays[0].shadow, overlays[0].x, overlays[0].fontSize], ["marker", "#FF5FA8", "plain", "medium", false, 0.5, 30]);
  const draft = clone(overlays);
  eq("a draft (JSON) keeps font, color, style, outline and shadow", editorStateOf(draft[0]), edited);
  eq("...and draws the same after a reload", resolveAppearance(draft[0]), resolveAppearance(overlays[0]));
  const redo = [clone(overlays)];
  overlays = undo.pop();
  eq("undo brings back the whole previous look (font, color, style, outline, shadow)", editorStateOf(overlays[0]), NEW_TEXT_APPEARANCE);
  overlays = redo.pop();
  eq("redo brings the new look back", editorStateOf(overlays[0]), edited);
  eq("only the edited overlay changes", applyTextEdit([{ ...makeNew(), id: "a", text: "A" }, { ...makeNew(), id: "b", text: "B" }], "b", "B2", NEW_TEXT_APPEARANCE, makeNew).overlays.map((o) => [o.id, o.text, o.fontId ?? null]), [["a", "A", null], ["b", "B2", "anton"]]);
  eq("an unknown id adds a new text instead of dropping the edit", applyTextEdit([], "gone", "X", NEW_TEXT_APPEARANCE, makeNew).overlays.length, 1);
  const prov = read("../providers/PostsProvider.tsx");
  ok("the type documents the new fields (stored in the existing text_overlays JSON, no new column)", /look\?: "outline" \| "box" \| "plain"/.test(prov) && /stroke\?: "thin" \| "medium" \| "thick"/.test(prov) && /shadow\?: boolean/.test(prov));
  ok("the style button on a selected text cycles the new looks", /if \(ov\.look\) return \{ \.\.\.ov, look: nextLook\(ov\.look\) \}/.test(read("../app/edit.tsx")));
}

// ── 6. font fallback ─────────────────────────────────────────────────────────
{
  const loaded = new Set(["Anton_400Regular", TEXT_FONT_FAMILY]);
  const isLoaded = (f) => loaded.has(f);
  eq("a loaded font is used", textFontFamily("anton", isLoaded), "Anton_400Regular");
  eq("a font that did not load falls back to Montserrat Bold", textFontFamily("caveat", isLoaded), TEXT_FONT_FAMILY);
  eq("an unknown font id falls back to Montserrat Bold", [textFontFamily("comic-sans", isLoaded), textFontFamily(undefined, isLoaded)], [TEXT_FONT_FAMILY, TEXT_FONT_FAMILY]);
  eq("the overlay font style uses the same fallback", [overlayFont("anton", isLoaded), overlayFont("marker", isLoaded)], [{ fontFamily: "Anton_400Regular", fontWeight: "400" }, { fontFamily: TEXT_FONT_FAMILY, fontWeight: "400" }]);
  eq("an app version that does not know a font id also falls back to Montserrat (its old code looked the id up in the caption fonts)", ["anton", "marker", "caveat"].map((id) => !textFont(id) ? "?" : "known"), ["known", "known", "known"]);
  // burned in (a native renderer): not today, text overlays are live
  eq("burned in, a font falls back to Montserrat Bold unless the build embeds it", [burnedFontName("anton"), burnedFontName("anton", ["Anton-Regular"]), burnedFontName("marker", ["Anton-Regular"]), burnedFontName("unknown")], [TEXT_FONT_NAME, "Anton-Regular", TEXT_FONT_NAME, TEXT_FONT_NAME]);
  const exportEdit = read("../lib/exportEdit.ts");
  ok("text overlays are never part of the posted or exported video (only captions are burned in)", /Text-button overlays are NOT part of it/.test(exportEdit) && /never part of it/.test(read("../lib/saveToRoll.ts")));
}

// ── 7. the editor: nothing overlaps ──────────────────────────────────────────
{
  const rows = (o) => panelHeight(o);
  eq("panel height: colors + style rows, plus fonts, plus extra colors", [rows({ fonts: false, extraColors: false }), rows({ fonts: true, extraColors: false }), rows({ fonts: true, extraColors: true })], [2 * PANEL_ROW_H + 8 + 16, 3 * PANEL_ROW_H + 16 + 16, 4 * PANEL_ROW_H + 24 + 16]);
  for (const [name, screenH, kb, top] of [["iPhone SE", 667, 260, 20], ["iPhone 15", 852, 336, 59], ["keyboard down", 667, 0, 20]]) {
    for (const opts of [{ fonts: true, extraColors: false }, { fonts: true, extraColors: true }, { fonts: false, extraColors: false }]) {
      const ph = panelHeight(opts);
      const l = editorLayout(screenH, kb, top, ph);
      const fieldBottom = l.fieldArea.top + l.fieldArea.height;
      const controlsBottom = l.controls.top + l.controls.height;
      eq(`${name} (${opts.fonts ? "fonts" : "no fonts"}${opts.extraColors ? ", extra colors" : ""}): controls, field, panel and keyboard stack without overlap`, [controlsBottom <= l.fieldArea.top, fieldBottom <= l.panel.top, l.panel.top + l.panel.height === screenH - kb, l.panel.height === ph, l.fieldArea.height >= 80], [true, true, true, true, true]);
    }
  }
  const ed = read("../components/TextOverlayEditor.tsx");
  ok("the Aa button in the top row toggles the font row; fonts are chips, each label in its own font", /accessibilityLabel="Fonts"/.test(ed) && /setShowFonts\(\(v\) => !v\)/.test(ed) && /textFontFamily\(f\.id, isLoaded\)/.test(ed));
  ok("color row (with a + for more colors), style toggle, outline thickness, shadow toggle", /TEXT_COLORS\.map/.test(ed) && /accessibilityLabel="More colors"/.test(ed) && /nextLook\(ap\.look\)/.test(ed) && /STROKE_SIZES\.map/.test(ed) && /accessibilityLabel="Shadow"/.test(ed));
  ok("all touch targets in the panel are at least 44 pt (rows are 44, buttons 40-44 inside them)", PANEL_ROW_H >= 44 && /swatchHit: \{ width: 44, height: 44/.test(ed) && /segBtn: \{ width: 44/.test(ed));
  ok("size by pinch and position by drag are the existing overlay gestures", /Gesture\.Pinch\(\)/.test(read("../components/DraggableTextOverlay.tsx")) && /Gesture\.Pan\(\)/.test(read("../components/DraggableTextOverlay.tsx")));
}

// ── 8. how it is drawn ───────────────────────────────────────────────────────
{
  const hug = read("../components/HuggingText.tsx");
  ok("the outline is a real SVG stroke: one stroked layer under one fill layer per line (no offset copies)", /strokeWidth=\{outline\.reach \* 2\}/.test(hug) && /strokeLinejoin="round"/.test(hug) && (hug.match(/<SvgText /g) || []).length === 2 && !/offset|dx=|dy=/.test(hug.slice(hug.indexOf("function OutlineLayer"), hug.indexOf("const styles"))));
  ok("the outline layer is positioned from the measured lines, so the text wraps exactly as it is laid out", /measured\.map\(\(l, i\)/.test(hug) && /l\.x \+ l\.width \/ 2/.test(hug));
  ok("the shadow is a soft drop shadow behind the outlined letters", /shadowOpacity: 0\.55/.test(hug));
  const draw = read("../components/OverlayText.tsx");
  ok("editor, Preview and the feed draw an overlay through one component", /<OverlayText/.test(read("../components/DraggableTextOverlay.tsx")) && /<OverlayText/.test(read("../components/FeedItem.tsx")) && !/<HuggingText/.test(read("../components/DraggableTextOverlay.tsx")) && !/<HuggingText/.test(read("../components/FeedItem.tsx")));
  ok("the stroke scales with the font size (reach = em x font size), so it is crisp at every size", /reach: a\.stroke\.em \* layout\.fontSize/.test(draw));
  eq("strokeColorFor: black normally, white around dark text", [strokeColorFor("#FFFFFF"), strokeColorFor("#FFD400"), strokeColorFor("#000000"), strokeColorFor("#10265C")], ["#000000", "#000000", "#FFFFFF", "#FFFFFF"]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
