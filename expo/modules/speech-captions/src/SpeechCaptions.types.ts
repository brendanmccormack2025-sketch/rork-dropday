export type TranscribedWord = {
  text: string;
  /** Milliseconds from the start of the video. */
  startMs: number;
  endMs: number;
  /** 0 to 1; 0 when the recognizer did not report one. */
  confidence: number;
};

export type TranscriptionResult = {
  words: TranscribedWord[];
  durationMs: number;
  /** Locale identifier the recognizer actually used. */
  locale: string;
  /** Always true when a result is returned: server recognition is never used. */
  onDevice: boolean;
};
