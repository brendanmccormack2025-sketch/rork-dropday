/**
 * The single shared definition of an edit.
 *
 * An edit is instructions only (clips = ranges of source files, plus overlays);
 * nothing is re-rendered when it changes. Later a native renderer turns the
 * instructions into one finished mp4.
 *
 * Pure functions: no React, no native modules. Erasable TypeScript only (no
 * enums / parameter properties) so scripts/test-edit-model.mjs can run it with
 * Node's type stripping.
 *
 * Two timelines:
 *  - SOURCE time: ms on the original recording.
 *  - OUTPUT time: ms on the finished video, after cuts. Overlay startMs/endMs
 *    are always on the OUTPUT timeline.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** One kept range of a source file (a "segment"). */
export type EditClip = {
  uri: string;
  trimStartMs: number;
  trimEndMs: number;
};

/** A range on the source timeline to keep. */
export type KeepRange = { startMs: number; endMs: number };

/** Mirrors posts.trim_data entries. */
export type TrimRange = { trimStartMs: number; trimEndMs: number };

type OverlayBase = {
  id?: string;
  /** Output timeline. Missing startMs/endMs = the whole video. */
  startMs?: number;
  endMs?: number;
};

export type TextEditOverlay = OverlayBase & { kind: "text"; text: string; style?: string };
/**
 * Clip-wide caption box: every caption follows it. scale multiplies the preset's font size
 * (and padding); yCenter / xCenter place the box centre as fractions of the frame (0 = top / left).
 */
export type CaptionStyle = {
  scale: number;
  yCenter: number;
  xCenter: number;
  /** Look (see lib/transcription/captionPresets.ts): ids; absent = the Trial look. */
  fontId?: string;
  textColor?: string;
  backgroundColor?: string;
};

export type CaptionEditOverlay = OverlayBase & { kind: "caption"; text: string; style?: string; captionStyle?: CaptionStyle };
/** Type only, not used yet. */
export type ImageEditOverlay = OverlayBase & { kind: "image"; uri: string };
/** Type only, not used yet. */
export type SfxEditOverlay = OverlayBase & { kind: "sfx"; uri: string; volume?: number };

export type EditOverlay =
  | TextEditOverlay
  | CaptionEditOverlay
  | ImageEditOverlay
  | SfxEditOverlay;

export type EditInstructions = {
  version: 1;
  clips: EditClip[];
  overlays: EditOverlay[];
};

// ── Clips ───────────────────────────────────────────────────────────────────

/**
 * Keep ranges of one source file -> clips. Ranges are sorted, clamped to
 * >= 0 and empty ones dropped. Ranges are not merged: touching ranges stay
 * separate clips.
 */
export function keepRangesToClips(uri: string, keepRanges: KeepRange[]): EditClip[] {
  return keepRanges
    .map((r) => ({ uri, trimStartMs: Math.max(0, r.startMs), trimEndMs: r.endMs }))
    .filter((c) => c.trimEndMs > c.trimStartMs)
    .sort((a, b) => a.trimStartMs - b.trimStartMs);
}

/**
 * Clips -> what posts stores: segments (one URI per clip; clips of the same
 * source repeat the same URI) and trim_data (one range per clip).
 */
export function clipsToSegments(clips: EditClip[]): {
  segments: string[];
  trimData: TrimRange[];
} {
  return {
    segments: clips.map((c) => c.uri),
    trimData: clips.map((c) => ({ trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs })),
  };
}

function clipLengthMs(c: TrimRange): number {
  return Math.max(0, c.trimEndMs - c.trimStartMs);
}

/** Length of the finished video. */
export function outputDurationMs(clips: TrimRange[]): number {
  let total = 0;
  for (const c of clips) total += clipLengthMs(c);
  return total;
}

// ── Time mapping ────────────────────────────────────────────────────────────

/**
 * Time on the original recording -> time after cuts. Null if that moment was
 * cut out. A clip owns [trimStartMs, trimEndMs); the very end of the last
 * kept clip also maps. Pass sourceUri when clips come from several files.
 */
export function sourceToOutputMs(
  clips: EditClip[],
  sourceMs: number,
  sourceUri?: string,
): number | null {
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (sourceUri === undefined || c.uri === sourceUri) {
      const isLast = i === clips.length - 1;
      const inside =
        sourceMs >= c.trimStartMs &&
        (sourceMs < c.trimEndMs || (isLast && sourceMs === c.trimEndMs));
      if (inside) return offset + (sourceMs - c.trimStartMs);
    }
    offset += clipLengthMs(c);
  }
  return null;
}

/**
 * Time after cuts -> time on the original recording (of the clip that plays
 * it). Null when outside the finished video. The very end maps to the end of
 * the last clip.
 */
export function outputToSourceMs(clips: TrimRange[], outputMs: number): number | null {
  if (outputMs < 0) return null;
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const len = clipLengthMs(c);
    const isLast = i === clips.length - 1;
    if (outputMs < offset + len || (isLast && outputMs === offset + len)) {
      return c.trimStartMs + (outputMs - offset);
    }
    offset += len;
  }
  return null;
}

/**
 * Playback: the player is on segment `segmentIndex` at `positionMs` in its
 * SOURCE file -> time on the output timeline. Position is clamped into the
 * segment's trim range.
 */
export function getOutputTimeMs(
  segmentIndex: number,
  positionMs: number,
  trims: TrimRange[],
): number {
  if (trims.length === 0) return 0;
  const idx = Math.min(Math.max(0, segmentIndex), trims.length - 1);
  const t = trims[idx]!;
  const within = Math.min(Math.max(0, positionMs - t.trimStartMs), clipLengthMs(t));
  return outputDurationMs(trims.slice(0, idx)) + within;
}
