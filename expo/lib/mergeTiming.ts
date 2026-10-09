/**
 * Merged files: is the audio on the same clock as the video, and does the analysis match the video?
 *
 * Silence cuts come from the loudness of the audio track and are applied to the video timeline, so for a merged
 * file the audio must start with the video, nothing may be dropped or added at the joins, and the loudness array
 * must be as long as the video. These pure helpers measure that from the native timing probe and the loudness
 * result, so a mismatch is logged (client_errors) instead of silently cutting in the wrong places.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

/** Track timing of a file in movie time (ms); -1 = no such track. Same shape as the native probe. */
export type TrackTiming = {
  durationMs: number;
  videoStartMs: number;
  videoDurationMs: number;
  audioStartMs: number;
  audioDurationMs: number;
};

/** Loudness and video may differ by this much before the analysis is not trusted. */
export const ALIGN_TOLERANCE_MS = 100;
/** The merged length may differ from the sum of the parts by this much per join (frame rounding). */
export const JOIN_TOLERANCE_MS = 50;

export type MergeTimingReport = {
  /** Sum of the source clips' durations (ms), or null when a source could not be probed. */
  sourceSumMs: number | null;
  mergedDurationMs: number;
  mergedVideoMs: number;
  mergedAudioMs: number;
  /** audio start minus video start in the merged file (ms). */
  audioOffsetMs: number;
  /** merged length minus the sum of the sources (ms), or null. */
  lengthDiffMs: number | null;
  /** Per source: its own audio offset (ms), to see which part is off. */
  sourceAudioOffsetsMs: Array<number | null>;
  /** Per source: its movie length (ms), in order; null when it could not be probed. */
  sourceDurationsMs: Array<number | null>;
  issues: string[];
};

/** Compare the merged file with the parts it was made from. */
export function mergeTimingReport(sources: Array<TrackTiming | null>, merged: TrackTiming | null, joinCount: number): MergeTimingReport | null {
  if (!merged) return null;
  const known = sources.every((s) => s && s.durationMs > 0);
  const sourceSumMs = known ? sources.reduce((n, s) => n + s!.durationMs, 0) : null;
  const audioOffsetMs = merged.audioStartMs >= 0 && merged.videoStartMs >= 0 ? merged.audioStartMs - merged.videoStartMs : 0;
  const lengthDiffMs = sourceSumMs === null ? null : merged.durationMs - sourceSumMs;
  const issues: string[] = [];
  if (Math.abs(audioOffsetMs) > 40) issues.push(`audio starts ${audioOffsetMs} ms after the video`);
  if (lengthDiffMs !== null && Math.abs(lengthDiffMs) > ALIGN_TOLERANCE_MS + joinCount * JOIN_TOLERANCE_MS) {
    issues.push(`merged length is ${lengthDiffMs} ms off the sum of the parts`);
  }
  if (merged.audioDurationMs >= 0 && merged.videoDurationMs >= 0 && Math.abs(merged.audioDurationMs - merged.videoDurationMs) > ALIGN_TOLERANCE_MS) {
    issues.push(`audio is ${merged.audioDurationMs - merged.videoDurationMs} ms longer than the video`);
  }
  return {
    sourceSumMs,
    mergedDurationMs: merged.durationMs,
    mergedVideoMs: merged.videoDurationMs,
    mergedAudioMs: merged.audioDurationMs,
    audioOffsetMs,
    lengthDiffMs,
    sourceDurationsMs: sources.map((s) => (s && s.durationMs > 0 ? s.durationMs : null)),
    sourceAudioOffsetsMs: sources.map((s) => (s && s.audioStartMs >= 0 && s.videoStartMs >= 0 ? s.audioStartMs - s.videoStartMs : null)),
    issues,
  };
}

export type LoudnessLike = { durationMs: number; windows: number[] };

/** Does the loudness array cover the video? (length in ms vs video duration, and the file duration it reports) */
export function loudnessAgrees(
  loud: LoudnessLike,
  videoDurationMs: number,
  windowMs: number,
  toleranceMs = ALIGN_TOLERANCE_MS,
): { ok: boolean; arrayMs: number; diffMs: number } {
  const arrayMs = loud.windows.length * windowMs;
  const diffMs = Math.max(Math.abs(arrayMs - videoDurationMs), Math.abs(loud.durationMs - videoDurationMs));
  return { ok: diffMs <= toleranceMs, arrayMs, diffMs };
}

/**
 * Loudness for a source, checked against the video's duration. A disagreement of more than the tolerance is
 * reported once and the analysis is run again from scratch (cache cleared); the second result is used either way.
 */
export async function loadLoudnessChecked<T extends LoudnessLike>(args: {
  uri: string;
  load: (uri: string) => Promise<T | null>;
  clear: (uri: string) => Promise<unknown>;
  videoDurationMs: number;
  windowMs: number;
  report: (info: { uri: string; videoDurationMs: number; arrayMs: number; fileMs: number; diffMs: number; attempt: number }) => void;
}): Promise<T | null> {
  const first = await args.load(args.uri);
  if (!first || !(args.videoDurationMs > 0)) return first;
  const a = loudnessAgrees(first, args.videoDurationMs, args.windowMs);
  if (a.ok) return first;
  args.report({ uri: args.uri, videoDurationMs: args.videoDurationMs, arrayMs: a.arrayMs, fileMs: first.durationMs, diffMs: a.diffMs, attempt: 1 });
  await args.clear(args.uri).catch(() => null);
  const second = await args.load(args.uri);
  if (second) {
    const b = loudnessAgrees(second, args.videoDurationMs, args.windowMs);
    if (!b.ok) args.report({ uri: args.uri, videoDurationMs: args.videoDurationMs, arrayMs: b.arrayMs, fileMs: second.durationMs, diffMs: b.diffMs, attempt: 2 });
  }
  return second ?? first;
}

export type AnalysisMergeState = "idle" | "merging" | "failed";

/**
 * Which file the analysis (loudness, transcript, silence cuts) may run on, or null for "not yet". After a merge it
 * is the merged file and nothing else: not while merging, not after a failed merge, not before the merged clip
 * (a finished file with a verified length) has replaced the parts.
 */
export function analysisSource(args: {
  merge: AnalysisMergeState;
  /** The merge's result when there was one: its uri and the length the render reported. */
  merged: { uri: string; durationMs: number } | null;
  clips: Array<{ uri: string; type: string; durationMs?: number }>;
}): string | null {
  if (args.merge !== "idle") return null;
  if (args.clips.length !== 1) return null;
  const clip = args.clips[0]!;
  if (clip.type !== "video") return null;
  if (args.merged) {
    if (clip.uri !== args.merged.uri) return null;
    if (!(args.merged.durationMs > 0) || !(clip.durationMs && clip.durationMs > 0)) return null;
  }
  return clip.uri;
}
