/**
 * The math of the zoomable Cuts timeline: time <-> screen position at any zoom, pinch zoom around a point, the
 * touch zones of the edge handles, the m:ss.cc readout, one-frame nudges and the waveform columns.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 *
 * Units: time in milliseconds, scale in screen points per millisecond ("pxPerMs"), offset = how far the content is
 * scrolled left, in points. The content has `pad` points before the first and after the last millisecond.
 */

/** Points of empty space before the start and after the end of the timeline. */
export const TL_PAD = 20;
/** The most zoomed-in view shows about this much time across the screen width. */
export const MAX_VISIBLE_MS = 1000;
/** An edge handle's touch target: the 44 pt minimum, at every zoom. */
export const HANDLE_TOUCH = 44;
/** The drawn handle of the selected clip: thick, rounded, full lane height. */
export const HANDLE_W = 14;
export const HANDLE_RADIUS = 6;
/** The outline along the top and bottom of the selected clip. */
export const FRAME_LINE = 2.5;
/** A handle grows by this while it is touched. */
export const HANDLE_PRESS_SCALE = 1.15;
/** The touch target reaches this far above and below the lane. */
export const HANDLE_V_SLOP = 8;
/** Unselected cut boundaries are drawn as a thin divider this wide. */
export const DIVIDER_W = 1.5;

export type View = { scale: number; offset: number };

/** The scale that fits the whole video between the paddings. */
export function fitScale(totalMs: number, viewW: number, pad: number = TL_PAD): number {
  return Math.max(1e-6, (viewW - 2 * pad) / Math.max(1, totalMs));
}

/** The scale that shows about MAX_VISIBLE_MS across the screen width; never below the fit scale (short videos). */
export function maxScale(totalMs: number, viewW: number, pad: number = TL_PAD): number {
  return Math.max(fitScale(totalMs, viewW, pad), viewW / MAX_VISIBLE_MS);
}

export function clampScale(scale: number, totalMs: number, viewW: number, pad: number = TL_PAD): number {
  return Math.min(maxScale(totalMs, viewW, pad), Math.max(fitScale(totalMs, viewW, pad), scale));
}

export function contentWidth(totalMs: number, scale: number, pad: number = TL_PAD): number {
  return 2 * pad + totalMs * scale;
}

/** The scroll offset kept inside the content: 0 at the start, never past the end. */
export function clampOffset(offset: number, totalMs: number, scale: number, viewW: number, pad: number = TL_PAD): number {
  const max = Math.max(0, contentWidth(totalMs, scale, pad) - viewW);
  return Math.min(max, Math.max(0, offset));
}

/** Where a time is on screen. */
export function msToX(ms: number, scale: number, offset: number, pad: number = TL_PAD): number {
  return pad + ms * scale - offset;
}

/** The time under a screen position. */
export function xToMs(x: number, scale: number, offset: number, pad: number = TL_PAD): number {
  return (x + offset - pad) / scale;
}

/**
 * A pinch: the time that was under the fingers' midpoint when the pinch began stays under the midpoint as it moves
 * and the scale changes (zoom is centred between the fingers; moving both fingers also pans).
 */
export function pinchView(
  start: View,
  pinchScale: number,
  startFocalX: number,
  focalX: number,
  totalMs: number,
  viewW: number,
  pad: number = TL_PAD,
): View {
  const scale = clampScale(start.scale * pinchScale, totalMs, viewW, pad);
  const focalMs = xToMs(startFocalX, start.scale, start.offset, pad);
  const offset = clampOffset(pad + focalMs * scale - focalX, totalMs, scale, viewW, pad);
  return { scale, offset };
}

/** Zoom by `factor` keeping the time under `focalX` where it is (buttons, programmatic zoom). */
export function zoomAt(view: View, factor: number, focalX: number, totalMs: number, viewW: number, pad: number = TL_PAD): View {
  return pinchView(view, factor, focalX, focalX, totalMs, viewW, pad);
}

/** Whole video in view (double tap). */
export function fitView(totalMs: number, viewW: number, pad: number = TL_PAD): View {
  return { scale: fitScale(totalMs, viewW, pad), offset: 0 };
}

/** True when the view shows the whole video (nothing to scroll). */
export function isFit(view: View, totalMs: number, viewW: number, pad: number = TL_PAD): boolean {
  return view.scale <= fitScale(totalMs, viewW, pad) * 1.001;
}

/** The scroll offset that puts `ms` at the middle of the screen (clamped). */
export function offsetToCenter(ms: number, scale: number, totalMs: number, viewW: number, pad: number = TL_PAD): number {
  return clampOffset(pad + ms * scale - viewW / 2, totalMs, scale, viewW, pad);
}

/** The new source time of an edge dragged `dxPx` points: the same distance in time at the current zoom. */
export function edgeDragMs(atMs: number, dxPx: number, scale: number): number {
  return atMs + dxPx / scale;
}

/** m:ss.cc (centiseconds, rounded down so the display never runs ahead of the frame). */
export function formatTimeCs(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalCs = Math.floor(safe / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}.${cs < 10 ? "0" : ""}${cs}`;
}

/** "+0.04s" / "-0.40s": how much footage the edge adds or removes. */
export function formatDeltaSeconds(deltaMs: number): string {
  const abs = Math.abs(deltaMs) / 1000;
  return `${deltaMs < 0 ? "-" : "+"}${abs.toFixed(2)}s`;
}

// ── Frames ───────────────────────────────────────────────────────────────────

export const DEFAULT_FPS = 30;

/** The video's frame rate, or 30 when the player did not report a sane one. */
export function safeFps(fps: number | null | undefined): number {
  return typeof fps === "number" && Number.isFinite(fps) && fps >= 10 && fps <= 240 ? fps : DEFAULT_FPS;
}

export function frameMsOf(fps: number | null | undefined): number {
  return 1000 / safeFps(fps);
}

/**
 * One frame earlier (-1) or later (+1) than `ms`, on the video's frame grid (an edge that sits between frames moves
 * to the next grid line in that direction). Stays inside the video. Whole milliseconds.
 */
export function nudgeFrameMs(ms: number, direction: 1 | -1, fps: number | null | undefined, durationMs: number): number {
  const frame = frameMsOf(fps);
  // Frame lines are whole milliseconds (round(k * frame)); step to the next one strictly beyond `ms`, so repeated
  // nudges always move (30 nudges at 30 fps are exactly one second) and never get stuck on a rounded line.
  let k = Math.floor(ms / frame);
  if (direction > 0) {
    k -= 1;
    while (Math.round(k * frame) <= ms) k += 1;
  } else {
    k = Math.ceil(ms / frame) + 1;
    while (Math.round(k * frame) >= ms) k -= 1;
  }
  const next = Math.round(k * frame);
  return Math.min(Math.max(0, next), Math.max(0, Math.round(durationMs)));
}

// ── Waveform ─────────────────────────────────────────────────────────────────

/** A loudness reading (dBFS) as bar height 0..1: -60 dB and below is the floor, -8 dB and above is full. */
export function dbToAmp(db: number): number {
  const v = Number.isFinite(db) ? db : -100;
  return (Math.min(-8, Math.max(-60, v)) + 60) / 52;
}

/** The kept pieces of the source on the output timeline: source [srcStartMs, srcEndMs) plays at outStartMs. */
export type WavePiece = { srcStartMs: number; srcEndMs: number; outStartMs: number };

/** Loudness at a source time: linear between the centres of two windows (smooth when zoomed in). */
function ampAt(windows: ArrayLike<number>, windowMs: number, srcMs: number): number {
  const n = windows.length;
  if (n === 0) return 0;
  const pos = srcMs / windowMs - 0.5;
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(pos)));
  const i1 = Math.min(n - 1, i0 + 1);
  const f = Math.min(1, Math.max(0, pos - i0));
  return dbToAmp(windows[i0]!) * (1 - f) + dbToAmp(windows[i1]!) * f;
}

/** Loudest bar over a source range (a column wider than a window takes the peak, so speech never disappears). */
function peakOver(windows: ArrayLike<number>, windowMs: number, s0: number, s1: number): number {
  if (s1 - s0 < windowMs) return ampAt(windows, windowMs, (s0 + s1) / 2);
  const n = windows.length;
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(s0 / windowMs)));
  const i1 = Math.min(n - 1, Math.max(i0, Math.ceil(s1 / windowMs) - 1));
  let peak = 0;
  for (let i = i0; i <= i1; i++) peak = Math.max(peak, dbToAmp(windows[i]!));
  return peak;
}

/**
 * Bar heights (0..1) for `columns` equal slices of the output time [viewStartMs, viewEndMs): each column is the
 * loudest source window it covers (or, zoomed in past one window, the interpolated level). Output time that no piece
 * covers is 0. Cheap enough to redraw as the view settles; the gesture itself only moves and scales the drawing.
 */
export function waveformColumns(
  windows: ArrayLike<number>,
  windowMs: number,
  pieces: WavePiece[],
  viewStartMs: number,
  viewEndMs: number,
  columns: number,
): number[] {
  const out = new Array<number>(Math.max(0, Math.floor(columns))).fill(0);
  if (!(windowMs > 0) || windows.length === 0 || out.length === 0 || !(viewEndMs > viewStartMs)) return out;
  const step = (viewEndMs - viewStartMs) / out.length;
  for (let k = 0; k < out.length; k++) {
    const a = viewStartMs + k * step;
    const b = a + step;
    let amp = 0;
    for (const p of pieces) {
      const len = p.srcEndMs - p.srcStartMs;
      const lo = Math.max(a, p.outStartMs);
      const hi = Math.min(b, p.outStartMs + len);
      if (hi <= lo) continue;
      const s0 = p.srcStartMs + (lo - p.outStartMs);
      const s1 = p.srcStartMs + (hi - p.outStartMs);
      amp = Math.max(amp, peakOver(windows, windowMs, s0, s1));
    }
    out[k] = amp;
  }
  return out;
}

/** The waveform's SVG path: one vertical bar per non-empty column, mirrored around the lane's centre line. */
export function waveformPath(heights: number[], pitchPx: number, laneH: number, minBar: number = 2): string {
  const mid = laneH / 2;
  const parts: string[] = [];
  for (let k = 0; k < heights.length; k++) {
    const h = heights[k]!;
    if (h <= 0) continue;
    const half = Math.max(minBar / 2, (h * laneH) / 2 - 1);
    const x = (k + 0.5) * pitchPx;
    parts.push(`M${x.toFixed(1)} ${(mid - half).toFixed(1)}V${(mid + half).toFixed(1)}`);
  }
  return parts.join("");
}

/** The pieces of the output timeline for these clips (all from the same source). */
export function wavePiecesOf(clips: Array<{ trimStartMs?: number; trimEndMs?: number; durationMs?: number }>): WavePiece[] {
  const out: WavePiece[] = [];
  let t = 0;
  for (const c of clips) {
    const start = c.trimStartMs ?? 0;
    const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
    if (end <= start) continue;
    out.push({ srcStartMs: start, srcEndMs: end, outStartMs: t });
    t += end - start;
  }
  return out;
}

// ── Layout (so tests can prove nothing overlaps on a small phone) ───────────

export type Rect = { x: number; y: number; w: number; h: number };

export const LANE_H = 56;
export const LANE_TOP = 12;
export const INFO_H = 48;
export const NUDGE_BTN = 44;

/** The fixed parts of the timeline at `width` points: the lane, and the info row with the nudge buttons and readout. */
export function timelineRects(width: number): { lane: Rect; info: Rect; nudgeBack: Rect; nudgeFwd: Rect; readout: Rect; clearBtn: Rect } {
  const lane = { x: 0, y: LANE_TOP, w: width, h: LANE_H };
  const infoY = LANE_TOP + LANE_H;
  const info = { x: 0, y: infoY, w: width, h: INFO_H };
  const pad = 12;
  const nudgeBack = { x: pad, y: infoY + (INFO_H - NUDGE_BTN) / 2, w: NUDGE_BTN, h: NUDGE_BTN };
  const clearBtn = { x: width - pad - NUDGE_BTN, y: nudgeBack.y, w: NUDGE_BTN, h: nudgeBack.h };
  const nudgeFwd = { x: clearBtn.x - 8 - NUDGE_BTN, y: nudgeBack.y, w: NUDGE_BTN, h: nudgeBack.h };
  const readoutX = nudgeBack.x + nudgeBack.w + 8;
  const readout = { x: readoutX, y: infoY, w: Math.max(0, nudgeFwd.x - 8 - readoutX), h: INFO_H };
  return { lane, info, nudgeBack, nudgeFwd, readout, clearBtn };
}

// ── Touch targets (decided on the UI thread, at touch-down) ──────────────────

export const TOP_STRIP_H = LANE_TOP + 8;
export const PLAYHEAD_GRAB = 22;
export const PLAYHEAD_LINE_GRAB = 16;
export const MARKER_HIT = 44;
export const TOP_MARKER_Y = LANE_TOP + 10;
export const BOTTOM_MARKER_Y = LANE_TOP + LANE_H - 12;

/** One seam: where it is on the output timeline, and the source time of the edge on each side. */
export type HandleGeom = {
  outputMs: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevGapMs: number | null;
  nextGapMs: number | null;
  /** The source time of the edge on each side (the end of the clip before / the start of the clip after), 0 if none. */
  prevAtMs: number;
  nextAtMs: number;
};
export type MarkerGeom = { outputMs: number; bottom: boolean };
export type ClipGeom = { startMs: number; durMs: number };

/** The handle geometry for seams in output order. */
export function handleGeoms(seams: Array<{ outputMs: number; prev?: { atMs: number }; next?: { atMs: number } }>): HandleGeom[] {
  return seams.map((h, i) => ({
    outputMs: h.outputMs,
    hasPrev: !!h.prev,
    hasNext: !!h.next,
    prevGapMs: i > 0 ? h.outputMs - seams[i - 1]!.outputMs : null,
    nextGapMs: i < seams.length - 1 ? seams[i + 1]!.outputMs - h.outputMs : null,
    prevAtMs: h.prev?.atMs ?? 0,
    nextAtMs: h.next?.atMs ?? 0,
  }));
}

/**
 * The selected clip's frame: where it is on the output timeline and which seams its two handles drag. The left handle
 * drags the start of the clip (the `next` edge of the seam at its start, side 1), the right handle its end (the `prev`
 * edge of the seam at its end, side 0). An index of -1: no draggable edge on that side.
 */
export type FrameGeom = { startMs: number; endMs: number; leftIdx: number; rightIdx: number };

export function frameOf(clip: ClipGeom | null | undefined, handles: HandleGeom[]): FrameGeom | null {
  if (!clip || !(clip.durMs > 0)) return null;
  const endMs = clip.startMs + clip.durMs;
  return {
    startMs: clip.startMs,
    endMs,
    leftIdx: handles.findIndex((g) => g.hasNext && Math.abs(g.outputMs - clip.startMs) <= 2),
    rightIdx: handles.findIndex((g) => g.hasPrev && Math.abs(g.outputMs - endMs) <= 2),
  };
}

/** Where the two handles are drawn on screen (their centres): just outside the clip, so the clip stays fully visible. */
export function frameHandleXs(frame: FrameGeom, scale: number, offset: number, pad: number = TL_PAD): { left: number; right: number } {
  return {
    left: msToX(frame.startMs, scale, offset, pad) - HANDLE_W / 2,
    right: msToX(frame.endMs, scale, offset, pad) + HANDLE_W / 2,
  };
}

/**
 * The handle under a touch: a 44 pt wide target centred on each drawn handle, as tall as the lane plus a little above
 * and below, at every zoom. Only the selected clip's handles can be grabbed. Returns the seam index and side.
 */
export function hitFrame(x: number, y: number, frame: FrameGeom | null, scale: number, offset: number, pad: number = TL_PAD): { index: number; side: 0 | 1 } | null {
  if (!frame) return null;
  if (y < LANE_TOP - HANDLE_V_SLOP || y > LANE_TOP + LANE_H + HANDLE_V_SLOP) return null;
  const xs = frameHandleXs(frame, scale, offset, pad);
  const dl = frame.leftIdx >= 0 ? Math.abs(x - xs.left) : Infinity;
  const dr = frame.rightIdx >= 0 ? Math.abs(x - xs.right) : Infinity;
  if (dl > HANDLE_TOUCH / 2 && dr > HANDLE_TOUCH / 2) return null;
  return dl <= dr ? { index: frame.leftIdx, side: 1 } : { index: frame.rightIdx, side: 0 };
}

export type Grab = { kind: "playhead" | "edge" | "scroll"; index: number; side: 0 | 1 };

/**
 * What a finger that lands at (x, y) is going to drag: the playhead (its dot in the top strip, or its line), a handle
 * of the selected clip, or the timeline itself (scroll). The strip above the lane belongs to the playhead, the
 * handles win over the playhead's line; a plain spot scrolls.
 */
export function grabAt(x: number, y: number, frame: FrameGeom | null, playheadMs: number, scale: number, offset: number, pad: number = TL_PAD): Grab {
  const px = msToX(playheadMs, scale, offset, pad);
  if (y < TOP_STRIP_H && Math.abs(x - px) <= PLAYHEAD_GRAB) return { kind: "playhead", index: -1, side: 0 };
  const edge = hitFrame(x, y, frame, scale, offset, pad);
  if (edge) return { kind: "edge", index: edge.index, side: edge.side };
  if (Math.abs(x - px) <= PLAYHEAD_LINE_GRAB) return { kind: "playhead", index: -1, side: 0 };
  return { kind: "scroll", index: -1, side: 0 };
}

export type TapTarget = { kind: "marker" | "edge" | "clip" | "none"; index: number; side: 0 | 1 };

/** What a tap at (x, y) hits: a marker first (44 x 44), then a handle of the selected clip, then the clip under it. */
export function tapAt(
  x: number,
  y: number,
  markers: MarkerGeom[],
  frame: FrameGeom | null,
  clips: ClipGeom[],
  scale: number,
  offset: number,
  pad: number = TL_PAD,
): TapTarget {
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const mx = msToX(m.outputMs, scale, offset, pad);
    const my = m.bottom ? BOTTOM_MARKER_Y : TOP_MARKER_Y;
    if (Math.abs(x - mx) <= MARKER_HIT / 2 && Math.abs(y - my) <= MARKER_HIT / 2) return { kind: "marker", index: i, side: 0 };
  }
  const edge = hitFrame(x, y, frame, scale, offset, pad);
  if (edge) return { kind: "edge", index: edge.index, side: edge.side };
  if (y >= LANE_TOP && y <= LANE_TOP + LANE_H) {
    const ms = xToMs(x, scale, offset, pad);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]!;
      if (ms >= c.startMs && ms < c.startMs + c.durMs) return { kind: "clip", index: i, side: 0 };
    }
  }
  return { kind: "none", index: -1, side: 0 };
}

/**
 * Keep the playhead on screen while the video plays on a zoomed timeline: null when it is already comfortably in
 * view, else the offset that puts it in the middle.
 */
export function followOffset(playheadMs: number, scale: number, offset: number, totalMs: number, viewW: number, margin: number = 48, pad: number = TL_PAD): number | null {
  const x = msToX(playheadMs, scale, offset, pad);
  if (x >= margin && x <= viewW - margin) return null;
  const next = offsetToCenter(playheadMs, scale, totalMs, viewW, pad);
  return Math.abs(next - offset) < 0.5 ? null : next;
}

/** The offset that brings an edge back into view (or null if it is). */
export function revealOffset(ms: number, scale: number, offset: number, totalMs: number, viewW: number, margin: number = 40, pad: number = TL_PAD): number | null {
  return followOffset(ms, scale, offset, totalMs, viewW, margin, pad);
}

// ── Animation steps (run in JS, one call per frame) ─────────────────────────

export function easeOutCubic(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - k, 3);
}

/** The view part-way (0..1) between two views, eased. */
export function lerpView(from: View, to: View, t: number): View {
  const e = easeOutCubic(t);
  return { scale: from.scale + (to.scale - from.scale) * e, offset: from.offset + (to.offset - from.offset) * e };
}

/** Friction of a fling, per second: the speed falls to 1/e of itself in 1/FLING_FRICTION s. */
export const FLING_FRICTION = 3.2;
/** A fling slower than this (points per second) is over. */
export const FLING_MIN_SPEED = 15;

/**
 * One frame of a fling: the scroll offset keeps moving at `velocity` (points per second) while friction slows it, and
 * stops at the ends of the content. `maxOffset` is the furthest the content can scroll.
 */
export function flingStep(offset: number, velocity: number, dtSec: number, maxOffset: number): { offset: number; velocity: number; done: boolean } {
  const dt = Math.min(0.05, Math.max(0, dtSec));
  const next = offset + velocity * dt;
  const clamped = Math.min(Math.max(0, maxOffset), Math.max(0, next));
  const v = velocity * Math.exp(-FLING_FRICTION * dt);
  const hitEnd = clamped !== next;
  return { offset: clamped, velocity: hitEnd ? 0 : v, done: hitEnd || Math.abs(v) < FLING_MIN_SPEED };
}
