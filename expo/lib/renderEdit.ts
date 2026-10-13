/**
 * The edit as render instructions: the one list of source ranges that the preview plays and the export renders.
 *
 * Both start from the editor's clips (which come from the edit decisions, see decisions.ts renderClipsOf), so they
 * cannot disagree about what is cut. This module only normalises that list the same way for every consumer:
 *  - adjacent pieces of the same file that continue where the last ended (a split) are one range,
 *  - the list is validated before anything is exported or rendered ahead.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type EditRange = { uri: string; trimStartMs: number; trimEndMs: number };

/** Pieces closer than this are the same footage (a split leaves none). */
export const CONTIGUOUS_TOLERANCE_MS = 1;
/** A range shorter than this cannot be rendered into a frame. */
export const MIN_RANGE_MS = 20;
/** A range may reach this far past the length the file reported (the report is rounded). */
export const PAST_END_TOLERANCE_MS = 150;

export type ClipLike = { uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

/** A clip's range: trimEnd 0 / missing means "to the end of the file". */
export function rangeOf(c: ClipLike): EditRange {
  return { uri: c.uri, trimStartMs: c.trimStartMs ?? 0, trimEndMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0) };
}

/** Merge ranges that continue where the previous one ended (same file). The input order is the playing order. */
export function coalesceEdit(edit: EditRange[]): EditRange[] {
  const out: EditRange[] = [];
  for (const r of edit) {
    const last = out[out.length - 1];
    if (last && last.uri === r.uri && Math.abs(r.trimStartMs - last.trimEndMs) <= CONTIGUOUS_TOLERANCE_MS) last.trimEndMs = r.trimEndMs;
    else out.push({ ...r });
  }
  return out;
}

export function editLengthMs(edit: EditRange[]): number {
  return edit.reduce((sum, c) => sum + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
}

export type EditProblem = "empty edit" | "invalid clip range" | "clip too short" | "clip beyond the end of its file";

/**
 * null when the edit can be rendered; otherwise what is wrong (fixed wording, for the message and the diagnostics).
 * `fileLengthMs` gives the known length of a file (the clips carry it once the player has loaded it).
 */
export function validateEdit(edit: EditRange[], fileLengthMs?: (uri: string) => number | undefined): EditProblem | null {
  if (edit.length === 0) return "empty edit";
  for (const r of edit) {
    if (!Number.isFinite(r.trimStartMs) || !Number.isFinite(r.trimEndMs) || r.trimStartMs < 0 || r.trimEndMs <= r.trimStartMs) return "invalid clip range";
    if (r.trimEndMs - r.trimStartMs < MIN_RANGE_MS) return "clip too short";
    const len = fileLengthMs?.(r.uri);
    if (len !== undefined && len > 0 && r.trimEndMs > len + PAST_END_TOLERANCE_MS) return "clip beyond the end of its file";
  }
  return null;
}

/** The clips as a validated, coalesced render edit. */
export function renderEditOf(clips: ClipLike[]): { edit: EditRange[]; editMs: number; problem: EditProblem | null } {
  const edit = coalesceEdit(clips.map(rangeOf));
  const lengths = new Map<string, number>();
  for (const c of clips) if (c.durationMs && c.durationMs > 0) lengths.set(c.uri, Math.max(lengths.get(c.uri) ?? 0, c.durationMs));
  return { edit, editMs: editLengthMs(edit), problem: validateEdit(edit, (uri) => lengths.get(uri)) };
}
