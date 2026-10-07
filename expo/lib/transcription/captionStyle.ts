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

export const CAPTION_STYLE_CONFIG = {
  minScale: 0.6,
  maxScale: 2,
  /** The caption box stays between these fractions of the frame height (top edge .. bottom edge). */
  safeTop: 0.1,
  safeBottom: 0.75,
  /** Snap to the horizontal centre when within this fraction of the frame width. */
  snapX: 0.04,
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
  // A box taller than the zone sits in the middle of it.
  const yCenter = lo > hi ? (config.safeTop + config.safeBottom) / 2 : clamp(style.yCenter, lo, hi);
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
