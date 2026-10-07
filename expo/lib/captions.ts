/**
 * Caption lines from word timings, placed on the OUTPUT timeline.
 *
 * Pure functions: no React, no native modules. Erasable TypeScript only so
 * scripts/test-captions.mjs can run it with Node's type stripping.
 */
import {
  sourceToOutputMs,
  type CaptionEditOverlay,
  type EditClip,
} from "./editModel.ts";

/** A recognized word; times are ms on the original recording. */
export type CaptionWord = { text: string; startMs: number; endMs: number };

/** A caption line on the original recording's timeline. */
export type CaptionLine = { text: string; startMs: number; endMs: number; words: CaptionWord[] };

/** A pause longer than this between two words starts a new line. */
export const CAPTION_PAUSE_MS = 400;
/** A line holds at most this many words. */
export const CAPTION_MAX_WORDS = 6;
/** A line spans at most this long (first word start to last word end). */
export const CAPTION_MAX_LINE_MS = 2500;

export type CaptionGroupOptions = {
  pauseMs?: number;
  maxWords?: number;
  maxLineMs?: number;
  /** When given, a word is never added to a line if the line would then not fit (a single word always stays). */
  fits?: (text: string) => boolean;
};

/** Group words (in time order) into caption lines. */
export function groupWordsIntoLines(
  words: CaptionWord[],
  options: CaptionGroupOptions = {},
): CaptionLine[] {
  const pauseMs = options.pauseMs ?? CAPTION_PAUSE_MS;
  const maxWords = options.maxWords ?? CAPTION_MAX_WORDS;
  const maxLineMs = options.maxLineMs ?? CAPTION_MAX_LINE_MS;

  const lines: CaptionLine[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      text: current.map((w) => w.text).join(" "),
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
      words: current,
    });
    current = [];
  };

  for (const w of words) {
    if (w.text.trim() === "") continue;
    const prev = current[current.length - 1];
    if (
      prev &&
      (w.startMs - prev.endMs > pauseMs ||
        current.length >= maxWords ||
        w.endMs - current[0]!.startMs > maxLineMs ||
        (options.fits !== undefined && !options.fits([...current.map((c) => c.text), w.text.trim()].join(" "))))
    ) {
      flush();
    }
    current.push({ text: w.text.trim(), startMs: w.startMs, endMs: w.endMs });
  }
  flush();
  return lines;
}

/**
 * Move lines onto the output timeline after cuts. Words inside cut-out time
 * are dropped; a line left with no words is dropped. Pass sourceUri when the
 * clips come from several files.
 */
export function captionLinesToOverlays(
  lines: CaptionLine[],
  clips: EditClip[],
  sourceUri?: string,
): CaptionEditOverlay[] {
  const overlays: CaptionEditOverlay[] = [];
  for (const line of lines) {
    const kept: Array<{ text: string; startMs: number; endMs: number }> = [];
    for (const w of line.words) {
      const startMs = sourceToOutputMs(clips, w.startMs, sourceUri);
      if (startMs === null) continue;
      // The end of a word is exclusive, so map its last moment and add 1ms back.
      const lastMoment = sourceToOutputMs(clips, w.endMs - 1, sourceUri);
      const endMs = lastMoment === null ? startMs + (w.endMs - w.startMs) : lastMoment + 1;
      kept.push({ text: w.text, startMs, endMs: Math.max(endMs, startMs + 1) });
    }
    if (kept.length === 0) continue;
    overlays.push({
      kind: "caption",
      text: kept.map((w) => w.text).join(" "),
      startMs: kept[0]!.startMs,
      endMs: kept[kept.length - 1]!.endMs,
    });
  }
  return overlays;
}

/** Words -> caption overlays on the output timeline. */
export function wordsToCaptionOverlays(
  words: CaptionWord[],
  clips: EditClip[],
  sourceUri?: string,
  options?: CaptionGroupOptions,
): CaptionEditOverlay[] {
  return captionLinesToOverlays(groupWordsIntoLines(words, options), clips, sourceUri);
}
