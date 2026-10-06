/**
 * Guard for AI-edit actions: when the timeline has manual edits the EditState does
 * not contain, an action would replace them, so the creator must confirm first.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { renderClipsOf, type EditState } from "./decisions.ts";

export const MANUAL_EDIT_CONFIRM_MESSAGE = "This will replace your manual edits with the AI edit. Continue?";

type ClipRange = { uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

/** True when the clips play exactly what the state renders (edges within tolMs). */
export function timelineMatchesState(
  clips: ClipRange[],
  state: EditState,
  sourceDurationMs: number,
  tolMs = 60,
): boolean {
  const expected = renderClipsOf(state, sourceDurationMs);
  if (clips.length !== expected.length) return false;
  return clips.every((c, i) => {
    const start = c.trimStartMs ?? 0;
    const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? sourceDurationMs);
    return (
      c.uri === expected[i]!.uri &&
      Math.abs(start - expected[i]!.trimStartMs) <= tolMs &&
      Math.abs(end - expected[i]!.trimEndMs) <= tolMs
    );
  });
}

/**
 * Run `apply` now when the timeline matches the model; otherwise ask first.
 * `ask` shows the dialog and calls `onContinue` only if the creator confirms;
 * Cancel never calls it, so nothing changes.
 */
export function guardManualEdits(
  timelineMatches: boolean,
  ask: (onContinue: () => void) => void,
  apply: () => void,
): void {
  if (timelineMatches) apply();
  else ask(apply);
}
