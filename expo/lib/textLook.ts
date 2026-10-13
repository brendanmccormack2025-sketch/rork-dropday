/**
 * The look of a Text-button overlay as data: its font, fill color, style (outline / box / plain), outline thickness and
 * shadow. Stored on the overlay itself (the existing text_overlays JSON, no new columns), so drafts, undo and the feed
 * all carry it. Pure; erasable TypeScript only so the Node tests can run it.
 *
 * Text-button overlays are drawn live (editor, Preview, feed) from this data; they are never burned into the posted
 * video. Only captions are burned in, with their own fonts (lib/transcription/captionPresets.ts).
 *
 * Fonts are Google Fonts under the SIL Open Font License, one weight each, loaded with expo-font at run time
 * (app/_layout.tsx): loading a font file needs no new native build. A font that is not loaded (an older app version, a
 * failed load) falls back to Montserrat Bold, the text overlays' previous font.
 */
import { TEXT_FONT_FAMILY, TEXT_FONT_NAME, TRIAL_RED, contrastRatio } from "./transcription/captionPresets.ts";

export type TextLook = "outline" | "box" | "plain";
export type StrokeSize = "thin" | "medium" | "thick";

export type TextFont = {
  id: string;
  label: string;
  /** The family name it is registered under in JS (expo-font), used for the preview and the feed. */
  family: string;
  /** iOS PostScript name, for a native renderer that can open it (not used while text overlays are not burned in). */
  psName: string;
};

/** The offered fonts, in the order of the chips. One weight each. */
export const TEXT_FONTS: TextFont[] = [
  { id: "anton", label: "Anton", family: "Anton_400Regular", psName: "Anton-Regular" },
  { id: "archivo-black", label: "Archivo Black", family: "ArchivoBlack_400Regular", psName: "ArchivoBlack-Regular" },
  { id: "montserrat", label: "Montserrat", family: TEXT_FONT_FAMILY, psName: TEXT_FONT_NAME },
  { id: "poppins", label: "Poppins", family: "Poppins_600SemiBold", psName: "Poppins-SemiBold" },
  { id: "marker", label: "Marker", family: "PermanentMarker_400Regular", psName: "PermanentMarker-Regular" },
  { id: "caveat", label: "Caveat", family: "Caveat_700Bold", psName: "Caveat-Bold" },
  { id: "dm-serif", label: "DM Serif", family: "DMSerifDisplay_400Regular", psName: "DMSerifDisplay-Regular" },
  { id: "space-grotesk", label: "Space Grotesk", family: "SpaceGrotesk_700Bold", psName: "SpaceGrotesk-Bold" },
];

/** The font size (before pinch) of a new text: Anton is a tall, narrow face, so a little bigger than the old default of 26. */
export const NEW_TEXT_FONT_SIZE = 30;

/** The font of every new text. */
export const DEFAULT_TEXT_FONT_ID = "anton";
/** The font of a text made before fonts could be chosen (and the fallback for anything unknown or not loaded). */
export const LEGACY_TEXT_FONT_ID = "montserrat";

export const TEXT_COLORS: Array<{ id: string; label: string; hex: string }> = [
  { id: "white", label: "White", hex: "#FFFFFF" },
  { id: "black", label: "Black", hex: "#000000" },
  { id: "red", label: "Trial red", hex: TRIAL_RED },
  { id: "yellow", label: "Yellow", hex: "#FFD400" },
  { id: "blue", label: "Blue", hex: "#1E5BFF" },
  { id: "green", label: "Green", hex: "#1FC45A" },
  { id: "pink", label: "Pink", hex: "#FF5FA8" },
];

/** The second row of colors, shown by the rainbow button next to the main ones. */
export const EXTRA_TEXT_COLORS: Array<{ id: string; label: string; hex: string }> = [
  { id: "orange", label: "Orange", hex: "#FF8A1F" },
  { id: "lime", label: "Lime", hex: "#B7F21F" },
  { id: "mint", label: "Mint", hex: "#2EE6B6" },
  { id: "cyan", label: "Cyan", hex: "#18D5FF" },
  { id: "sky", label: "Sky", hex: "#7CB8FF" },
  { id: "purple", label: "Purple", hex: "#8B5CF6" },
  { id: "magenta", label: "Magenta", hex: "#E536C8" },
  { id: "peach", label: "Peach", hex: "#FFC7A8" },
  { id: "cream", label: "Cream", hex: "#F5F3EE" },
  { id: "grey", label: "Grey", hex: "#9A9A9A" },
  { id: "navy", label: "Navy", hex: "#10265C" },
  { id: "brown", label: "Brown", hex: "#6B3F1D" },
];

export const TEXT_LOOKS: TextLook[] = ["outline", "box", "plain"];
export const STROKE_SIZES: StrokeSize[] = ["thin", "medium", "thick"];

/** How far the outline reaches beyond the letters, as a fraction of the font size. */
export const STROKE_EM: Record<StrokeSize, number> = { thin: 0.035, medium: 0.065, thick: 0.1 };

/** The fields of an overlay that make its look. All optional on the stored overlay: absent = the older look. */
export type TextAppearance = {
  fontId?: string;
  color?: string;
  look?: TextLook;
  stroke?: StrokeSize;
  shadow?: boolean;
};

/** What a new text starts as: Anton, white, thick black outline, soft shadow, no box. */
export const NEW_TEXT_APPEARANCE: Required<TextAppearance> = {
  fontId: DEFAULT_TEXT_FONT_ID,
  color: "#FFFFFF",
  look: "outline",
  stroke: "thick",
  shadow: true,
};

/** The older background presets some stored overlays still have. */
export type LegacyBackground = "none-white" | "none-black" | "white-box" | "black-box" | "accent-box" | "translucent-box";

/** The slice of an overlay the look reads. */
export type LookSource = TextAppearance & { backgroundStyle?: LegacyBackground | string; color?: string };

export function textFont(fontId: string | undefined): TextFont | null {
  return TEXT_FONTS.find((f) => f.id === fontId) ?? null;
}

/**
 * The JS font family to draw with. `isLoaded` says whether a family is registered (expo-font's Font.isLoaded): a font that
 * is not loaded gives Montserrat Bold, so the text is never drawn in some arbitrary system face.
 */
export function textFontFamily(fontId: string | undefined, isLoaded: (family: string) => boolean = () => true): string {
  const font = textFont(fontId);
  if (!font) return TEXT_FONT_FAMILY;
  return isLoaded(font.family) ? font.family : TEXT_FONT_FAMILY;
}

/**
 * The font name a native renderer would burn in: the font's PostScript name only if that build embeds it
 * (`embeddedPsNames` from a capability the native module does not have yet), else Montserrat Bold.
 */
export function burnedFontName(fontId: string | undefined, embeddedPsNames: string[] = []): string {
  const font = textFont(fontId);
  return font && embeddedPsNames.includes(font.psName) ? font.psName : TEXT_FONT_NAME;
}

function legacyLook(bg: string | undefined): { look: TextLook; fill: string; box: string | null; shadow: boolean; opacity: number } {
  switch (bg) {
    case "none-black":
      return { look: "plain", fill: "#000000", box: null, shadow: true, opacity: 1 };
    case "white-box":
      return { look: "box", fill: "#000000", box: "#FFFFFF", shadow: false, opacity: 1 };
    case "black-box":
      return { look: "box", fill: "#FFFFFF", box: "#000000", shadow: false, opacity: 1 };
    case "accent-box":
      return { look: "box", fill: "#FFFFFF", box: "", shadow: false, opacity: 1 };   // the overlay's own color, resolved below
    case "translucent-box":
      return { look: "box", fill: "#FFFFFF", box: "#000000", shadow: false, opacity: 0.55 };
    default:
      return { look: "plain", fill: "#FFFFFF", box: null, shadow: true, opacity: 1 };
  }
}

/** Readable text on a colored box: black on light boxes, white on dark ones. */
export function textOnColor(boxHex: string): "#000000" | "#FFFFFF" {
  return contrastRatio("#000000", boxHex) >= contrastRatio("#FFFFFF", boxHex) ? "#000000" : "#FFFFFF";
}

/** The outline color: black, or white around very dark text (black text would vanish into its own outline). */
export function strokeColorFor(fillHex: string): "#000000" | "#FFFFFF" {
  return contrastRatio("#000000", fillHex) < 3 ? "#FFFFFF" : "#000000";
}

export type ResolvedAppearance = {
  fontId: string;
  /** The older look (no `look` stored): drawn exactly as before. */
  legacy: boolean;
  look: TextLook;
  /** Text fill. */
  textColor: string;
  /** Box color (look "box"), else null. */
  boxColor: string | null;
  boxOpacity: number;
  /** Outline (look "outline"), else null. width = how far it reaches beyond the letters, in em. */
  stroke: { color: string; em: number } | null;
  shadow: boolean;
};

/**
 * Everything the editor, Preview and the feed need to draw an overlay. An overlay with no `look` is an older one: its
 * background preset gives the same colors and shadow it always had (and its font is Montserrat unless one was chosen).
 */
export function resolveAppearance(ov: LookSource): ResolvedAppearance {
  const fontId = textFont(ov.fontId) ? (ov.fontId as string) : LEGACY_TEXT_FONT_ID;
  if (!ov.look) {
    const old = legacyLook(ov.backgroundStyle);
    const boxColor = old.box === null ? null : old.box || (ov.color ?? TRIAL_RED);
    return { fontId, legacy: true, look: old.look, textColor: old.fill, boxColor, boxOpacity: old.opacity, stroke: null, shadow: old.shadow };
  }
  const color = /^#[0-9a-fA-F]{6}$/.test(ov.color ?? "") ? (ov.color as string) : "#FFFFFF";
  const look: TextLook = TEXT_LOOKS.includes(ov.look) ? ov.look : "outline";
  const shadow = ov.shadow !== false;
  if (look === "box") {
    return { fontId, legacy: false, look, textColor: textOnColor(color), boxColor: color, boxOpacity: 1, stroke: null, shadow: false };
  }
  const size: StrokeSize = STROKE_SIZES.includes(ov.stroke as StrokeSize) ? (ov.stroke as StrokeSize) : "thick";
  return {
    fontId,
    legacy: false,
    look,
    textColor: color,
    boxColor: null,
    boxOpacity: 1,
    stroke: look === "outline" ? { color: strokeColorFor(color), em: STROKE_EM[size] } : null,
    shadow,
  };
}

/** The editor's starting state for an overlay: a new text, or the look an existing one has now. */
export function editorStateOf(ov: LookSource | null | undefined): Required<TextAppearance> {
  if (!ov) return { ...NEW_TEXT_APPEARANCE };
  if (!ov.look) {
    const r = resolveAppearance(ov);
    return {
      fontId: r.fontId,
      color: r.look === "box" ? (r.boxColor as string) : r.textColor,
      look: r.look,
      stroke: "medium",
      shadow: r.shadow,
    };
  }
  return {
    fontId: textFont(ov.fontId) ? (ov.fontId as string) : LEGACY_TEXT_FONT_ID,
    color: /^#[0-9a-fA-F]{6}$/.test(ov.color ?? "") ? (ov.color as string) : "#FFFFFF",
    look: TEXT_LOOKS.includes(ov.look) ? ov.look : "outline",
    stroke: STROKE_SIZES.includes(ov.stroke as StrokeSize) ? (ov.stroke as StrokeSize) : "thick",
    shadow: ov.shadow !== false,
  };
}

/** outline -> box -> plain -> outline. */
export function nextLook(look: TextLook): TextLook {
  return TEXT_LOOKS[(TEXT_LOOKS.indexOf(look) + 1) % TEXT_LOOKS.length]!;
}

/** The stored fields for a look chosen in the editor (a plain object, merged into the overlay). */
export function appearancePatch(state: Required<TextAppearance>): Required<TextAppearance> {
  return { fontId: state.fontId, color: state.color, look: state.look, stroke: state.stroke, shadow: state.shadow };
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
  appearance: Required<TextAppearance>,
  makeNew: () => O,
): { overlays: O[]; created: O | null } {
  const patch = appearancePatch(appearance);
  if (editingId && overlays.some((o) => o.id === editingId)) {
    return { overlays: overlays.map((o) => (o.id === editingId ? { ...o, text, ...patch } : o)), created: null };
  }
  const created = { ...makeNew(), text, ...patch };
  return { overlays: [...overlays, created], created };
}
