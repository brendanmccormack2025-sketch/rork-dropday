/**
 * Text-button overlays as data: their colors, their pinch scale, and the native-render version of them
 * (the camera-roll export). Pure: no React, no native modules.
 *
 * Sizes always come from lib/feedLayout.ts (textLayout, textSlot), so the editor, Preview, the feed and the
 * export are one layout.
 */
import type { EditOverlay } from "./editModel.ts";
import type { OverlayStyleSpec } from "./editStyles.ts";
import { textOverlayRenderSpec } from "./feedLayout.ts";
import { CAPTION_FONTS } from "./transcription/captionPresets.ts";

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

// ── The native-render version ──

export type ExportCaps = { supportsFont: boolean; supportsTextBox: boolean };

function withAlpha(hex: string, opacity: number): string {
  if (opacity >= 1) return hex;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `${hex}${a}`;
}

/** The PostScript font name the native render uses, or undefined for the system font. */
export function overlayFontName(fontId: string | undefined, supportsFont: boolean): string | undefined {
  if (!supportsFont) return undefined;
  if (!fontId) return "Montserrat-Bold";
  const font = CAPTION_FONTS.find((f) => f.id === fontId);
  if (!font) return "Montserrat-Bold";
  return font.fontName ?? undefined;
}

/**
 * The renderer's style for one Text-button overlay. fontSize, padding, corner and max width are the
 * feed's textLayout numbers in 1080-wide units (the renderer scales them to the video width); the
 * centre and rotation are the overlay's own.
 */
export function textOverlayExportSpec(ov: TextOverlayData, caps: ExportCaps): OverlayStyleSpec {
  const bg = resolveBgMeta(ov.backgroundStyle ?? "none-white", ov.color);
  const hasBg = bg.bgOpacity > 0 && bg.bgColor !== "transparent";
  const r = textOverlayRenderSpec(effectiveFontSize(ov));
  const fontName = overlayFontName(ov.fontId, caps.supportsFont);
  const spec: OverlayStyleSpec = {
    fontSize: r.fontSize,
    fontWeight: "bold",
    color: bg.textColor,
    yCenter: ov.y,
    xCenter: ov.x,
    maxWidth: r.maxWidth,
    // A hard cut leaves an overlay visible after its end in the renderer, so a 1 ms fade is used (as for captions).
    fadeInMs: 1,
    fadeOutMs: 1,
  };
  if (fontName) spec.fontName = fontName;
  if (ov.rotation) spec.rotation = ov.rotation;
  if (hasBg) {
    spec.backgroundColor = withAlpha(bg.bgColor, bg.bgOpacity);
    spec.cornerRadius = r.cornerRadius;
  } else if (bg.textColor !== "#000000") {
    spec.shadow = true;
  }
  if (caps.supportsTextBox) {
    spec.lineHeight = r.lineHeight;
    if (hasBg) {
      spec.backgroundPaddingX = r.backgroundPaddingX;
      spec.backgroundPaddingY = r.backgroundPaddingY;
    }
  } else if (hasBg) {
    // Older renderers take one padding value for all sides.
    spec.backgroundPadding = (r.backgroundPaddingX + r.backgroundPaddingY) / 2;
  }
  return spec;
}

/**
 * Text-button overlays -> overlays for the renderer. Where the build cannot place text by its centre or
 * rotate it (supportsTextBox, build 1.0.4) they cannot be burned in faithfully: none are returned.
 */
export function textOverlaysToEditOverlays(overlays: ReadonlyArray<TextOverlayData>, caps: ExportCaps): EditOverlay[] {
  if (!caps.supportsTextBox) return [];
  return overlays
    .filter((ov) => ov.kind === undefined || ov.kind === "text")
    .filter((ov) => ov.text.trim().length > 0)
    .map((ov) => ({
      kind: "text" as const,
      id: ov.id,
      text: ov.text,
      ...(ov.startMs !== undefined ? { startMs: ov.startMs } : {}),
      ...(ov.endMs !== undefined ? { endMs: ov.endMs } : {}),
      spec: textOverlayExportSpec(ov, caps),
    }));
}
