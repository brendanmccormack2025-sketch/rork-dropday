/**
 * The clip-wide caption box (size and position) the creator sets by dragging and pinching
 * the caption in the editor. Every caption follows it; it is stored in the edit state
 * (EditState.captionStyle) so undo / redo cover it, and the burned-in render gets the same
 * numbers (applyCaptionStyle in editStyles.ts).
 *
 *  - scale 0.6x..2x of the preset's font size.
 *  - The box stays inside a safe zone: clear of the feed's top 10% and bottom 25%.
 *  - Dragging snaps to the horizontal centre.
 *  - Horizontal placement is locked to the centre while the native renderer cannot place
 *    an overlay horizontally (CAPTION_STYLE_CONFIG.horizontalNative); the stored xCenter
 *    stays so the JS is ready for it.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { CaptionStyle } from "../editModel.ts";
import { applyCaptionStyle, resolveOverlayStyle, type OverlayStyleSpec } from "../editStyles.ts";
import { estimateTextWidth } from "./captionFit.ts";
import { defaultFontId } from "./captionPresets.ts";

export const CAPTION_STYLE_CONFIG = {
  minScale: 0.6,
  maxScale: 2,
  /** The caption box stays between these fractions of the frame height (top edge .. bottom edge). */
  safeTop: 0.1,
  safeBottom: 0.75,
  /** Snap to the horizontal centre when within this fraction of the frame width (about 6 pt on a phone). */
  snapX: 0.016,
  /** Line height used to estimate the box height (times the font size). */
  lineHeight: 1.25,
  /** False until VideoRenderModule.swift reads xCenter: horizontal movement is then off (see report). */
  horizontalNative: false,
};
export type CaptionStyleConfig = typeof CAPTION_STYLE_CONFIG;

export const CAPTION_PRESET_ID = "trial";

const presetSpec = (): OverlayStyleSpec => resolveOverlayStyle("caption", CAPTION_PRESET_ID);

/** The caption box as the preset has it: scale 1, its own height, centred. */
export function defaultCaptionStyle(): CaptionStyle {
  return { scale: 1, yCenter: presetSpec().yCenter, xCenter: 0.5 };
}

/** A stored style, or the default when none was set. */
export function effectiveCaptionStyle(style?: CaptionStyle | null): CaptionStyle {
  return style ?? defaultCaptionStyle();
}

/** The preset with a style applied (what the preview and the render both draw). */
export function styledSpec(style?: CaptionStyle | null): OverlayStyleSpec {
  return style ? applyCaptionStyle(presetSpec(), style) : presetSpec();
}

/** Half the height of a one-line caption box as a fraction of the frame height (aspect = frame height / width). */
export function halfBoxHeight(scale: number, aspect: number, config: CaptionStyleConfig = CAPTION_STYLE_CONFIG): number {
  const spec = presetSpec();
  const boxPx = spec.fontSize * scale * config.lineHeight + 2 * (spec.backgroundPadding ?? 0) * scale;
  return boxPx / 2 / (1080 * aspect);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Scale limits, and a box that stays inside the safe zone. aspect = frame height / frame width (16/9 for 9:16 video). */
export function clampCaptionStyle(
  style: CaptionStyle,
  aspect = 16 / 9,
  config: CaptionStyleConfig = CAPTION_STYLE_CONFIG,
): CaptionStyle {
  const scale = clamp(style.scale, config.minScale, config.maxScale);
  const half = halfBoxHeight(scale, aspect, config);
  const lo = config.safeTop + half;
  const hi = config.safeBottom - half;
  // A box taller than the zone cannot fit it: keep the centre inside the zone.
  const yCenter = lo > hi ? clamp(style.yCenter, config.safeTop, config.safeBottom) : clamp(style.yCenter, lo, hi);
  const halfW = (presetSpec().maxWidth ?? 0.86) / 2;
  const xCenter = config.horizontalNative ? clamp(style.xCenter, halfW, 1 - halfW) : 0.5;
  return { scale, yCenter, xCenter };
}

/** Snap to the horizontal centre when close; `snappedX` tells the preview to draw its guide. */
export function snapCaptionStyle(
  style: CaptionStyle,
  config: CaptionStyleConfig = CAPTION_STYLE_CONFIG,
): { style: CaptionStyle; snappedX: boolean } {
  const snappedX = Math.abs(style.xCenter - 0.5) <= config.snapX;
  return { style: snappedX ? { ...style, xCenter: 0.5 } : style, snappedX };
}

/** What a drag or pinch produces: snapped, then clamped. */
export function settleCaptionStyle(
  style: CaptionStyle,
  aspect = 16 / 9,
  config: CaptionStyleConfig = CAPTION_STYLE_CONFIG,
): { style: CaptionStyle; snappedX: boolean } {
  const snapped = snapCaptionStyle(style, config);
  return { style: clampCaptionStyle(snapped.style, aspect, config), snappedX: snapped.snappedX };
}

// ── Where the box is, in the preview and in the native render ──────────────────────────────

export type Rect = { left: number; top: number; width: number; height: number };

/** The smallest touch target (points) the interactive overlay may have, in each direction. */
export const MIN_TOUCH_PT = 44;

/** The caption box in the preview frame: its centre sits at (xCenter, yCenter) of the frame. */
export function captionBoxRect(frame: { w: number; h: number }, style: CaptionStyle, box: { w: number; h: number }): Rect {
  return {
    left: frame.w * style.xCenter - box.w / 2,
    top: frame.h * style.yCenter - box.h / 2,
    width: box.w,
    height: box.h,
  };
}

/** The touch target for a box: the same centre, at least MIN_TOUCH_PT in both directions, never smaller than the box. */
export function touchRect(rect: Rect, min: number = MIN_TOUCH_PT): Rect {
  const width = Math.max(rect.width, min);
  const height = Math.max(rect.height, min);
  return {
    left: rect.left - (width - rect.width) / 2,
    top: rect.top - (height - rect.height) / 2,
    width,
    height,
  };
}

/**
 * The size the box will have, before it has been measured: the text width estimate (captionFit) wrapped at
 * the preset's maxWidth, plus padding, in preview pixels. The real size is measured from the layout; this
 * only places the overlay for the first frame.
 */
export function estimateBoxSize(
  text: string,
  style: CaptionStyle,
  frameW: number,
  config: CaptionStyleConfig = CAPTION_STYLE_CONFIG,
): { w: number; h: number } {
  const spec = styledSpec(style);
  const pad = spec.backgroundPadding ?? 0;
  const px = frameW / 1080;
  const avail = Math.max(1, 1080 * (spec.maxWidth ?? 0.86) - 2 * pad);
  const textW = estimateTextWidth(text, spec);
  const lines = Math.max(1, Math.ceil(textW / avail));
  return {
    w: (Math.min(textW, avail) + 2 * pad) * px,
    h: (spec.fontSize * config.lineHeight * lines + 2 * pad) * px,
  };
}

/**
 * Core Animation in AVVideoCompositionCoreAnimationTool has its origin at the BOTTOM left, so
 * VideoRenderModule.swift places the overlay centre at y = height * (1 - yCenter) (yCenter counts from the top).
 * These two functions are that mapping and its inverse; the preview draws at height * yCenter from the top.
 */
export function nativeCenterY(frameH: number, yCenter: number): number {
  return frameH * (1 - yCenter);
}
export function yCenterFromNative(frameH: number, nativeY: number): number {
  return 1 - nativeY / frameH;
}
export function previewCenterY(frameH: number, yCenter: number): number {
  return frameH * yCenter;
}

// ── Look: font, text color, background (see captionPresets.ts) ────────────────────────────────

/**
 * The style to draw and render with. A font is only usable when the build can render it (the native
 * module reports supportsCaptionFont): without it the font is dropped, so the preview never shows a font
 * the render cannot produce. The stored style keeps the font.
 */
export function usableCaptionStyle(style: CaptionStyle | null | undefined, supportsFont: boolean): CaptionStyle | undefined {
  // Where fonts work, a caption with no chosen font is Classic (Montserrat). Where they do not, nothing changes.
  if (supportsFont) return style?.fontId === undefined ? { ...effectiveCaptionStyle(style), fontId: defaultFontId(true) } : style;
  if (!style) return undefined;
  if (style.fontId === undefined) return style;
  const { fontId: _drop, ...rest } = style;
  return rest;
}

/** A look change (a font, a text color or a background chosen) applied to the stored style (or the default one). */
export function withCaptionLook(
  style: CaptionStyle | null | undefined,
  patch: { fontId?: string; textColor?: string; backgroundColor?: string; uppercase?: boolean },
): CaptionStyle {
  return { ...effectiveCaptionStyle(style), ...patch };
}

/** "Reset to Trial style": font and colors back to the defaults; size and position are kept. */
export function resetCaptionLook(style: CaptionStyle | null | undefined, supportsFont = false): CaptionStyle {
  const { scale, yCenter, xCenter } = effectiveCaptionStyle(style);
  return supportsFont ? { scale, yCenter, xCenter, fontId: defaultFontId(true) } : { scale, yCenter, xCenter };
}
