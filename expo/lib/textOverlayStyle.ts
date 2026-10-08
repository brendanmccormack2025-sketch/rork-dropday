/**
 * Text-button overlays as data: their colors and their pinch scale. Pure: no React, no native modules.
 *
 * Text-button overlays are drawn live (never burned into a video); sizes always come from lib/feedLayout.ts
 * (textLayout, textSlot), so the editor and the feed are one layout.
 */

export type OverlayBackgroundStyle = "none-white" | "none-black" | "white-box" | "black-box" | "accent-box" | "translucent-box";

/** The slice of a Text-button overlay these functions read (the full type lives in PostsProvider). */
export type TextOverlayData = {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  scale?: number;
  rotation: number;
  color: string;
  backgroundStyle: OverlayBackgroundStyle;
  fontId?: string;
  kind?: "text" | "caption";
  startMs?: number;
  endMs?: number;
};

export type BgMeta = { bgColor: string; textColor: string; bgOpacity: number; borderRadius: number };

export function resolveBgMeta(style: OverlayBackgroundStyle, accentColor: string): BgMeta {
  switch (style) {
    case "none-white":
      return { bgColor: "transparent", textColor: "#FFFFFF", bgOpacity: 0, borderRadius: 0 };
    case "none-black":
      return { bgColor: "transparent", textColor: "#000000", bgOpacity: 0, borderRadius: 0 };
    case "white-box":
      return { bgColor: "#FFFFFF", textColor: "#000000", bgOpacity: 1, borderRadius: 0 };
    case "black-box":
      return { bgColor: "#000000", textColor: "#FFFFFF", bgOpacity: 1, borderRadius: 0 };
    case "accent-box":
      return { bgColor: accentColor, textColor: "#FFFFFF", bgOpacity: 1, borderRadius: 0 };
    case "translucent-box":
      return { bgColor: "#000000", textColor: "#FFFFFF", bgOpacity: 0.55, borderRadius: 0 };
  }
}

// ── Pinch scale ──

export const MIN_OVERLAY_SCALE = 0.4;
export const MAX_OVERLAY_SCALE = 4;

export function clampScale(scale: number | undefined): number {
  'worklet';
  const s = scale === undefined || !Number.isFinite(scale) ? 1 : scale;
  return Math.max(MIN_OVERLAY_SCALE, Math.min(MAX_OVERLAY_SCALE, s));
}

/** The font size (in the overlay's own units) that is drawn: typed size times the pinch scale. */
export function effectiveFontSize(ov: { fontSize: number; scale?: number }): number {
  'worklet';
  return (ov.fontSize ?? 26) * clampScale(ov.scale);
}
