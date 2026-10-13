#!/usr/bin/env node
/**
 * Text burned into the saved video (build 1.0.5): the export JSON carries every Text-button overlay with the SAME layout
 * numbers as the editor preview (font size, padding, corner, max width, line height, centre, rotation, pinch), for every
 * style (font, color, outline, shadow, background, none, legacy presets, rotated, pinched, multi-line); the capability flag
 * and the "Include text in saved video" setting switch it off; the Swift reads every key the JS sends.
 *   node --experimental-strip-types --no-warnings scripts/test-text-export.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { TEXT_LINE_HEIGHT_EM, TEXT_MAX_WIDTH, textLayout } from "../lib/feedLayout.ts";
import { effectiveFontSize, textOverlayExportSpec, textOverlaysForSave, textOverlaysToEditOverlays } from "../lib/textOverlayStyle.ts";
import { LEGACY_SHADOW_REF_WIDTH, NEW_TEXT_APPEARANCE, OUTLINE_SHADOW, STROKE_EM, STROKE_SIZES, TEXT_FONTS, appearancePatch, resolveAppearance, shadowOf } from "../lib/textLook.ts";
import { toRenderJson } from "../lib/editStyles.ts";
import { PALETTE, TRANSLUCENT } from "../lib/palette.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const ALL_FONTS = TEXT_FONTS.map((f) => f.psName);
const CAPS = { fontNames: ALL_FONTS };
const base = { id: "t1", text: "Hello", x: 0.5, y: 0.6, fontSize: 30, rotation: 0, color: "#FFFFFF", backgroundStyle: "none-white", kind: "text" };
const look = (over) => ({ ...base, ...appearancePatch({ ...NEW_TEXT_APPEARANCE, ...over }), ...(over.ov ?? {}) });

// The editor's numbers for the same overlay on a video W wide, scaled to the 1080 frame the export is written in.
function previewAt1080(ov, W) {
  const l = textLayout(effectiveFontSize(ov), W);
  const k = 1080 / W;
  return { fontSize: l.fontSize * k, padX: l.padX * k, padY: l.padY * k, corner: l.cornerRadius * k, maxWidth: (l.maxWidth * k) / 1080 };
}

function checkLayout(name, ov) {
  const s = textOverlayExportSpec(ov, CAPS);
  for (const W of [250, 360, 390, 720, 1080]) {
    const p = previewAt1080(ov, W);
    const same = near(s.fontSize, p.fontSize) && near(s.backgroundPaddingX, p.padX) && near(s.backgroundPaddingY, p.padY) && near(s.maxWidth, p.maxWidth);
    if (!same) { eq(`${name}: layout equals the preview at ${W} wide`, [s.fontSize, s.backgroundPaddingX, s.backgroundPaddingY, s.maxWidth], [p.fontSize, p.padX, p.padY, p.maxWidth]); return s; }
    if (s.backgroundColor && !near(s.cornerRadius, p.corner)) { eq(`${name}: corner radius equals the preview`, s.cornerRadius, p.corner); return s; }
  }
  if (s.lineHeight !== TEXT_LINE_HEIGHT_EM || s.xCenter !== ov.x || s.yCenter !== ov.y) { eq(`${name}: line height and centre`, [s.lineHeight, s.xCenter, s.yCenter], [TEXT_LINE_HEIGHT_EM, ov.x, ov.y]); return s; }
  return s;
}

// ── 1. every style: the same layout numbers as the preview ──
{
  let n = 0, bad = 0;
  const fail = (m) => { bad++; if (bad < 5) console.log("FAIL  " + m); };
  const bgs = [{ background: false }, ...[...PALETTE.slice(0, 11)].map((c) => ({ background: true, bgColor: typeof c === "string" ? c : c.hex ?? c })), ...TRANSLUCENT.slice(0, 2).map((c) => ({ background: true, bgColor: typeof c === "string" ? c : c.hex ?? c }))];
  for (const font of TEXT_FONTS) for (const color of ["#FFFFFF", "#000000", "#FF3B30"]) for (const bg of bgs) for (const outline of [null, ...STROKE_SIZES]) for (const shadow of [true, false]) {
    const ov = look({ fontId: font.id, color, ...bg, outline: outline !== null, stroke: outline ?? "thin", outlineColor: "#112233", shadow });
    const s = textOverlayExportSpec(ov, CAPS);
    const a = resolveAppearance(ov);
    n++;
    const p = previewAt1080(ov, 390);
    if (!(near(s.fontSize, p.fontSize) && near(s.backgroundPaddingX, p.padX) && near(s.backgroundPaddingY, p.padY) && near(s.maxWidth, p.maxWidth))) fail(`layout ${font.id} ${color} ${JSON.stringify(bg)}`);
    if (s.fontName !== font.psName) fail(`font ${font.id} -> ${s.fontName}`);
    if (s.color !== color) fail(`text colour ${color} -> ${s.color}`);
    if (bg.background) {
      if (!s.backgroundColor || !s.lineBackground || !near(s.cornerRadius, p.corner)) fail(`background missing ${JSON.stringify(bg)}`);
      const want = a.boxOpacity < 1 ? a.boxColor + Math.round(a.boxOpacity * 255).toString(16).padStart(2, "0").toUpperCase() : a.boxColor;
      if (s.backgroundColor !== want) fail(`background colour ${s.backgroundColor} != ${want}`);
    } else if (s.backgroundColor || s.lineBackground || s.cornerRadius) fail(`background "none" must carry no background keys`);
    if (outline) {
      if (s.outlineColor !== "#112233" || !near(s.outlineWidth, STROKE_EM[outline] * s.fontSize)) fail(`outline ${outline}`);
    } else if (s.outlineColor || s.outlineWidth) fail("outline off must carry no outline keys");
    if (shadow) {
      if (!s.textShadow) fail("shadow on but no textShadow");
      else if (outline) { if (!(near(s.textShadow.radius, s.fontSize * OUTLINE_SHADOW.radiusEm) && near(s.textShadow.offsetY, s.fontSize * OUTLINE_SHADOW.offsetYEm) && s.textShadow.opacity === OUTLINE_SHADOW.opacity)) fail("outline shadow numbers"); }
      else if (!(near(s.textShadow.radius, (s.fontSize * 0.14) / 2) && near(s.textShadow.offsetY, s.fontSize * 0.05) && s.textShadow.opacity === 0.6)) fail("text shadow numbers");
    } else if (s.textShadow) fail("shadow off must carry no textShadow");
  }
  eq(`${n} style combinations (font x colour x background x outline x shadow) match the preview`, bad, 0);
}

// ── 2. the older presets, rotated, pinched, multi-line, positions ──
{
  for (const bs of ["none-white", "none-black", "white-box", "black-box", "accent-box", "translucent-box"]) {
    const ov = { ...base, backgroundStyle: bs, color: "#FF3B30" };
    const s = checkLayout(`legacy ${bs}`, ov);
    const a = resolveAppearance(ov);
    eq(`legacy ${bs}: text colour and box as the editor draws them`, [s.color, !!s.backgroundColor], [a.textColor, a.boxColor !== null]);
    const sh = shadowOf(a, s.fontSize, 1080 / LEGACY_SHADOW_REF_WIDTH);
    eq(`legacy ${bs}: shadow`, s.textShadow ?? null, sh ? { color: sh.color, opacity: sh.opacity, radius: sh.radius / 2, offsetY: sh.offsetY } : null);
    ok(`legacy ${bs}: never an outline`, !s.outlineColor && !s.outlineWidth);
  }
  eq("legacy none-black draws a white shadow under black text", textOverlayExportSpec({ ...base, backgroundStyle: "none-black" }, CAPS).textShadow.color, "#FFFFFF");
  for (const scale of [undefined, 0.4, 0.7, 1, 2.5, 4, 9, 0.01]) {
    const ov = look({ ov: { scale } });
    const s = textOverlayExportSpec(ov, CAPS);
    ok(`pinch ${scale}: font size is the typed size x the clamped scale on 1080`, near(s.fontSize, textLayout(effectiveFontSize(ov), 1080).fontSize));
    checkLayout(`pinch ${scale}`, ov);
  }
  eq("pinch is clamped to 0.4..4 like the editor", [textOverlayExportSpec(look({ ov: { scale: 9 } }), CAPS).fontSize, textOverlayExportSpec(look({ ov: { scale: 4 } }), CAPS).fontSize], [textOverlayExportSpec(look({ ov: { scale: 4 } }), CAPS).fontSize, textOverlayExportSpec(look({ ov: { scale: 4 } }), CAPS).fontSize]);
  for (const rotation of [-90, -37.5, 0, 12, 45, 180, 270]) {
    const s = textOverlayExportSpec(look({ ov: { rotation } }), CAPS);
    eq(`rotation ${rotation}`, s.rotation ?? 0, rotation);
  }
  ok("upright text sends no rotation key", !("rotation" in textOverlayExportSpec(look({}), CAPS)));
  for (const [x, y] of [[0, 0], [0.5, 0.5], [0.12, 0.88], [1, 1], [0.73, 0.31]]) {
    const s = textOverlayExportSpec(look({ ov: { x, y } }), CAPS);
    eq(`position (${x}, ${y}) is the overlay's own centre`, [s.xCenter, s.yCenter], [x, y]);
  }
  const text = "A long line of words that has to wrap onto\nseveral lines in the box\n\nand an emoji 😀";
  const multi = look({ ov: { text }, background: true, bgColor: "#000000" });
  const edit = textOverlaysToEditOverlays([multi], CAPS);
  eq("multi-line text is sent as typed (the renderer wraps at the same max width)", edit[0].text, text);
  checkLayout("multi-line", multi);
  eq("max width is the feed's 0.86 of the frame", textOverlayExportSpec(multi, CAPS).maxWidth, TEXT_MAX_WIDTH);
  ok("padding is sent with and without a background (the editor's box has it either way)", textOverlayExportSpec(look({}), CAPS).backgroundPaddingX > 0);
}

// ── 3. timing and the render JSON ──
{
  const timed = [look({ ov: { id: "a", startMs: 1500, endMs: 4200 } }), look({ ov: { id: "b" } }), look({ ov: { id: "c", text: "   " } }), look({ ov: { id: "d", kind: "caption" } })];
  const edit = textOverlaysToEditOverlays(timed, CAPS);
  eq("only text overlays with words; captions and empty text are skipped", edit.map((o) => o.id), ["a", "b"]);
  eq("start / end are the overlay's own window on the edited timeline", [edit[0].startMs, edit[0].endMs, edit[1].startMs, edit[1].endMs], [1500, 4200, undefined, undefined]);
  eq("no fade beyond the 1 ms the renderer needs to end a window", [edit[0].spec.fadeInMs, edit[0].spec.fadeOutMs], [1, 1]);
  const json = JSON.parse(toRenderJson({ version: 1, clips: [{ uri: "file:///a.mp4", trimStartMs: 0, trimEndMs: 8000 }], overlays: edit }, { supportsFont: true, supportsTextBox: true }));
  eq("the render JSON carries each text overlay's own complete style, untouched by the presets", json.overlays.map((o) => o.styleSpec), edit.map((o) => o.spec));
  ok("kind text, text and window survive", json.overlays[0].kind === "text" && json.overlays[0].text === "Hello" && json.overlays[0].startMs === 1500);
}

// ── 4. flag off, setting off, fonts ──
{
  const ovs = [look({ ov: { id: "a" } })];
  eq("flag off (a 1.0.4 build): no overlays", textOverlaysForSave({ supportsTextOverlays: false, includeText: true, overlays: ovs, fontNames: ALL_FONTS }), []);
  eq("setting off: no overlays", textOverlaysForSave({ supportsTextOverlays: true, includeText: false, overlays: ovs, fontNames: ALL_FONTS }), []);
  eq("flag on and setting on: the overlays", textOverlaysForSave({ supportsTextOverlays: true, includeText: true, overlays: ovs, fontNames: ALL_FONTS }).map((o) => o.id), ["a"]);
  eq("no text overlays: nothing to burn in", textOverlaysForSave({ supportsTextOverlays: true, includeText: true, overlays: [], fontNames: ALL_FONTS }), []);
  eq("a font the build does not embed falls back to Montserrat Bold", textOverlayExportSpec(look({ fontId: "anton" }), { fontNames: ["Montserrat-Bold"] }).fontName, "Montserrat-Bold");
  eq("no embedded fonts at all: the system font (no fontName)", "fontName" in textOverlayExportSpec(look({ fontId: "anton" }), { fontNames: [] }), false);
}

// ── 5. the native side reads what the JS sends; the screen and the build are wired ──
{
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  for (const key of ["xCenter", "rotation", "outlineColor", "outlineWidth", "textShadow", "lineBackground", "backgroundPaddingX", "backgroundPaddingY", "lineHeight", "maxWidth", "cornerRadius", "fontName", "backgroundColor", "fadeInMs", "fadeOutMs"]) {
    ok(`Swift reads styleSpec "${key}"`, swift.includes(`style["${key}"]`) || swift.includes(`"${key}"`));
  }
  ok("Swift reports supportsTextOverlays, supportsTextOutline and supportedFontNames", /"supportsTextOverlays": true/.test(swift) && /"supportsTextOutline": true/.test(swift) && /"supportedFontNames": availableBundledFontNames\(\)/.test(swift));
  ok("Swift registers the bundled fonts at runtime", swift.includes("CTFontManagerRegisterFontsForURL"));
  for (const f of TEXT_FONTS) ok(`Swift knows the PostScript name ${f.psName}`, swift.includes(`"${f.psName}"`));
  ok("the caption shadow path is unchanged", /style\["shadow"\] as\? Bool\) == true/.test(swift));
  const app = JSON.parse(read("../app.json"));
  const plugin = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font")[1].fonts.join("\n");
  for (const f of TEXT_FONTS) ok(`app.json embeds ${f.psName}`, plugin.includes(f.family.replace(/_(\d+)(\w+)$/, "_$1$2") + ".ttf"));
  for (const path of app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font")[1].fonts) ok(`font file exists: ${path}`, existsSync(new URL("../" + path, import.meta.url)));
  eq("app.json stays at 1.0.4", app.expo.version, "1.0.4");
  const idx = read("../modules/video-render/index.ts");
  ok("module exports supportsTextOverlays", /export const supportsTextOverlays: boolean = native\?\.supportsTextOverlays === true/.test(idx));
  const edit = read("../app/edit.tsx");
  ok("Post screen has the Include text in saved video switch, only where the build can draw it", /saveToRoll && supportsTextOverlays/.test(edit) && edit.includes("Include text in saved video"));
  ok("the choice is remembered per user", /setIncludeTextInSave\(v, user\?\.id\)/.test(edit) && /getIncludeTextInSave\(user\?\.id\)/.test(edit));
  ok("the posted video is not touched: text overlays still go to createPost as before", /textOverlays: overlaysForPost/.test(edit));
  const ex = read("../lib/exportEdit.ts");
  ok("with text the save renders from the clips and does not reuse the posted file", /text\.length > 0 \? null : args\.postedUri/.test(ex));
  const settings = read("../lib/autoEditSettings.ts");
  ok("the setting is on unless turned off", /!== "0"/.test(settings.slice(settings.indexOf("getIncludeTextInSave"))) && /catch \{\n    return true;/.test(settings.slice(settings.indexOf("getIncludeTextInSave"))));
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
