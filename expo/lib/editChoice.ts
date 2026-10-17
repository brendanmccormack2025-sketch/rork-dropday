/**
 * The choice made BEFORE the editor starts anything: keep the video as it is, the automatic edit, or a custom set of
 * edits. The editor (app/edit.tsx) reads it from its `edit` param and runs only what was chosen:
 *   silence  -> the silence-cut step (lib/ai/autoEdit.ts)
 *   cleanup  -> ums, filler words and a slow start, planned from the transcript (hook trim, filler / um cuts)
 *   captions -> captions shown on the video (from the same on-device transcript)
 * Transcription (on-device speech recognition) runs for any chosen edit (pause removal uses its word timings too).
 * Every edit stays non-destructive: cuts are instructions on the untouched source file, and the editor's own
 * "Keep original" / undo, or going back to the choice screen, returns to the source.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type EditMode = "original" | "auto" | "custom";

export type EditChoice = {
  mode: EditMode;
  silence: boolean;
  cleanup: boolean;
  captions: boolean;
  /** false: the editor was opened without a choice (draft, reaction, older link) and behaves as before. */
  explicit: boolean;
};

export type EditFeature = "silence" | "cleanup" | "captions";

/** The features offered under Customize, in order, with what each does (shown on the screen). */
export const EDIT_FEATURES: ReadonlyArray<{ key: EditFeature; title: string; body: string }> = [
  { key: "silence", title: "Remove pauses", body: "Cuts the silent gaps between what you say." },
  { key: "cleanup", title: "Trim ums and a slow start", body: "Cuts filler sounds like um and uh, and dead time before you start talking." },
  { key: "captions", title: "Captions", body: "Adds captions of what you say. You can edit or turn them off later." },
];

export const EDIT_OPTIONS: ReadonlyArray<{ mode: EditMode; title: string; body: string }> = [
  { mode: "original", title: "Keep original", body: "Your video exactly as you recorded it. No cuts, no captions. You can still add text and trim it yourself." },
  { mode: "auto", title: "AI edit my video", body: "Removes pauses, trims ums and a slow start, and adds captions. Everything is a suggestion you can undo." },
  { mode: "custom", title: "Customize my edit", body: "Pick which edits to apply." },
];

/** The edits each mode applies. `autoSilence` is the "Auto-edit my videos" setting (pause removal), on by default. */
export function choiceFor(mode: EditMode, custom?: Partial<Record<EditFeature, boolean>>, autoSilence = true): EditChoice {
  if (mode === "original") return { mode, silence: false, cleanup: false, captions: false, explicit: true };
  if (mode === "auto") return { mode, silence: autoSilence, cleanup: true, captions: true, explicit: true };
  return {
    mode,
    silence: custom?.silence ?? true,
    cleanup: custom?.cleanup ?? true,
    captions: custom?.captions ?? true,
    explicit: true,
  };
}

/** Before this screen existed: everything automatic (pause removal still follows the setting, checked by the editor). */
export const LEGACY_CHOICE: EditChoice = { mode: "auto", silence: true, cleanup: true, captions: true, explicit: false };

/** The editor's `edit` param, e.g. "original", "auto" or "custom:silence,captions". */
export function encodeEditChoice(c: EditChoice): string {
  if (c.mode !== "custom") return c.mode === "auto" ? `auto${c.silence ? "" : ":nosilence"}` : c.mode;
  const on = (["silence", "cleanup", "captions"] as const).filter((k) => c[k]);
  return `custom:${on.join(",")}`;
}

/** Reads the `edit` param. Missing or unreadable: the old behaviour (LEGACY_CHOICE). */
export function parseEditChoice(raw: string | string[] | null | undefined): EditChoice {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return LEGACY_CHOICE;
  if (s === "original") return choiceFor("original");
  if (s === "auto") return choiceFor("auto");
  if (s === "auto:nosilence") return choiceFor("auto", undefined, false);
  if (s.startsWith("custom:")) {
    const on = new Set(s.slice("custom:".length).split(",").filter(Boolean));
    return choiceFor("custom", { silence: on.has("silence"), cleanup: on.has("cleanup"), captions: on.has("captions") });
  }
  return LEGACY_CHOICE;
}

/**
 * On-device transcription runs for any edit: captions and the cleanup come from it, and pause removal uses its word
 * timings so no cut clips a word (lib/autoEdit/wordGuard.ts). Keep original runs none.
 */
export function needsTranscription(c: EditChoice): boolean {
  return c.captions || c.cleanup || c.silence;
}

/** True when a custom choice applies nothing (then it is the same as Keep original). */
export function appliesNothing(c: EditChoice): boolean {
  return !c.silence && !c.cleanup && !c.captions;
}

/**
 * Whether the choice screen comes before the editor: a new post (not a reaction, a reply or a draft) with video in it.
 * Reactions and photos are never edited automatically, so they go straight to the editor.
 */
export function wantsEditChoice(args: { clips: Array<{ type: string }>; reactingTo?: string | null; rootDropId?: string | null; draftId?: string | null }): boolean {
  if (args.reactingTo || args.rootDropId || args.draftId) return false;
  return args.clips.some((c) => c.type === "video");
}
