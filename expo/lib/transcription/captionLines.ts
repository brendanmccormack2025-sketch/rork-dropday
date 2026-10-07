/**
 * Transcript words -> caption lines on the edited timeline, with user edits.
 *
 * Pure: no React, no native modules. Erasable TypeScript only so
 * scripts/test-transcription.mjs can run it with Node's type stripping.
 */
import { groupWordsIntoLines } from "../captions.ts";
import { applyCaptionStyle, resolveOverlayStyle } from "../editStyles.ts";
import { lineFits } from "./captionFit.ts";
import type { CaptionEditOverlay, CaptionStyle, KeepRange } from "../editModel.ts";
import { mapWordsToEdit } from "./mapWords.ts";
import { mapWordsToClips, type ClipRange } from "./multiSource.ts";
import type { Word } from "./types.ts";

/** At most 3 words and 1.5 s per line; a pause longer than 400 ms starts a new line. */
export const CAPTION_LINE_OPTIONS = { maxWords: 3, maxLineMs: 1500, pauseMs: 400 };
/** The one caption style (see CAPTION_STYLES in editStyles.ts). */
export const CAPTION_STYLE_ID = "trial";

/**
 * User edits, keyed by the index of the word in the SOURCE transcript (not by line),
 * so they survive when cuts change. An empty string deletes the word.
 */
export type WordEdits = Record<number, string>;

/** A caption line on the edited timeline, and the source words it was made from. */
export type EditorCaptionLine = {
  text: string;
  startMs: number;
  endMs: number;
  srcIndexes: number[];
};

export function buildCaptionLines(
  words: Word[],
  edits: WordEdits,
  keptRanges: KeepRange[],
  /** The clip-wide caption box: a larger scale means narrower lines (fewer words fit). */
  style?: CaptionStyle | null,
  /** A timeline of several source files: the file of each word, and the clips (see multiSource.ts). */
  multi?: { wordUris: string[]; clips: ClipRange[] },
): EditorCaptionLine[] {
  const indexed: Array<Word & { srcIndex: number; uri?: string }> = [];
  words.forEach((w, srcIndex) => {
    const text = edits[srcIndex] ?? w.text;
    if (text.trim() === "") return;
    indexed.push({ ...w, text, srcIndex, ...(multi ? { uri: multi.wordUris[srcIndex]! } : {}) });
  });
  const mapped = multi
    ? mapWordsToClips(indexed as Array<Word & { srcIndex: number; uri: string }>, multi.clips)
    : mapWordsToEdit(indexed, keptRanges);
  const preset = resolveOverlayStyle("caption", CAPTION_STYLE_ID);
  const spec = style ? applyCaptionStyle(preset, style) : preset;
  const lines = groupWordsIntoLines(mapped, { ...CAPTION_LINE_OPTIONS, fits: (text) => lineFits(text, spec) });
  // The grouper keeps word order and skips none of these words (blanks were removed above).
  let n = 0;
  const built = lines.map((l) => ({
    text: l.text,
    startMs: l.startMs,
    endMs: l.endMs,
    srcIndexes: l.words.map(() => mapped[n++]!.srcIndex),
  }));
  // One caption at a time: a line ends when the next one starts.
  for (let i = 0; i + 1 < built.length; i++) {
    const next = built[i + 1]!;
    if (built[i]!.endMs > next.startMs) built[i]!.endMs = Math.max(built[i]!.startMs, next.startMs);
  }
  return built.filter((l) => l.endMs > l.startMs);
}

export function captionLinesToEditOverlays(lines: EditorCaptionLine[], style?: CaptionStyle | null): CaptionEditOverlay[] {
  return lines.map((l) => ({
    kind: "caption" as const,
    text: l.text,
    startMs: l.startMs,
    endMs: l.endMs,
    style: CAPTION_STYLE_ID,
    ...(style ? { captionStyle: style } : {}),
  }));
}

/**
 * The user typed `newText` for a line. The typed words replace the line's source
 * words one for one; extra typed words join the last source word, and source words
 * left over are deleted. Words whose text matches the transcript lose their edit.
 */
export function applyLineEdit(
  words: Word[],
  edits: WordEdits,
  line: EditorCaptionLine,
  newText: string,
): WordEdits {
  const tokens = newText.trim().split(/\s+/).filter(Boolean);
  const next: WordEdits = { ...edits };
  const n = line.srcIndexes.length;
  line.srcIndexes.forEach((srcIndex, k) => {
    const text = k >= tokens.length ? "" : k === n - 1 ? tokens.slice(k).join(" ") : tokens[k]!;
    if (text === words[srcIndex]?.text.trim()) delete next[srcIndex];
    else next[srcIndex] = text;
  });
  return next;
}
