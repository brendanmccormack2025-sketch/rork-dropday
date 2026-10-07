/**
 * Captions for a timeline made of several source files.
 *
 * Each source file is transcribed on its own (see useCaptions: one after the other, each cached
 * per file); the words are put in one list, and every word remembers its file. The clips of the
 * timeline then say where on the output timeline each word lands.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { Word } from "./types.ts";

/** One clip of the timeline: a kept range of one source file. */
export type ClipRange = { uri: string; startMs: number; endMs: number };

export type SourceWords = { uri: string; words: Word[] };

/** The words of all sources in one list (source order), and the file of each word. */
export function combineSources(parts: SourceWords[]): { words: Word[]; wordUris: string[] } {
  const words: Word[] = [];
  const wordUris: string[] = [];
  for (const p of parts) {
    for (const w of p.words) {
      words.push(w);
      wordUris.push(p.uri);
    }
  }
  return { words, wordUris };
}

/** The distinct source files of a timeline, in order of first use. */
export function distinctSources(clips: Array<{ uri: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of clips) {
    if (!seen.has(c.uri)) {
      seen.add(c.uri);
      out.push(c.uri);
    }
  }
  return out;
}

/**
 * Words (times on their own source file) -> words on the output timeline. A word belongs to the
 * clips of ITS file only; it is kept when at least half of it lies in one clip, and is then clamped
 * to that clip's edges (the same rule as mapWordsToEdit for one source). The output offset of a clip
 * is the total length of the clips before it, whichever file they come from. Any other fields on a
 * word are kept; the result is in output order.
 */
export function mapWordsToClips<T extends Word>(words: Array<T & { uri: string }>, clips: ClipRange[]): T[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const c of clips) {
    offsets.push(offset);
    offset += Math.max(0, c.endMs - c.startMs);
  }
  const out: Array<{ word: T; outputStartMs: number }> = [];
  for (const w of words) {
    const duration = w.endMs - w.startMs;
    let best = -1;
    let bestOverlap = -1;
    clips.forEach((c, i) => {
      if (c.uri !== w.uri || c.endMs <= c.startMs) return;
      const overlap = Math.min(w.endMs, c.endMs) - Math.max(w.startMs, c.startMs);
      if (overlap > bestOverlap) {
        best = i;
        bestOverlap = overlap;
      }
    });
    if (best < 0) continue;
    const clip = clips[best]!;
    const keep = duration > 0 ? bestOverlap >= duration * 0.5 : w.startMs >= clip.startMs && w.startMs <= clip.endMs;
    if (!keep) continue;
    const shift = offsets[best]! - clip.startMs;
    const startMs = Math.max(w.startMs, clip.startMs) + shift;
    const endMs = Math.min(Math.max(w.endMs, w.startMs), clip.endMs) + shift;
    const { uri: _uri, ...rest } = w as T & { uri: string };
    out.push({ word: { ...(rest as unknown as T), startMs, endMs: Math.max(endMs, startMs) }, outputStartMs: startMs });
  }
  out.sort((a, b) => a.outputStartMs - b.outputStartMs);
  return out.map((o) => o.word);
}
