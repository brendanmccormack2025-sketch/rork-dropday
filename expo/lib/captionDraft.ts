/**
 * The draft of a caption line being edited from the video (the bar above the keyboard). Pure; erasable TypeScript only so the
 * Node tests can run it. Done saves the line, Back discards it; a draft is never saved twice.
 */
export type CaptionDraft = { index: number; text: string };

export const startCaptionDraft = (index: number, text: string): CaptionDraft => ({ index, text });

export const changeCaptionDraft = (draft: CaptionDraft | null, text: string): CaptionDraft | null => (draft ? { ...draft, text } : draft);

/** Done: the draft closes and the line to save (null when there was no draft, so nothing is saved twice). */
export function finishCaptionDraft(draft: CaptionDraft | null): { draft: null; save: CaptionDraft | null } {
  return { draft: null, save: draft ? { index: draft.index, text: draft.text } : null };
}

/** Back: the draft closes and nothing is saved. */
export function discardCaptionDraft(): { draft: null; save: null } {
  return { draft: null, save: null };
}
