/**
 * Caption look presets: fonts, text colors and background colors the creator can pick (the "Style" sheet).
 * Edit this file to change what is offered; nothing else needs to change.
 *
 * Colors come from the one shared palette (lib/palette.ts), the same for text overlays: a caption stores the ids.
 * What is chosen is what is drawn: no color is ever switched for readability (a low contrast only raises a hint).
 *
 * Fonts are iOS built-in fonts, referenced by PostScript name (no bundled files), plus the bundled Google Fonts
 * (lib/fonts.ts). The native renderer opens them with UIFont(name:size:) and falls back to the system font when a name
 * is unavailable, so a wrong name can only ever show the default font. `trial` has no fontName: it is the system heavy
 * font the captions have always used. `classic` is Montserrat ExtraBold, bundled with the app (expo-font plugin in
 * app.json, from build 1.0.4). The fonts marked `requiresEmbedded` are only burned in by a build that reports their
 * PostScript name in VideoRender.supportedFontNames (1.0.5); other builds do not offer them and use the default font.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { PALETTE, TRANSLUCENT, TRIAL_RED, paletteById } from "../palette.ts";
import { TEXT_FONTS, TEXT_FONT_FAMILY, TEXT_FONT_NAME, familyOfPsName } from "../fonts.ts";

export { TRIAL_RED, TEXT_FONT_FAMILY, TEXT_FONT_NAME };

export type CaptionFontPreset = {
  id: string;
  label: string;
  /** iOS PostScript name, or null for the system font. */
  fontName: string | null;
  /** The name the font is registered under in JS (expo-font), for the editor preview. */
  jsFamily?: string;
  /** Rough width of its text relative to the system heavy font (only used to decide how many words fit a line). */
  widthFactor: number;
  /** Needs the build to embed the font file for the native renderer (see the header). */
  requiresEmbedded?: boolean;
};
export type CaptionColorPreset = { id: string; label: string; /** #RRGGBB (#RRGGBBAA for the semi-transparent ones), or null for "None" (no background). */ color: string | null };

export const CAPTION_FONTS: CaptionFontPreset[] = [
  // The fonts every 1.0.4 build can burn in:
  { id: "classic", label: "Classic", fontName: "Montserrat-ExtraBold", jsFamily: "Montserrat_800ExtraBold", widthFactor: 1.12 },
  { id: "trial", label: "Tryal", fontName: null, widthFactor: 1 },
  { id: "avenir", label: "Avenir", fontName: "AvenirNext-Heavy", widthFactor: 1.02 },
  { id: "futura", label: "Futura", fontName: "Futura-Bold", widthFactor: 0.98 },
  { id: "condensed", label: "Condensed", fontName: "HelveticaNeue-CondensedBlack", widthFactor: 0.78 },
  { id: "serif", label: "Serif", fontName: "Georgia-Bold", widthFactor: 1.06 },
  { id: "typewriter", label: "Typewriter", fontName: "AmericanTypewriter-Bold", widthFactor: 1.12 },
  // The Google Fonts of the text overlays: burned in once the build embeds them.
  ...TEXT_FONTS.filter((f) => f.id !== "montserrat").map((f): CaptionFontPreset => ({
    id: f.id,
    label: f.label,
    fontName: f.psName,
    jsFamily: f.family,
    widthFactor: f.widthFactor,
    requiresEmbedded: true,
  })),
];

/** Text colors: the shared palette, same order. */
export const CAPTION_TEXT_COLORS: CaptionColorPreset[] = PALETTE.map((c) => ({ id: c.id, label: c.label, color: c.hex }));

/** Background colors: the shared palette, the two semi-transparent ones, then "None". */
export const CAPTION_BACKGROUNDS: CaptionColorPreset[] = [
  ...PALETTE.map((c) => ({ id: c.id, label: c.label, color: c.hex })),
  ...TRANSLUCENT.map((c) => ({ id: c.id, label: c.label, color: c.hex })),
  { id: "none", label: "None", color: null },
];

/** Outline colors: the shared palette. */
export const CAPTION_OUTLINE_COLORS: CaptionColorPreset[] = CAPTION_TEXT_COLORS;

/** The font a caption has when no build can draw a bundled font (and always has had): the system heavy font. */
export const SYSTEM_FONT_ID = "trial";
/** The default font where the native module reports supportsCaptionFont (build 1.0.4 on). */
export const CLASSIC_FONT_ID = "classic";
/** The default caption font once the build embeds TikTok Sans (and the same font as the default of text overlays). */
export const TIKTOK_FONT_ID = "tiktok-sans";

/** The PostScript names of the fonts a build embeds for the renderer (VideoRender.supportedFontNames); [] on 1.0.4. */
export type EmbeddedFonts = readonly string[];

/**
 * The caption default font: TikTok Sans where the build embeds it, else Montserrat ExtraBold where the build can draw a
 * bundled font at all, else the system font.
 */
export const defaultFontId = (supportsFont: boolean, embedded: EmbeddedFonts = []): string => {
  const tiktok = CAPTION_FONTS.find((f) => f.id === TIKTOK_FONT_ID);
  if (tiktok?.fontName && embedded.includes(tiktok.fontName)) return TIKTOK_FONT_ID;
  return supportsFont ? CLASSIC_FONT_ID : SYSTEM_FONT_ID;
};

/** True when this build can burn the font in (system and 1.0.4 fonts always; the Google Fonts once embedded). */
export function captionFontAvailable(font: CaptionFontPreset, embedded: EmbeddedFonts = []): boolean {
  return !font.requiresEmbedded || (font.fontName !== null && embedded.includes(font.fontName));
}

/** The fonts the caption sheet offers on this build. */
export function availableCaptionFonts(supportsFont: boolean, embedded: EmbeddedFonts = []): CaptionFontPreset[] {
  if (!supportsFont) return [];
  return CAPTION_FONTS.filter((f) => captionFontAvailable(f, embedded));
}

/** The default font of text overlays and captions: Montserrat Bold was the old default. */
export const DEFAULT_CAPTION_LOOK = { fontId: SYSTEM_FONT_ID, textColor: "white", backgroundColor: "black" };

/** The family to draw a PostScript font name with in JS: the registered family, else the name itself. */
export function previewFontFamily(fontName: string): string {
  const fromTable = familyOfPsName(fontName);
  if (fromTable) return fromTable;
  return CAPTION_FONTS.find((f) => f.fontName === fontName)?.jsFamily ?? fontName;
}

/**
 * Below this contrast ratio (WCAG) the sheet shows a small hint. It is only ever a hint: the colors the creator picked
 * are the colors drawn, rendered and posted.
 */
export const MIN_CONTRAST = 3;

/** A soft dark shadow (the renderer's own shadow option) goes behind text that has no background. */
export const NO_BACKGROUND_ID = "none";

export type CaptionOutline = "thin" | "medium" | "thick";
/** How far the outline reaches beyond the letters, as a fraction of the font size (the same numbers as text overlays). */
export const CAPTION_OUTLINE_EM: Record<CaptionOutline, number> = { thin: 0.035, medium: 0.065, thick: 0.1 };

export type CaptionLookInput = {
  fontId?: string;
  textColor?: string;
  backgroundColor?: string;
  uppercase?: boolean;
  /** Drop shadow behind the text (or the box). Absent = the old rule: on when there is no background. */
  shadow?: boolean;
  /** Outline thickness; absent = no outline. */
  outline?: CaptionOutline;
  /** Outline color (palette id); absent = black. */
  outlineColor?: string;
};

export type ResolvedLook = {
  fontId: string;
  /** null = the system heavy font. */
  fontName: string | null;
  widthFactor: number;
  textColorId: string;
  backgroundColorId: string;
  /** The text color exactly as chosen (#RRGGBB). */
  textHex: string;
  /** null = no background. #RRGGBB, or #RRGGBBAA for the semi-transparent ones. */
  backgroundHex: string | null;
  shadow: boolean;
  /** ALL CAPS was chosen (the default is the transcript's own casing). */
  uppercase: boolean;
  /** null = no outline. */
  outline: { size: CaptionOutline; em: number; colorId: string; hex: string } | null;
  /** The chosen text and background are hard to tell apart (a hint for the sheet; nothing is changed). */
  lowContrast: boolean;
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
  return CAPTION_FONTS.find((f) => f.id === fontId) ?? CAPTION_FONTS.find((f) => f.id === SYSTEM_FONT_ID)!;
}

/** Unknown or missing ids give the Trial look. Colors are used exactly as chosen. */
export function resolveCaptionLook(look: CaptionLookInput | null | undefined): ResolvedLook {
  const font = fontPreset(look?.fontId);
  const text = CAPTION_TEXT_COLORS.find((c) => c.id === look?.textColor) ?? CAPTION_TEXT_COLORS[0]!;
  const bg = CAPTION_BACKGROUNDS.find((c) => c.id === look?.backgroundColor) ?? CAPTION_BACKGROUNDS.find((c) => c.id === "black")!;
  const textHex = text.color!;
  // the background colour under the text, for the hint: a semi-transparent one counts as its colour
  const bgSolid = bg.color === null ? null : `#${bg.color.slice(1, 7)}`;
  const outlineColor = paletteById(look?.outlineColor) ?? paletteById("black")!;
  const size = look?.outline;
  return {
    fontId: font.id,
    fontName: font.fontName,
    widthFactor: font.widthFactor,
    textColorId: text.id,
    backgroundColorId: bg.id,
    textHex,
    backgroundHex: bg.color,
    shadow: look?.shadow === undefined ? bg.color === null : look.shadow === true,
    uppercase: look?.uppercase === true,
    outline: size && CAPTION_OUTLINE_EM[size] !== undefined ? { size, em: CAPTION_OUTLINE_EM[size], colorId: outlineColor.id, hex: outlineColor.hex } : null,
    lowContrast: bgSolid !== null && bg.color!.length === 7 && contrastRatio(textHex, bgSolid) < MIN_CONTRAST,
  };
}

/** The width factor for a font's PostScript name (1 for the system font or an unknown name). */
export function fontWidthFactor(fontName: string | undefined): number {
  return CAPTION_FONTS.find((f) => f.fontName === fontName && fontName)?.widthFactor ?? 1;
}
