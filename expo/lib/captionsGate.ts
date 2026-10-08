/**
 * When the editor may start transcribing (captions, ums, hook trim all come from the transcript).
 *
 * Transcription waits for the merge (several camera runs become one file) and for the silence-cut step of the
 * same file. A step that never finishes must not hold the transcript back forever, so the editor marks the
 * auto edit "stalled" after a while (and logs it); a stalled step no longer blocks.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

/** How long the silence-cut step may take before it stops blocking the transcript. */
export const AUTO_EDIT_STALL_MS = 45_000;

export type GateInput = {
  merge: "idle" | "merging" | "failed";
  /** The timeline is one untrimmed video, so the silence-cut step applies. */
  autoEditPossible: boolean;
  autoEditRunning: boolean;
  autoEditFinished: boolean;
  autoEditStalled: boolean;
};

export type Gate = { ready: boolean; waitingFor: "the merge" | "the silence-cut step" | null };

export function transcriptionGate(g: GateInput): Gate {
  if (g.merge !== "idle") return { ready: false, waitingFor: "the merge" };
  if (g.autoEditStalled) return { ready: true, waitingFor: null };
  if (g.autoEditRunning) return { ready: false, waitingFor: "the silence-cut step" };
  if (g.autoEditPossible && !g.autoEditFinished) return { ready: false, waitingFor: "the silence-cut step" };
  return { ready: true, waitingFor: null };
}
