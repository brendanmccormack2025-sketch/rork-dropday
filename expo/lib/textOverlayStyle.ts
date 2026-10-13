/**
 * Text-button overlays as data: their colors, their pinch scale, and the native-render version of them (the camera-roll
 * export, build 1.0.5). Pure: no React, no native modules.
 *
 * The posted video does not carry them (the feed draws them live); the saved video can. Sizes always come from
 * lib/feedLayout.ts (textLayout), their look from lib/textLook.ts (resolveAppearance, shadowOf), so the editor, the feed
 * and the saved video are one layout.
 */
import type { EditOverlay } from "./editModel.ts";
import type { OverlayStyleSpec } from "./editStyles.ts";
import { TEXT_LINE_HEIGHT_EM, textLayout } from "./feedLayout.ts";
import { burnedFontName, LEGACY_SHADOW_REF_WIDTH, resolveAppearance, shadowOf, type LookSource } from "./textLook.ts";

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

/**
 * The text editor's Cancel: a new text (no overlay yet) is discarded and nothing changes; an existing overlay is
 * removed. `snapshot` says whether an undo step must be taken first, so undo brings the overlay back.
 */
export function cancelTextEdit<T extends { id: string }>(overlays: T[], editingId: string | null): { overlays: T[]; snapshot: boolean } {
  if (!editingId || !overlays.some((o) => o.id === editingId)) return { overlays, snapshot: false };
  return { overlays: overlays.filter((o) => o.id !== editingId), snapshot: true };
}

// ── The native-render version ──

/** What the build can draw: the PostScript names of its bundled fonts (VideoRender.supportedFontNames). */
export type ExportCaps = { fontNames: readonly string[] };

function withAlpha(hex: string, opacity: number): string {
  if (opacity >= 1) return hex;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `${hex}${a}`;
}

/**
 * The renderer's style for one Text-button overlay, in 1080-wide frame units (the renderer scales them to the video's
 * width). The numbers are the editor's own: fontSize / padding / corner radius / max width from textLayout at 1080 wide
 * (the pinch scale included, effectiveFontSize), the look from resolveAppearance, the shadow from shadowOf. The box is
 * centred on (x, y) and turned by `rotation`. Padding is always sent (the editor's box has it with or without a background),
 * so the text wraps where the editor wraps it.
 */
export function textOverlayExportSpec(ov: TextOverlayData & TextLookFields, caps: ExportCaps): OverlayStyleSpec {
  const a = resolveAppearance(ov);
  const l = textLayout(effectiveFontSize(ov), 1080);
  const spec: OverlayStyleSpec = {
    fontSize: l.fontSize,
    fontWeight: "bold",
    color: a.textColor,
    yCenter: ov.y,
    xCenter: ov.x,
    maxWidth: l.maxWidth / 1080,
    backgroundPaddingX: l.padX,
    backgroundPaddingY: l.padY,
    lineHeight: TEXT_LINE_HEIGHT_EM,
    // A hard cut leaves an overlay visible after its end in the renderer, so a 1 ms fade is used (as for captions).
    fadeInMs: 1,
    fadeOutMs: 1,
  };
  // The overlay's own font where the build embeds it, else Montserrat Bold; a build with no bundled font keeps the system font.
  const fontName = burnedFontName(a.fontId, caps.fontNames);
  if (caps.fontNames.includes(fontName)) spec.fontName = fontName;
  if (ov.rotation) spec.rotation = ov.rotation;
  if (a.boxColor !== null) {
    spec.backgroundColor = withAlpha(a.boxColor, a.boxOpacity);
    spec.cornerRadius = l.cornerRadius;
    spec.lineBackground = true;
  }
  if (a.stroke) {
    spec.outlineColor = a.stroke.color;
    spec.outlineWidth = a.stroke.em * l.fontSize;
  }
  const sh = shadowOf(a, l.fontSize, 1080 / LEGACY_SHADOW_REF_WIDTH);
  if (sh) {
    // A text shadow's radius is a blur radius; the renderer's shadow layer takes about half of it.
    spec.textShadow = { color: sh.color, opacity: sh.opacity, radius: sh.kind === "text" ? sh.radius / 2 : sh.radius, offsetY: sh.offsetY };
  }
  return spec;
}

/** The look fields of an overlay (see lib/textLook.ts). */
export type TextLookFields = LookSource;

/**
 * Text-button overlays -> overlays for the renderer: only the ones with words, each with its own time window on the
 * edited timeline (absent = the whole video).
 */
export function textOverlaysToEditOverlays(overlays: ReadonlyArray<TextOverlayData & TextLookFields>, caps: ExportCaps): EditOverlay[] {
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

/**
 * The Text-button overlays to burn into the saved video. None when the build cannot draw them
 * (supportsTextOverlays false: it saves without text, as before) or the user turned "Include text in saved video" off.
 */
export function textOverlaysForSave(args: {
  supportsTextOverlays: boolean;
  includeText: boolean;
  overlays: ReadonlyArray<TextOverlayData & TextLookFields>;
  fontNames: readonly string[];
}): EditOverlay[] {
  if (!args.supportsTextOverlays || !args.includeText) return [];
  return textOverlaysToEditOverlays(args.overlays, { fontNames: args.fontNames });
}
