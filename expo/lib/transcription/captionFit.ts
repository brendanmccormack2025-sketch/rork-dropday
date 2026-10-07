/**
 * Will a caption line fit the box? An estimate of the rendered width of a line in a
 * caption style, in the style's own units (a 1080-pixel-wide frame), against the width
 * the native overlay allows (maxWidth of the frame, default 0.86, minus the padding).
 * Deliberately wide: a line judged too wide is only split earlier, never clipped.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { OverlayStyleSpec } from "../editStyles.ts";

const FRAME = 1080;
const DEFAULT_MAX_WIDTH = 0.86;
/** Keep this share of the box free: font metrics differ between the estimate and the render. */
const SAFETY = 0.92;

const WEIGHT_FACTOR: Record<OverlayStyleSpec["fontWeight"], number> = {
  regular: 0.92,
  medium: 0.95,
  semibold: 0.98,
  bold: 1,
  heavy: 1.04,
  black: 1.08,
};

function charEm(ch: string, upper: boolean): number {
  if (ch === " ") return 0.32;
  if ("iIjl.,'’!:;|".includes(ch)) return 0.4;
  if ("mwMW".includes(ch)) return 1.0;
  return upper ? 0.74 : 0.6;
}

/** Estimated width of `text` in a style, in 1080-wide frame units. */
export function estimateTextWidth(text: string, spec: OverlayStyleSpec): number {
  const shown = spec.uppercase ? text.toUpperCase() : text;
  let em = 0;
  for (const ch of shown) em += charEm(ch, spec.uppercase === true || ch !== ch.toLowerCase());
  const count = [...shown].length;
  return em * spec.fontSize * WEIGHT_FACTOR[spec.fontWeight] + count * (spec.letterSpacing ?? 0);
}

/** Width available to the text of a caption line, in 1080-wide frame units. */
export function availableTextWidth(spec: OverlayStyleSpec): number {
  return (FRAME * (spec.maxWidth ?? DEFAULT_MAX_WIDTH) - 2 * (spec.backgroundPadding ?? 0)) * SAFETY;
}

export function lineFits(text: string, spec: OverlayStyleSpec): boolean {
  return estimateTextWidth(text, spec) <= availableTextWidth(spec);
}
