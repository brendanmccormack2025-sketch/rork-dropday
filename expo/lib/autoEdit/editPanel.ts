/**
 * What the "AI edits" panel shows and does, as plain functions over EditState.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { CUT_TYPES, DECISION_TYPES, keepRangesOf, setCategoryEnabled, type DecisionType, type EditState } from "./decisions.ts";

export type CategoryId = "cuts" | "hook" | "fillers" | "ums" | "protect" | "zooms" | "captions";

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
  { id: "hook", label: "Hook", type: "hookTrim", ownerOnly: false },
  { id: "fillers", label: "Fillers", type: "fillerCut", ownerOnly: false },
  { id: "ums", label: "Ums", type: "umCut", ownerOnly: false },
  { id: "protect", label: "Protect laughs", type: "laughProtect", ownerOnly: false },
  { id: "zooms", label: "Zooms", type: "zoom", ownerOnly: true },
  { id: "captions", label: "Captions", type: "caption", ownerOnly: false },
];

/**
 * One row per category for everyone (Cuts, Hook, Fillers, Ums, Protect laughs, Captions); Zooms (emphasis
 * proposals) for the owner only. Captions are switched by the editor's own captions toggle, so their count
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
    enabled: r.id === "captions" ? options.captionsOn : state.categoryEnabled[r.type] !== false,
  }));
}

/** "Original video": every category off, no decision touched. */
export function allCategoriesOff(state: EditState): EditState {
  const categoryEnabled = { ...state.categoryEnabled };
  for (const t of DECISION_TYPES) categoryEnabled[t] = false;
  return { ...state, categoryEnabled };
}

/**
 * "Keep original": the automatic CUT categories (silences, hook, fillers, ums) off. Nothing else changes: not the
 * laugh protection, zooms or captions, not a part the creator deleted by hand, not the text overlays.
 */
export function cutCategoriesOff(state: EditState): EditState {
  const categoryEnabled = { ...state.categoryEnabled };
  for (const t of CUT_TYPES) categoryEnabled[t] = false;
  return { ...state, categoryEnabled };
}

/** True when the state would leave the footage exactly as recorded. */
export function isOriginalVideo(state: EditState): boolean {
  return DECISION_TYPES.every((t) => !state.categoryEnabled[t]);
}

// ── The Cuts sheet (the old Review sheet and AI edits panel in one) ────────────────────────────

export type CutsRowId = "silences" | "ums" | "hook" | "protect" | "zooms";

export type CutsRow = {
  id: CutsRowId;
  label: string;
  /** The decision categories this one switch turns on and off together. */
  types: DecisionType[];
  count: number;
  enabled: boolean;
};

const CUTS_ROWS: Array<{ id: CutsRowId; label: string; types: DecisionType[]; ownerOnly: boolean }> = [
  { id: "silences", label: "Silences", types: ["silenceCut"], ownerOnly: false },
  // Ums: the method 2 ums and the method 1 filler words ("um", "uh") go together, as the two rows did before.
  { id: "ums", label: "Ums", types: ["umCut", "fillerCut"], ownerOnly: false },
  { id: "hook", label: "Slow start/end", types: ["hookTrim"], ownerOnly: false },
  { id: "protect", label: "Protect laughs", types: ["laughProtect"], ownerOnly: false },
  { id: "zooms", label: "Zooms", types: ["zoom"], ownerOnly: true },
];

/** The switches of the Cuts sheet. Captions are not here (they have their own panel); Zooms are owner-only. */
export function cutsRows(state: EditState, options: { owner: boolean }): CutsRow[] {
  return CUTS_ROWS.filter((r) => options.owner || !r.ownerOnly).map((r) => ({
    id: r.id,
    label: r.label,
    types: r.types,
    count: state.decisions.filter((d) => r.types.includes(d.type) && d.state === "applied").length,
    enabled: r.types.every((t) => state.categoryEnabled[t] !== false),
  }));
}

/** Flip one switch: each of its categories exactly as the separate switches did (setCategoryEnabled). */
export function setCutsRowEnabled(state: EditState, row: Pick<CutsRow, "types">, value: boolean): EditState {
  return row.types.reduce((s, t) => setCategoryEnabled(s, t, value), state);
}

const CUT_TYPES_SHOWN: DecisionType[] = ["silenceCut", "umCut", "fillerCut", "hookTrim"];

/** "15 cuts · saved 35.2 s": the applied cuts that really remove footage, and the time they save. */
export function cutsSummary(state: EditState, sourceDurationMs: number): { cuts: number; savedMs: number; text: string } {
  const cuts = state.decisions.filter(
    (d) => CUT_TYPES_SHOWN.includes(d.type) && d.state === "applied" && state.categoryEnabled[d.type] !== false,
  ).length;
  const kept = keepRangesOf(state, sourceDurationMs).reduce((sum, k) => sum + (k.endMs - k.startMs), 0);
  const savedMs = Math.max(0, sourceDurationMs - kept);
  const n = cuts;
  return { cuts: n, savedMs, text: `${n} ${n === 1 ? "cut" : "cuts"} · saved ${(savedMs / 1000).toFixed(1)} s` };
}
