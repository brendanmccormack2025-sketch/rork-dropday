/**
 * Undo/redo of EditState snapshots for the creator's own actions (switches,
 * restores, re-applies, resets, sensitivity changes). AI planning is not a step:
 * it never pushes, and mapHistory re-plans the saved snapshots so they keep the
 * AI decisions while undo still brings back the creator's choices.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { EditState } from "./decisions.ts";

export const MAX_HISTORY = 50;

export type EditHistory = { past: EditState[]; future: EditState[] };

export function emptyHistory(): EditHistory {
  return { past: [], future: [] };
}

export const canUndo = (h: EditHistory): boolean => h.past.length > 0;
export const canRedo = (h: EditHistory): boolean => h.future.length > 0;

/** Record the state a user action starts from. A new action drops the redo steps. */
export function pushEdit(h: EditHistory, before: EditState, max: number = MAX_HISTORY): EditHistory {
  const past = [...h.past, before];
  while (past.length > max) past.shift();
  return { past, future: [] };
}

export function undoEdit(
  h: EditHistory,
  current: EditState,
): { history: EditHistory; state: EditState } | null {
  const state = h.past[h.past.length - 1];
  if (!state) return null;
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current] }, state };
}

export function redoEdit(
  h: EditHistory,
  current: EditState,
): { history: EditHistory; state: EditState } | null {
  const state = h.future[h.future.length - 1];
  if (!state) return null;
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1) }, state };
}

/** Run every saved snapshot through `f` (used when the AI plan changes underneath). */
export function mapHistory(h: EditHistory, f: (s: EditState) => EditState): EditHistory {
  return { past: h.past.map(f), future: h.future.map(f) };
}
