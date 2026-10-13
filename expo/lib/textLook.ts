/**
 * The look of a Text-button overlay as data: its font, text color, and three independent switches with their own
 * colors: an OUTLINE (color, thin / medium / thick), a SHADOW, and a BACKGROUND box that hugs each line (color). Text
 * color, outline color and background color are independent of each other and all come from the one shared palette
 * (lib/palette.ts). Stored on the overlay itself (the existing text_overlays JSON, no new columns), so drafts, undo
 * and the feed all carry it. Pure; erasable TypeScript only so the Node tests can run it.
 *
 * Text-button overlays are drawn live (editor, Preview, feed) from this data; they are never burned into the posted
 * video. Only captions are burned in, with their own look (lib/transcription/captionPresets.ts). The mapping to the
 * native renderer's style numbers is overlayRenderStyle in lib/editStyles.ts, ready for the day they are burned in.
 *
 * Three generations of stored overlays are understood:
 *   1. no look fields: the first Text button; its `backgroundStyle` preset gives the colors (drawn as it always was);
 *   2. `look` "outline" | "box" | "plain" (one style at a time);
 *   3. `outline` / `shadow` / `background` switches with `outlineColor` / `bgColor` (this file's writer).
 *
 * Fonts (lib/fonts.ts) are loaded at run time; one that is not loaded (an older app version, a failed load) falls back to
 * Montserrat Bold, the text overlays' previous font.
 */
import { contrastRatio } from "./transcription/captionPresets.ts";
import { PALETTE, TRIAL_RED, splitHex } from "./palette.ts";
import {
  DEFAULT_TEXT_FONT_ID,
  LEGACY_TEXT_FONT_ID,
  TEXT_FONTS,
  TEXT_FONT_FAMILY,
  TEXT_FONT_NAME,
  textFont,
  type TextFont,
} from "./fonts.ts";

export { DEFAULT_TEXT_FONT_ID, LEGACY_TEXT_FONT_ID, TEXT_FONTS, textFont };
export type { TextFont };
export { PALETTE as TEXT_COLORS };

export type StrokeSize = "thin" | "medium" | "thick";
export const STROKE_SIZES: StrokeSize[] = ["thin", "medium", "thick"];

/** How far the outline reaches beyond the letters, as a fraction of the font size. */
export const STROKE_EM: Record<StrokeSize, number> = { thin: 0.035, medium: 0.065, thick: 0.1 };

/** The font size (before pinch) of a new text: a little bigger than the old default of 26. */
export const NEW_TEXT_FONT_SIZE = 30;

/** The fields of an overlay that make its look. All optional on the stored overlay: absent = an older look. */
export type TextAppearance = {
  fontId?: string;
  /** Text color, #RRGGBB. */
  color?: string;
  outline?: boolean;
  /** Outline color, #RRGGBB. */
  outlineColor?: string;
  stroke?: StrokeSize;
  shadow?: boolean;
  /** The hugging box behind each line. */
  background?: boolean;
  /** Background color, #RRGGBB or #RRGGBBAA (the semi-transparent palette entries). */
  bgColor?: string;
  /** Generation 2 only (read, never written): one style at a time. */
  look?: "outline" | "box" | "plain";
};

export type EditorAppearance = Required<Omit<TextAppearance, "look">>;

/** What a new text starts as: TikTok Sans, white, a thin black outline, a soft shadow, no background. */
export const NEW_TEXT_APPEARANCE: EditorAppearance = {
  fontId: DEFAULT_TEXT_FONT_ID,
  color: "#FFFFFF",
  outline: true,
  outlineColor: "#000000",
  stroke: "thin",
  shadow: true,
  background: false,
  bgColor: "#000000",
};

/** The older background presets some stored overlays still have. */
export type LegacyBackground = "none-white" | "none-black" | "white-box" | "black-box" | "accent-box" | "translucent-box";

/** The slice of an overlay the look reads. */
export type LookSource = TextAppearance & { backgroundStyle?: LegacyBackground | string };

const isHex6 = (v: string | undefined): v is string => /^#[0-9a-fA-F]{6}$/.test(v ?? "");

/**
 * The JS font family to draw with. `isLoaded` says whether a family is registered (expo-font's Font.isLoaded): a font
 * that is not loaded gives Montserrat Bold, so the text is never drawn in some arbitrary system face.
 */
export function textFontFamily(fontId: string | undefined, isLoaded: (family: string) => boolean = () => true): string {
  const font = textFont(fontId);
  if (!font) return TEXT_FONT_FAMILY;
  return isLoaded(font.family) ? font.family : TEXT_FONT_FAMILY;
}

/**
 * The font name a native renderer would burn in: the font's PostScript name only if that build embeds it
 * (`embeddedPsNames` = VideoRender.supportedFontNames, which only a 1.0.5 build reports), else Montserrat Bold.
 */
export function burnedFontName(fontId: string | undefined, embeddedPsNames: readonly string[] = []): string {
  const font = textFont(fontId);
  return font && embeddedPsNames.includes(font.psName) ? font.psName : TEXT_FONT_NAME;
}

function legacyLook(bg: string | undefined): { background: boolean; fill: string; box: string | null; shadow: boolean; opacity: number } {
  switch (bg) {
    case "none-black":
      return { background: false, fill: "#000000", box: null, shadow: true, opacity: 1 };
    case "white-box":
      return { background: true, fill: "#000000", box: "#FFFFFF", shadow: false, opacity: 1 };
    case "black-box":
      return { background: true, fill: "#FFFFFF", box: "#000000", shadow: false, opacity: 1 };
    case "accent-box":
      return { background: true, fill: "#FFFFFF", box: "", shadow: false, opacity: 1 }; // the overlay's own color, resolved below
    case "translucent-box":
      return { background: true, fill: "#FFFFFF", box: "#000000", shadow: false, opacity: 0.55 };
    default:
      return { background: false, fill: "#FFFFFF", box: null, shadow: true, opacity: 1 };
  }
}

/** Readable text on a colored box: black on light boxes, white on dark ones (only used to translate generation 2). */
export function textOnColor(boxHex: string): "#000000" | "#FFFFFF" {
  return contrastRatio("#000000", boxHex) >= contrastRatio("#FFFFFF", boxHex) ? "#000000" : "#FFFFFF";
}

export type ResolvedAppearance = {
  fontId: string;
  /** The first Text button's look (no look fields): drawn exactly as before. */
  legacy: boolean;
  /** Text fill, exactly as chosen. */
  textColor: string;
  /** The box color (#RRGGBB) when the background is on, else null; with its opacity. */
  boxColor: string | null;
  boxOpacity: number;
  /** The outline when on, else null. `reach` is how far it extends beyond the letters, in em. */
  stroke: { color: string; em: number } | null;
  shadow: boolean;
};

function fontOf(ov: LookSource): string {
  return textFont(ov.fontId) ? (ov.fontId as string) : LEGACY_TEXT_FONT_ID;
}

/** Generation 2 (one style at a time) as generation 3 switches. */
function fromLook(ov: LookSource): EditorAppearance {
  const color = isHex6(ov.color) ? ov.color.toUpperCase() : "#FFFFFF";
  const size: StrokeSize = STROKE_SIZES.includes(ov.stroke as StrokeSize) ? (ov.stroke as StrokeSize) : "thick";
  const shadow = ov.shadow !== false;
  const fontId = fontOf(ov);
  if (ov.look === "box") {
    return { fontId, color: textOnColor(color), outline: false, outlineColor: "#000000", stroke: size, shadow: false, background: true, bgColor: color };
  }
  if (ov.look === "plain") {
    return { fontId, color, outline: false, outlineColor: "#000000", stroke: size, shadow, background: false, bgColor: "#000000" };
  }
  return { fontId, color, outline: true, outlineColor: contrastRatio("#000000", color) < 3 ? "#FFFFFF" : "#000000", stroke: size, shadow, background: false, bgColor: "#000000" };
}

/** True for an overlay written by this file (generation 3). */
function isCurrent(ov: LookSource): boolean {
  return ov.outline !== undefined || ov.background !== undefined || ov.bgColor !== undefined || ov.outlineColor !== undefined;
}

/**
 * Everything the editor, Preview and the feed need to draw an overlay. What was chosen is what is drawn: the text color
 * is never changed for contrast, and the three colors never depend on each other.
 */
export function resolveAppearance(ov: LookSource): ResolvedAppearance {
  const fontId = fontOf(ov);
  if (!ov.look && !isCurrent(ov)) {
    const old = legacyLook(ov.backgroundStyle);
    const boxColor = old.box === null ? null : old.box || (isHex6(ov.color) ? ov.color : TRIAL_RED);
    return { fontId, legacy: true, textColor: old.fill, boxColor, boxOpacity: old.opacity, stroke: null, shadow: old.shadow };
  }
  const a = isCurrent(ov) ? editorStateOf(ov) : fromLook(ov);
  const box = a.background ? splitHex(a.bgColor) : null;
  return {
    fontId,
    legacy: false,
    textColor: a.color,
    boxColor: box ? box.rgb : null,
    boxOpacity: box ? box.alpha : 1,
    stroke: a.outline ? { color: a.outlineColor, em: STROKE_EM[a.stroke] } : null,
    shadow: a.shadow,
  };
}

/** The editor's starting state for an overlay: a new text, or the look an existing one has now. */
export function editorStateOf(ov: LookSource | null | undefined): EditorAppearance {
  if (!ov) return { ...NEW_TEXT_APPEARANCE };
  if (!ov.look && !isCurrent(ov)) {
    const old = legacyLook(ov.backgroundStyle);
    const boxColor = old.box === null ? null : old.box || (isHex6(ov.color) ? ov.color : TRIAL_RED);
    return {
      fontId: fontOf(ov),
      color: old.fill,
      outline: false,
      outlineColor: "#000000",
      stroke: "medium",
      shadow: old.shadow,
      background: boxColor !== null,
      bgColor: boxColor ? (old.opacity < 1 ? `${boxColor.toUpperCase()}${Math.round(old.opacity * 255).toString(16).padStart(2, "0").toUpperCase()}` : boxColor.toUpperCase()) : "#000000",
    };
  }
  if (!isCurrent(ov)) return fromLook(ov);
  const bg = splitHex(ov.bgColor);
  return {
    fontId: fontOf(ov),
    color: isHex6(ov.color) ? ov.color.toUpperCase() : "#FFFFFF",
    outline: ov.outline === true,
    outlineColor: isHex6(ov.outlineColor) ? ov.outlineColor.toUpperCase() : "#000000",
    stroke: STROKE_SIZES.includes(ov.stroke as StrokeSize) ? (ov.stroke as StrokeSize) : "thin",
    shadow: ov.shadow !== false,
    background: ov.background === true,
    bgColor: bg ? `${bg.rgb}${ov.bgColor && ov.bgColor.length === 9 ? ov.bgColor.slice(7, 9).toUpperCase() : ""}` : "#000000",
  };
}

/** The stored fields for a look chosen in the editor (merged into the overlay; the old `look` is cleared). */
export function appearancePatch(state: EditorAppearance): EditorAppearance & { look: undefined } {
  return {
    fontId: state.fontId,
    color: state.color,
    outline: state.outline,
    outlineColor: state.outlineColor,
    stroke: state.stroke,
    shadow: state.shadow,
    background: state.background,
    bgColor: state.bgColor,
    look: undefined,
  };
}

/** "#RRGGBB" typed or picked: normalised, or null when it is not a color. */
export function parseHexColor(input: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(input.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

/**
 * Done in the text editor, as data: an existing overlay gets the new text and look (everything else about it stays);
 * a new text is added with the defaults for position and size. The caller takes one undo snapshot first.
 */
export function applyTextEdit<O extends TextAppearance & { id: string; text: string }>(
  overlays: O[],
  editingId: string | null,
  text: string,
  appearance: EditorAppearance,
  makeNew: () => O,
): { overlays: O[]; created: O | null } {
  const patch = appearancePatch(appearance);
  if (editingId && overlays.some((o) => o.id === editingId)) {
    return { overlays: overlays.map((o) => (o.id === editingId ? { ...o, text, ...patch } : o)), created: null };
  }
  const created = { ...makeNew(), text, ...patch };
  return { overlays: [...overlays, created], created };
}

/** The legacy "cycle the style" of a selected text: generation 3 cycles outline -> background -> shadow only. */
export function cycleLook(a: EditorAppearance): EditorAppearance {
  if (a.outline && !a.background) return { ...a, outline: false, background: true };
  if (a.background && !a.outline) return { ...a, background: false, outline: false, shadow: true };
  if (!a.outline && !a.background) return { ...a, outline: true };
  return { ...a, outline: false, background: false, shadow: true };
}
