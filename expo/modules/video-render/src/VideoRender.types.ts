export type RenderOptions = {
  /** Output width in pixels. Default 1080. */
  width?: number;
  /** Output height in pixels. Default 1920. */
  height?: number;
  /** 'fill' = aspect-fill centre crop (default), 'fit' = letterbox. */
  reframe?: "fill" | "fit";
  /**
   * Advisory only: AVAssetExportSession cannot enforce a bitrate. The export
   * preset follows the size (1280x720 preset when width <= 720, otherwise the
   * highest quality). Check the real bitrate (size * 8 / duration) of the result.
   * Default 8_000_000.
   */
  bitrate?: number;
  /** Scale 108% on every second segment to hide jump cuts. Default false. */
  punchIn?: boolean;
  /** A 20 ms audio dip at every join. Default true; a plain merge sets false (build 1.0.4; older builds ignore it). */
  seamFades?: boolean;
};

/** Track timing of a file in movie time; -1 = no such track. */
export type TimingProbe = {
  durationMs: number;
  videoStartMs: number;
  videoDurationMs: number;
  audioStartMs: number;
  audioDurationMs: number;
  /** Non-empty segments of the first video / audio track (a merged file has one per clip). Absent before the build that added them; -1 = no such track. */
  videoSegments?: number;
  audioSegments?: number;
};

/** One clip of a render as the renderer placed it (build after 1.0.6; absent before). */
export type RenderPart = {
  index: number;
  compStartMs: number;
  durationMs: number;
  naturalWidth: number;
  naturalHeight: number;
  /** The file's own orientation matrix [a, b, c, d, tx, ty] and the matrix the renderer applied (rotation, mirroring, fit). */
  preferredTransform: number[];
  appliedTransform: number[];
  rotationDeg: number;
  mirrored: boolean;
  hasAudio: boolean;
  /** How much of this clip's picture and sound really went into the composition. */
  videoInsertedMs: number;
  audioInsertedMs: number;
};

export type RenderResult = {
  /** file:// URI of the finished mp4 in the cache directory. */
  uri: string;
  /** Expected duration: the length of the edit. */
  durationMs: number;
  /** Duration of the written file, read back (within 150 ms of durationMs or the render fails). */
  actualDurationMs: number;
  sizeBytes: number;
  /** Per clip, as placed (newer builds only). */
  parts?: RenderPart[];
  /** Non-empty segments in the composition's video / audio track (one per clip when every clip went in). */
  videoSegments?: number;
  audioSegments?: number;
};

export type RenderProgressEvent = {
  /** 0 to 1. */
  progress: number;
};
