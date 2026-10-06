/** One recognized word; times are ms on the clip it came from. */
export type Word = { text: string; startMs: number; endMs: number; confidence?: number };

export type TranscriptResult =
  | { status: "ok"; words: Word[] }
  | { status: "unavailable" | "denied" | "error"; message?: string };
