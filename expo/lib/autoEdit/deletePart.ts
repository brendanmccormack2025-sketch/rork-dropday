/**
 * Delete a part of the video from the Cuts screen, and undo a cut with one tap.
 *
 *  - With the automatic edit behind the timeline, "Delete this part" is a cut decision by the creator for that
 *    source range (addUserCut): reversible (restoreRange / undo) like every other cut.
 *  - Without it (or when the timeline has manual edits the decisions do not know about) the part is removed from
 *    the timeline, one undo step.
 *  - The last remaining part can never be deleted.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { addManualCut, keepRangesOf, type EditState } from "./decisions.ts";
import type { TimelineMarker } from "./markers.ts";
import { restoreMarker } from "./markers.ts";

export type PartClip = { id: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

export type DeletePlan =
  | { kind: "blocked"; reason: "last-part" | "unknown-part" }
  | { kind: "user-cut"; range: { startMs: number; endMs: number }; next: EditState }
  | { kind: "remove-clip"; clipId: string };

export const LAST_PART_MESSAGE = "A video needs at least one part.";

export function planDeletePart(args: {
  clips: PartClip[];
  clipId: string;
  /** The automatic edit behind the timeline, and whether the timeline still matches it. */
  model: { state: EditState; durationMs: number } | null;
  matches: boolean;
}): DeletePlan {
  const clip = args.clips.find((c) => c.id === args.clipId);
  if (!clip) return { kind: "blocked", reason: "unknown-part" };
  if (args.clips.length <= 1) return { kind: "blocked", reason: "last-part" };
  if (args.model && args.matches) {
    const startMs = clip.trimStartMs ?? 0;
    const endMs = clip.trimEndMs ?? clip.durationMs ?? 0;
    if (endMs > startMs) {
      const next = addManualCut(args.model.state, startMs, endMs);
      if (keepRangesOf(next, args.model.durationMs).length === 0) return { kind: "blocked", reason: "last-part" };
      return { kind: "user-cut", range: { startMs, endMs }, next };
    }
  }
  return { kind: "remove-clip", clipId: args.clipId };
}

/** The one-tap action a timeline marker offers: only a red cut marker can be undone. */
export function markerAction(marker: Pick<TimelineMarker, "kind"> | null): { label: string } | null {
  return marker?.kind === "cut" ? { label: "Undo this cut" } : null;
}

/** "Undo this cut": the footage the marker covers comes back (every cut overlapping it is reverted). */
export function undoThisCut(state: EditState, marker: TimelineMarker): EditState {
  return restoreMarker(state, marker);
}
