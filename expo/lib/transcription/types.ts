/** One recognized word; times are ms on the clip it came from. */
export type Word = { text: string; startMs: number; endMs: number; confidence?: number };

export type TranscriptResult =
  | { status: "ok"; words: Word[] }
  | { status: "unavailable" | "denied" | "error"; message?: string; /** The native ERR_SPEECH_* code, or one of ours. */ code?: string };

/** What the debug view shows about the transcription of this clip. */
export type TranscriptionInfo = {
  /** skipped: nothing was asked (not one local video, or the creator said "Not now"). */
  status: "ok" | "unavailable" | "denied" | "error" | "skipped";
  code?: string;
  message?: string;
  wordCount: number;
  fromCache: boolean;
  /** The analysis cache key (uri | size | mtime), or null when the file could not be stated. */
  key: string | null;
};
