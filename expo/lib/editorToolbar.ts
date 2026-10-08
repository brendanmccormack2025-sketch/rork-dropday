/**
 * The editor's bottom toolbar is contextual: with a caption selected it becomes the caption toolbar
 * (nothing floats over the video); otherwise the main toolbar (Trim, Split, Text, Captions, Cuts, Delete).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
export type ToolbarMode = "main" | "caption";

/** The Cuts screen's toolbar (the timeline's tools). There is no Delete tool (a clip is removed by trimming or cutting it). */
export const CUTS_TOOL_IDS = ["trim", "split"] as const;

/** The slim tool column of the full-screen editor, top to bottom ("cuts" returns to the Cuts screen). */
export const EDITOR_TOOL_IDS = ["text", "captions", "style", "cuts"] as const;

/** Every tool of the editor across its screens. */
export const MAIN_TOOL_IDS = [...CUTS_TOOL_IDS, ...EDITOR_TOOL_IDS] as const;

export type CaptionToolId = "edit" | "style" | "deleteLine" | "done";

/** In this order, each a 44 pt target; four of them fit the narrowest iPhone (375 pt) with room to spare. */
export const CAPTION_TOOLS: Array<{ id: CaptionToolId; label: string }> = [
  { id: "edit", label: "Edit" },
  { id: "style", label: "Style" },
  { id: "deleteLine", label: "Delete line" },
  { id: "done", label: "Done" },
];

export const MIN_TOOL_TARGET_PT = 44;

export function toolbarMode(state: { captionSelected: boolean; captionsOn: boolean; hasLines: boolean }): ToolbarMode {
  return state.captionSelected && state.captionsOn && state.hasLines ? "caption" : "main";
}

/** Width of each of n equal buttons across a toolbar of this width with side padding. */
export function toolWidth(screenWidth: number, count: number, sidePadding = 16): number {
  return (screenWidth - 2 * sidePadding) / count;
}
