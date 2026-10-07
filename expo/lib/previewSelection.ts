/**
 * Selecting a clip on the timeline while the rendered file is the preview.
 *
 * Selection is not an edit: it must neither leave rendered-preview mode (which unloads the
 * rendered file and starts the live multi-clip players, a glitch) nor touch the render. It
 * only moves the playhead to the clip's start on the output timeline. An actual edit (a trim,
 * a cut) changes the clips, so the render stops matching and the preview falls back to live
 * playback by itself.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { DraftClip } from "../providers/PostsProvider.ts";

/** Rendered preview plays when the render matches the timeline; the selected clip does not matter. */
export function previewModeFor(state: { aheadMatches: boolean; selectedClipId: string | null }): boolean {
  return state.aheadMatches;
}

/** Where a clip starts on the output timeline: the sum of the effective durations before it, or null. */
export function clipOutputStartMs(
  clips: Array<Pick<DraftClip, "id">>,
  clipId: string,
  durationOf: (clip: any) => number,
): number | null {
  let start = 0;
  for (const clip of clips) {
    if (clip.id === clipId) return start;
    start += durationOf(clip);
  }
  return null;
}

export type SelectionSeek =
  | { kind: "rendered"; outputMs: number }
  | { kind: "live"; index: number; outputMs: number; sourceMs: number };

/**
 * What selecting a clip does to playback. Rendered preview: seek the rendered file to the clip's
 * output start, nothing else. Live playback: switch the live player to that clip at its trim start
 * (unless it is already the active one).
 */
export function planSelectionSeek(args: {
  clips: DraftClip[];
  clipId: string;
  activeIndex: number;
  previewMode: boolean;
  durationOf: (clip: any) => number;
}): SelectionSeek | null {
  const index = args.clips.findIndex((c) => c.id === args.clipId);
  if (index < 0) return null;
  const outputMs = clipOutputStartMs(args.clips, args.clipId, args.durationOf)!;
  if (args.previewMode) return { kind: "rendered", outputMs };
  if (index === args.activeIndex) return null;
  return { kind: "live", index, outputMs, sourceMs: args.clips[index]!.trimStartMs ?? 0 };
}
