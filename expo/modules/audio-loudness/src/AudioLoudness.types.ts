export type LoudnessResult = {
  /** Duration of the whole asset in milliseconds. */
  durationMs: number;
  /**
   * RMS loudness in dBFS, one value per window. Window i covers
   * [i * windowMs, (i + 1) * windowMs). Digital silence is -100.
   */
  windows: number[];
};
