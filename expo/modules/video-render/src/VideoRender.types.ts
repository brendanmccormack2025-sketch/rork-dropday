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
};

export type RenderResult = {
  /** file:// URI of the finished mp4 in the cache directory. */
  uri: string;
  durationMs: number;
  sizeBytes: number;
};

export type RenderProgressEvent = {
  /** 0 to 1. */
  progress: number;
};
