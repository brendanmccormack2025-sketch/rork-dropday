/**
 * Full-screen editor, TikTok style: while the video plays the top bar and the tool column step back (about 40%); while an
 * overlay or the caption is dragged or pinched they fade out; a selected overlay under the tool column fades the column.
 * New texts are placed and sized inside the area left of the column.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { E_TOOLS } from "./editorChrome.ts";

export const PLAYING_CHROME_OPACITY = 0.4;

type R = { x: number; y: number; w: number; h: number };
const hit = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function chromeFade(args: { isPlaying: boolean; gesturing: boolean; selectedRect: R | null; columnRect: R | null }): { topBar: number; toolColumn: number } {
  if (args.gesturing) return { topBar: 0, toolColumn: 0 };
  const calm = args.isPlaying ? PLAYING_CHROME_OPACITY : 1;
  const covered = !!args.selectedRect && !!args.columnRect && hit(args.selectedRect, args.columnRect);
  return { topBar: calm, toolColumn: covered ? 0 : calm };
}

/** An estimate of the size of a text overlay on screen (it is drawn by the overlay itself; this only needs to be close). */
export function estimateTextSize(text: string, fontSize: number, scale: number, maxWidth: number): { w: number; h: number } {
  // laid out at scale 1 (wrapping at maxWidth), then the whole box is scaled
  const lines = text.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  const em = fontSize;
  const raw = longest * em * 0.58 + 1.2 * em;
  const w = Math.min(maxWidth, raw);
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * em * 0.58 + 1.2 * em) / Math.max(1, maxWidth))), 0);
  const h = wrapped * em * 1.25 + 0.7 * em;
  return { w: w * scale, h: h * scale };
}

/** The screen rectangle of an overlay (centre at fractions of the visible frame). */
export function overlayScreenRect(args: { text: string; fontSize: number; scale: number; centerX: number; centerY: number; maxWidth: number }): R {
  const { w, h } = estimateTextSize(args.text, args.fontSize, args.scale, args.maxWidth);
  return { x: args.centerX - w / 2, y: args.centerY - h / 2, w, h };
}

/** The left edge of the tool column on a screen `w` wide. */
export const toolColumnLeft = (w: number): number => w - E_TOOLS.right - E_TOOLS.width;

/**
 * Where a new text goes: centred in the area left of the tool column, and smaller if the text would not fit it.
 * `x` is in frame pixels (convert with frameToFrac); `scale` is 1 when it fits, never below 0.5.
 */
export function newTextPlacement(args: { text: string; fontSize: number; frameW: number; maxWidth: number; margin?: number }): { centerPx: number; scale: number } {
  const margin = args.margin ?? 12;
  const left = toolColumnLeft(args.frameW) - margin;
  const available = Math.max(60, left - margin);
  const natural = estimateTextSize(args.text, args.fontSize, 1, args.maxWidth).w;
  const scale = natural <= available ? 1 : Math.max(0.5, Math.floor((available / natural) * 100) / 100);
  return { centerPx: margin + available / 2, scale };
}
