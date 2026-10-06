/**
 * What the "AI edits" panel shows and does, as plain functions over EditState.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { DECISION_TYPES, type DecisionType, type EditState } from "./decisions.ts";

export type CategoryId = "cuts" | "hook" | "fillers" | "zooms" | "captions";

export type CategoryRow = {
  id: CategoryId;
  label: string;
  type: DecisionType;
  /** Applied decisions in this category (e.g. "Fillers · 6"). */
  count: number;
  enabled: boolean;
};

const ROWS: Array<{ id: CategoryId; label: string; type: DecisionType; ownerOnly: boolean }> = [
  { id: "cuts", label: "Cuts", type: "silenceCut", ownerOnly: false },
  { id: "hook", label: "Hook", type: "hookTrim", ownerOnly: true },
  { id: "fillers", label: "Fillers", type: "fillerCut", ownerOnly: true },
  { id: "zooms", label: "Zooms", type: "zoom", ownerOnly: true },
  { id: "captions", label: "Captions", type: "caption", ownerOnly: true },
];

/**
 * One row per category: Cuts for everyone; Hook, Fillers, Zooms and Captions for the
 * owner. Captions are switched by the editor's own captions toggle, so their count
 * and state come in as arguments.
 */
export function categoryRows(
  state: EditState,
  options: { owner: boolean; captionLines: number; captionsOn: boolean },
): CategoryRow[] {
  return ROWS.filter((r) => options.owner || !r.ownerOnly).map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    count:
      r.id === "captions"
        ? options.captionLines
        : state.decisions.filter((d) => d.type === r.type && d.state === "applied").length,
    enabled: r.id === "captions" ? options.captionsOn : state.categoryEnabled[r.type],
  }));
}

/** "Original video": every category off, no decision touched. */
export function allCategoriesOff(state: EditState): EditState {
  const categoryEnabled = { ...state.categoryEnabled };
  for (const t of DECISION_TYPES) categoryEnabled[t] = false;
  return { ...state, categoryEnabled };
}

/** True when the state would leave the footage exactly as recorded. */
export function isOriginalVideo(state: EditState): boolean {
  return DECISION_TYPES.every((t) => !state.categoryEnabled[t]);
}
