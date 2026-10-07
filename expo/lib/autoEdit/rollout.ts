/**
 * Who gets which part of the AI editor. The editor itself (transcription, captions and their controls,
 * hook trim, every um cut, laugh protection, the AI edits panel, cut markers) is for EVERY user; the debug
 * view and emphasis proposals stay with the owner.
 *
 * A reaction is not rendered at post time (so captions could not be burned in): its editor gets the silence
 * cuts only, as before.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { isDebugOwner } from "../../constants/debug.ts";

/** Captions are on for every new edit; the creator can switch them off. */
export const CAPTIONS_ON_BY_DEFAULT = true;

export type AiEditorFeatures = {
  /** On-device transcription (after the speech explainer and the system permission). */
  transcription: boolean;
  captions: boolean;
  /** Move, resize, edit text, delete a line, reset. */
  captionControls: boolean;
  hookTrim: boolean;
  /** Method 1 fillers, method 2 ums, stretched-word and word-adjacent ums. */
  umCuts: boolean;
  laughProtection: boolean;
  aiEditsPanel: boolean;
  cutMarkers: boolean;
  /** Owner only: emphasis / filler debug markers, Share AI debug, Clear analysis cache, "Cut this sound". */
  debugView: boolean;
  /** Owner only: emphasis (zoom) proposals. */
  emphasis: boolean;
};

export function aiEditorFeatures(args: { userId: string | null | undefined; isRootPost: boolean }): AiEditorFeatures {
  const owner = isDebugOwner(args.userId);
  const root = args.isRootPost;
  return {
    transcription: root,
    captions: root,
    captionControls: root,
    hookTrim: root,
    umCuts: root,
    laughProtection: root,
    aiEditsPanel: true,
    cutMarkers: true,
    debugView: owner,
    emphasis: owner,
  };
}
