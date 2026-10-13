/**
 * The text fonts, one table for text overlays and captions. Google Fonts under the SIL Open Font License, one weight
 * each, loaded at run time with expo-font (app/_layout.tsx) for everything drawn in JS: the editor, Preview and the
 * feed. A font drawn into the video by the native renderer (captions) must also be embedded in the app build
 * (expo-font plugin in app.json) so UIFont(name:) finds its PostScript name: only builds that say so
 * (VideoRender.supportedFontNames) burn these fonts in; until then a caption falls back to its default font.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type TextFont = {
  id: string;
  label: string;
  /** The family name it is registered under in JS (expo-font), used for the preview and the feed. */
  family: string;
  /** iOS PostScript name: what the native renderer opens with UIFont(name:). */
  psName: string;
  /** Rough width of its text relative to the system heavy font (captions use it to decide how many words fit a line). */
  widthFactor: number;
};

/** Montserrat Bold, the previous font of text overlays (PostScript name for the renderer, family name for JS). */
export const TEXT_FONT_NAME = "Montserrat-Bold";
export const TEXT_FONT_FAMILY = "Montserrat_700Bold";

/** The offered fonts, in the order of the chips. */
export const TEXT_FONTS: TextFont[] = [
  { id: "tiktok-sans", label: "TikTok Sans", family: "TikTokSans_700Bold", psName: "TikTokSans-Bold", widthFactor: 1.04 },
  { id: "anton", label: "Anton", family: "Anton_400Regular", psName: "Anton-Regular", widthFactor: 0.72 },
  { id: "archivo-black", label: "Archivo Black", family: "ArchivoBlack_400Regular", psName: "ArchivoBlack-Regular", widthFactor: 1.12 },
  { id: "montserrat", label: "Montserrat", family: TEXT_FONT_FAMILY, psName: TEXT_FONT_NAME, widthFactor: 1.08 },
  { id: "poppins", label: "Poppins", family: "Poppins_600SemiBold", psName: "Poppins-SemiBold", widthFactor: 1.05 },
  { id: "marker", label: "Marker", family: "PermanentMarker_400Regular", psName: "PermanentMarker-Regular", widthFactor: 0.95 },
  { id: "caveat", label: "Caveat", family: "Caveat_700Bold", psName: "Caveat-Bold", widthFactor: 0.7 },
  { id: "dm-serif", label: "DM Serif", family: "DMSerifDisplay_400Regular", psName: "DMSerifDisplay-Regular", widthFactor: 0.95 },
  { id: "space-grotesk", label: "Space Grotesk", family: "SpaceGrotesk_700Bold", psName: "SpaceGrotesk-Bold", widthFactor: 1.02 },
];

/** The font of every new text overlay, and (where the build can burn it in) of captions. */
export const DEFAULT_TEXT_FONT_ID = "tiktok-sans";
/** The font of a text made before fonts could be chosen (and the fallback for anything unknown or not loaded). */
export const LEGACY_TEXT_FONT_ID = "montserrat";

export function textFont(fontId: string | undefined): TextFont | null {
  return TEXT_FONTS.find((f) => f.id === fontId) ?? null;
}

/** The JS family for a PostScript name from the table (the editor preview of a render font name), else null. */
export function familyOfPsName(psName: string): string | null {
  return TEXT_FONTS.find((f) => f.psName === psName)?.family ?? null;
}
