/** One recognized word; times are ms on the clip it came from. */
export type Word = { text: string; startMs: number; endMs: number; confidence?: number };

/** What dedupeWords did with one repeated run of words, and why. */
export type DedupeDecision = {
  outcome: "removed" | "kept";
  /** The repeated words, joined. */
  text: string;
  wordCount: number;
  /** Where each copy starts (ms on the source). */
  earlierStartMs: number;
  laterStartMs: number;
  reason: string;
};

/** Words dropped as duplicates, how many, and every decision about a repeated run. */
export type DedupeRemoved = {
  repeatedWords: number;
  overlappingWords: number;
  /** The dropped words themselves (times on the source): nothing may be cut where one was. */
  words?: Word[];
  decisions?: DedupeDecision[];
};

export type TranscriptResult =
  | { status: "ok"; words: Word[]; /** Words dropped as duplicates by dedupeWords. */ removed?: DedupeRemoved }
  | { status: "unavailable" | "denied" | "error"; message?: string; /** The native ERR_SPEECH_* code, or one of ours. */ code?: string };

/** What the debug view shows about the transcription of this clip. */
export type TranscriptionInfo = {
  /** skipped: nothing was asked (not one local video, or the creator said "Not now"). */
  status: "ok" | "unavailable" | "denied" | "error" | "skipped";
  code?: string;
  message?: string;
  wordCount: number;
  /** Words removed as repeats / overlaps right after transcription. */
  repeatedWordsRemoved?: number;
  overlappingWordsRemoved?: number;
  /** What dedupe decided about each repeated run (kept or removed, and why). */
  dedupeDecisions?: DedupeDecision[];
  fromCache: boolean;
  /** The analysis cache key (uri | size | mtime), or null when the file could not be stated. */
  key: string | null;
};
