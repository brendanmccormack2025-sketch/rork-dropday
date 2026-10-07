/**
 * Caption look presets: fonts, text colors and background colors the creator can pick (the "Style" sheet).
 * Edit this file to change what is offered; nothing else needs to change.
 *
 * Fonts are iOS built-in fonts, referenced by PostScript name (no bundled files). The native renderer opens
 * them with UIFont(name:size:) and falls back to the system font when a name is unavailable, so a wrong
 * name can only ever show the default font. `trial` has no fontName: it is the system heavy font the
 * captions have always used.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type CaptionFontPreset = {
  id: string;
  label: string;
  /** iOS PostScript name, or null for the system font (the default). */
  fontName: string | null;
  /** Rough width of its text relative to the system heavy font (only used to decide how many words fit a line). */
  widthFactor: number;
};
export type CaptionColorPreset = { id: string; label: string; /** #RRGGBB, or null for "None" (no background). */ color: string | null };

/** "Trial red" is the app's accent (constants/theme.ts). */
export const TRIAL_RED = "#E8291C";

export const CAPTION_FONTS: CaptionFontPreset[] = [
  { id: "trial", label: "Trial", fontName: null, widthFactor: 1 },
  { id: "avenir", label: "Avenir", fontName: "AvenirNext-Heavy", widthFactor: 1.02 },
  { id: "futura", label: "Futura", fontName: "Futura-Bold", widthFactor: 0.98 },
  { id: "condensed", label: "Condensed", fontName: "HelveticaNeue-CondensedBlack", widthFactor: 0.78 },
  { id: "serif", label: "Serif", fontName: "Georgia-Bold", widthFactor: 1.06 },
  { id: "typewriter", label: "Typewriter", fontName: "AmericanTypewriter-Bold", widthFactor: 1.12 },
];

export const CAPTION_TEXT_COLORS: CaptionColorPreset[] = [
  { id: "white", label: "White", color: "#FFFFFF" },
  { id: "black", label: "Black", color: "#000000" },
  { id: "yellow", label: "Yellow", color: "#FFD400" },
  { id: "red", label: "Trial red", color: TRIAL_RED },
  { id: "blue", label: "Blue", color: "#1E5BFF" },
];

export const CAPTION_BACKGROUNDS: CaptionColorPreset[] = [
  { id: "black", label: "Black", color: "#000000" },
  { id: "white", label: "White", color: "#FFFFFF" },
  { id: "none", label: "None", color: null },
  { id: "red", label: "Trial red", color: TRIAL_RED },
  { id: "yellow", label: "Yellow", color: "#FFD400" },
  { id: "blue", label: "Blue", color: "#1E5BFF" },
];

/** The Trial look: what a caption is when nothing was chosen. */
export const DEFAULT_CAPTION_LOOK = { fontId: "trial", textColor: "white", backgroundColor: "black" };

/** The least contrast (WCAG ratio) between text and background before the text color is switched. */
export const MIN_CONTRAST = 3;

/** A soft dark shadow (the renderer's own shadow option) goes behind text that has no background. */
export const NO_BACKGROUND_ID = "none";

export type CaptionLookInput = { fontId?: string; textColor?: string; backgroundColor?: string };

export type ResolvedLook = {
  fontId: string;
  /** null = the system heavy font. */
  fontName: string | null;
  widthFactor: number;
  textColorId: string;
  backgroundColorId: string;
  /** The text color actually drawn (#RRGGBB), after the readability check. */
  textHex: string;
  /** null = no background. */
  backgroundHex: string | null;
  shadow: boolean;
  /** The chosen text color was switched to white or black because it could not be read on the background. */
  adjusted: boolean;
};

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of #RRGGBB. */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21) of two #RRGGBB colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function fontPreset(fontId?: string): CaptionFontPreset {
  return CAPTION_FONTS.find((f) => f.id === fontId) ?? CAPTION_FONTS[0]!;
}

/** Unknown or missing ids give the Trial look; contrast under MIN_CONTRAST switches the text to white or black. */
export function resolveCaptionLook(look: CaptionLookInput | null | undefined): ResolvedLook {
  const font = fontPreset(look?.fontId);
  const text = CAPTION_TEXT_COLORS.find((c) => c.id === look?.textColor) ?? CAPTION_TEXT_COLORS[0]!;
  const bg = CAPTION_BACKGROUNDS.find((c) => c.id === look?.backgroundColor) ?? CAPTION_BACKGROUNDS[0]!;
  let textHex = text.color!;
  let adjusted = false;
  if (bg.color !== null && contrastRatio(textHex, bg.color) < MIN_CONTRAST) {
    const white = contrastRatio("#FFFFFF", bg.color);
    const black = contrastRatio("#000000", bg.color);
    textHex = white >= black ? "#FFFFFF" : "#000000";
    adjusted = true;
  }
  return {
    fontId: font.id,
    fontName: font.fontName,
    widthFactor: font.widthFactor,
    textColorId: text.id,
    backgroundColorId: bg.id,
    textHex,
    backgroundHex: bg.color,
    shadow: bg.color === null,
    adjusted,
  };
}

/** The width factor for a font's PostScript name (1 for the system font or an unknown name). */
export function fontWidthFactor(fontName: string | undefined): number {
  return CAPTION_FONTS.find((f) => f.fontName === fontName && fontName)?.widthFactor ?? 1;
}
