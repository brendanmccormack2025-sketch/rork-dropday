/**
 * "No cuts" playback: when no cut is active (Keep original, or every cut category off) the timeline is just the
 * source file, so the editor plays that file directly. No preview is rendered for it and the editor never waits for
 * one ("Making preview"). Also the one place that decides what happens to playback when the rendered preview is
 * left, so an edit that already seeks and resumes by itself is not seeked and resumed a second time.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { effectiveCutRanges, type EditState } from "./decisions.ts";

type ClipLike = { uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

/** How far from the ends a clip may be and still count as the whole source (audio and video lengths differ a little). */
export const WHOLE_SOURCE_TOLERANCE_MS = 400;

/**
 * True when the timeline is the model's source file played in full and no cut is active: nothing to render, play the
 * source directly.
 */
export function isPlayingWholeSource(clips: ReadonlyArray<ClipLike>, state: EditState | null | undefined, durationMs: number): boolean {
  if (!state || clips.length !== 1) return false;
  const clip = clips[0]!;
  if (clip.uri !== state.sourceUri) return false;
  if (effectiveCutRanges(state).length > 0) return false;
  const start = clip.trimStartMs ?? 0;
  const end = clip.trimEndMs && clip.trimEndMs > 0 ? clip.trimEndMs : (clip.durationMs ?? durationMs);
  return start <= WHOLE_SOURCE_TOLERANCE_MS && end >= durationMs - WHOLE_SOURCE_TOLERANCE_MS;
}

/**
 * Leaving the rendered preview (an edit changed the clips): seek the live player and restore the play state, unless
 * the edit itself is already doing exactly that (commitDecisions), in which case this does nothing.
 */
export function exitPreviewPlan(args: { commitInFlight: boolean; isPlaying: boolean }): { seek: boolean; resumeTo: boolean | null } {
  if (args.commitInFlight) return { seek: false, resumeTo: null };
  return { seek: true, resumeTo: args.isPlaying };
}
