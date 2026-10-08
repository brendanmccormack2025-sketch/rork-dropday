/**
 * The editor's three steps, and where each button goes. All of them are screens of the same component, so
 * going back and forth never touches the edit (clips, cuts, captions, text overlays, undo history).
 *
 *   cuts  : the timeline and the Cuts panel (reviewing the automatic cuts). "Done" -> edit.
 *   edit  : full-screen, on the video (text, captions, style). "Next" -> post. "Cuts" -> cuts.
 *   post  : thumbnail, the Trial line, mature, save to camera roll, Save Draft, Post. Back -> edit.
 *
 * Pure: no React, no native modules.
 */
export type EditorStep = "cuts" | "edit" | "post";

/** Drafts reopen in the full-screen editor; so does anything that is not a video (there is nothing to cut). */
export function initialStep(args: { isDraft: boolean; isVideo: boolean }): EditorStep {
  if (args.isDraft || !args.isVideo) return "edit";
  return "cuts";
}

export function nextStep(step: EditorStep): EditorStep {
  return step === "cuts" ? "edit" : "post";
}

/** What Back does. "exit" leaves the editor. */
export function backStep(step: EditorStep, args: { isVideo: boolean }): EditorStep | "exit" {
  if (step === "post") return "edit";
  if (step === "edit") return args.isVideo ? "cuts" : "exit";
  return "exit";
}

/** The "Cuts" tool of the full-screen editor. */
export function cutsStep(args: { isVideo: boolean }): EditorStep | null {
  return args.isVideo ? "cuts" : null;
}

/** The selected-item bar goes to the top when the item is in the lower half, so it never covers the item. */
export function selectionBarSide(itemYFraction: number): "top" | "bottom" {
  return itemYFraction > 0.55 ? "top" : "bottom";
}

/** What shows in each step. */
export function stepLayout(step: EditorStep) {
  return {
    timeline: step === "cuts",
    cutsPanel: step === "cuts",
    fullScreenVideo: step === "edit",
    editTools: step === "edit",
    postForm: step === "post",
    touchOverlays: step === "edit",
    guides: step === "edit",
  };
}
