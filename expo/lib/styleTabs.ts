/**
 * One control set for styling text, shared by the text overlay editor and the caption style sheet:
 * tabs Text · Outline · Background (always tappable) over one color row. For Outline and Background the first swatch is
 * "none" (⊘): choosing it switches that effect off, choosing a color switches it on with that color. Text has no
 * "none". The shadow is a small on / off button at the end of the tab row.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { paletteByHex, paletteFor, type PaletteColor } from "./palette.ts";
import type { EditorAppearance, StrokeSize } from "./textLook.ts";

export type StyleTab = "text" | "outline" | "background";
export const STYLE_TABS: StyleTab[] = ["text", "outline", "background"];
export const TAB_LABEL: Record<StyleTab, string> = { text: "Text", outline: "Outline", background: "Background" };
export const NONE_ID = "none";

export type StyleSwatch = { id: string; label: string; /** null for "none". */ hex: string | null };

/** The swatches of a tab, in order: "none" first for Outline and Background, then the shared palette. */
export function swatchesFor(tab: StyleTab): StyleSwatch[] {
  const colors = paletteFor(tab).map((c: PaletteColor) => ({ id: c.id, label: c.label, hex: c.hex as string | null }));
  return tab === "text" ? colors : [{ id: NONE_ID, label: "None", hex: null }, ...colors];
}

/** Whether a tab can be switched off (it has a "none"). */
export const hasNone = (tab: StyleTab): boolean => tab !== "text";

// ── text overlays ──

/** The swatch that is selected for a tab: "none" when that effect is off. A color outside the palette selects nothing ("custom"). */
export function overlaySelected(ap: EditorAppearance, tab: StyleTab): string {
  if (tab === "text") return paletteByHex(ap.color)?.id ?? "custom";
  if (tab === "outline") return ap.outline ? (paletteByHex(ap.outlineColor)?.id ?? "custom") : NONE_ID;
  return ap.background ? (paletteByHex(ap.bgColor)?.id ?? "custom") : NONE_ID;
}

/** What tapping a swatch changes: a color switches the effect on with it, "none" switches it off. */
export function overlayPick(tab: StyleTab, swatch: StyleSwatch): Partial<EditorAppearance> {
  if (tab === "text") return swatch.hex ? { color: swatch.hex } : {};
  if (tab === "outline") return swatch.hex ? { outline: true, outlineColor: swatch.hex } : { outline: false };
  return swatch.hex ? { background: true, bgColor: swatch.hex } : { background: false };
}

/** A stroke size tapped (the Outline tab): the outline is on with it. */
export function overlayStroke(size: StrokeSize): Partial<EditorAppearance> {
  return { outline: true, stroke: size };
}

export const overlayToggleShadow = (ap: EditorAppearance): Partial<EditorAppearance> => ({ shadow: !ap.shadow });

// ── captions ──

export type CaptionTabLook = { textColorId: string; backgroundColorId: string; outline: { size: string; colorId: string } | null };

export function captionSelected(look: CaptionTabLook, tab: StyleTab): string {
  if (tab === "text") return look.textColorId;
  if (tab === "outline") return look.outline ? look.outline.colorId : NONE_ID;
  return look.backgroundColorId === "none" ? NONE_ID : look.backgroundColorId;
}

/** The caption look patch for a swatch (same model as the overlays): `outline: null` removes the outline. */
export function captionPick(tab: StyleTab, swatch: StyleSwatch, look: CaptionTabLook): { textColor?: string; backgroundColor?: string; outline?: "thin" | "medium" | "thick" | null; outlineColor?: string } {
  if (tab === "text") return swatch.hex ? { textColor: swatch.id } : {};
  if (tab === "outline") {
    if (!swatch.hex) return { outline: null };
    const size = (look.outline?.size ?? "thin") as "thin" | "medium" | "thick";
    return { outline: size, outlineColor: swatch.id };
  }
  return { backgroundColor: swatch.hex ? swatch.id : "none" };
}
