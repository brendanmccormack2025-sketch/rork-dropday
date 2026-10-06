/**
 * Auto-edit as a list of decisions over an untouched source video.
 *
 * Every automatic edit is one Decision on the SOURCE timeline that can be
 * reverted on its own. The render is a pure function of (source, EditState):
 * footage is kept unless an applied, enabled cut decision covers it, and other
 * decisions are mapped to the output timeline at render time.
 *
 * Pure: no React, no native modules. Erasable TypeScript only so
 * scripts/test-auto-edit.mjs can run it with Node's type stripping.
 */
import {
  keepRangesToClips,
  sourceToOutputMs,
  type EditClip,
  type KeepRange,
} from "../editModel.ts";

/** 'audio' is reserved for future text-to-speech; nothing implements it yet. */
export type DecisionType = "silenceCut" | "hookTrim" | "fillerCut" | "zoom" | "caption" | "audio";

export type Decision = {
  /** Stable: derived from type + rounded source range. */
  id: string;
  type: DecisionType;
  /** ALWAYS on the source timeline, never output. */
  sourceStartMs: number;
  sourceEndMs: number;
  /** Type-specific (zoom scale/center, caption text...). */
  payload?: unknown;
  origin: "ai" | "user";
  state: "applied" | "reverted";
};

export type EditState = {
  sourceUri: string;
  decisions: Decision[];
  categoryEnabled: Record<DecisionType, boolean>;
};

export const DECISION_TYPES: DecisionType[] = ["silenceCut", "hookTrim", "fillerCut", "zoom", "caption", "audio"];
export const CUT_TYPES: DecisionType[] = ["silenceCut", "hookTrim", "fillerCut"];

export function isCutType(type: DecisionType): boolean {
  return CUT_TYPES.includes(type);
}

/** Ranges are rounded to this for ids, so re-planning the same cut gives the same id. */
const ID_ROUND_MS = 10;

export function decisionId(type: DecisionType, startMs: number, endMs: number): string {
  const r = (n: number) => Math.round(n / ID_ROUND_MS) * ID_ROUND_MS;
  return `${type}:${r(startMs)}-${r(endMs)}`;
}

export function makeDecision(
  type: DecisionType,
  sourceStartMs: number,
  sourceEndMs: number,
  options: { payload?: unknown; origin?: "ai" | "user"; state?: "applied" | "reverted" } = {},
): Decision {
  return {
    id: decisionId(type, sourceStartMs, sourceEndMs),
    type,
    sourceStartMs,
    sourceEndMs,
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
    origin: options.origin ?? "ai",
    state: options.state ?? "applied",
  };
}

export function newEditState(sourceUri: string, decisions: Decision[] = []): EditState {
  const categoryEnabled = {} as Record<DecisionType, boolean>;
  for (const t of DECISION_TYPES) categoryEnabled[t] = true;
  return { sourceUri, decisions: sortDecisions(dedupe(decisions)), categoryEnabled };
}

function dedupe(list: Decision[]): Decision[] {
  const seen = new Set<string>();
  return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

function sortDecisions(list: Decision[]): Decision[] {
  return [...list].sort((a, b) => a.sourceStartMs - b.sourceStartMs || a.sourceEndMs - b.sourceEndMs);
}

function isActiveCut(state: EditState, d: Decision): boolean {
  return isCutType(d.type) && d.state === "applied" && state.categoryEnabled[d.type];
}

// ── Render derivation ───────────────────────────────────────────────────────

/**
 * The footage that stays: the complement (within 0..sourceDurationMs) of every
 * applied, category-enabled cut decision. With only silence cuts this equals the
 * detector's own keepRanges. Never mutates the state.
 */
export function keepRangesOf(state: EditState, sourceDurationMs: number): KeepRange[] {
  if (!(sourceDurationMs > 0)) return [];
  const cuts = state.decisions
    .filter((d) => isActiveCut(state, d))
    .map((d) => ({
      startMs: Math.max(0, d.sourceStartMs),
      endMs: Math.min(sourceDurationMs, d.sourceEndMs),
    }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const keep: KeepRange[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.startMs > cursor) keep.push({ startMs: cursor, endMs: c.startMs });
    if (c.endMs > cursor) cursor = c.endMs;
  }
  if (cursor < sourceDurationMs) keep.push({ startMs: cursor, endMs: sourceDurationMs });
  return keep;
}

/** Source ranges the applied, enabled cut decisions remove (may overlap). */
export function appliedCutRanges(state: EditState): Array<{ startMs: number; endMs: number }> {
  return state.decisions
    .filter((d) => isActiveCut(state, d))
    .map((d) => ({ startMs: d.sourceStartMs, endMs: d.sourceEndMs }));
}

/** The clips to render for this state: what the render path consumes today. */
export function renderClipsOf(state: EditState, sourceDurationMs: number): EditClip[] {
  return keepRangesToClips(state.sourceUri, keepRangesOf(state, sourceDurationMs));
}

export type MappedDecision = {
  decision: Decision;
  /** Where it plays on the output timeline; one piece per kept stretch it touches. */
  pieces: Array<{ startMs: number; endMs: number }>;
};

/**
 * Non-cut decisions (zoom, caption) on the output timeline, using sourceToOutputMs.
 * A decision lies on source footage, so restoring a cut moves its output time but
 * never its content. Parts inside cut footage are dropped; one wholly cut gets none.
 */
export function mapNonCutDecisions(state: EditState, clips: EditClip[]): MappedDecision[] {
  const out: MappedDecision[] = [];
  for (const d of state.decisions) {
    if (isCutType(d.type) || d.type === "audio") continue;
    if (d.state !== "applied" || !state.categoryEnabled[d.type]) continue;
    const pieces: Array<{ startMs: number; endMs: number }> = [];
    for (const c of clips) {
      if (c.uri !== state.sourceUri) continue;
      const s = Math.max(d.sourceStartMs, c.trimStartMs);
      const e = Math.min(d.sourceEndMs, c.trimEndMs);
      if (e <= s) continue;
      const startMs = sourceToOutputMs(clips, s, state.sourceUri);
      const last = sourceToOutputMs(clips, e - 1, state.sourceUri);
      if (startMs === null || last === null) continue;
      const endMs = last + 1;
      const prev = pieces[pieces.length - 1];
      if (prev && prev.endMs === startMs) prev.endMs = endMs;
      else pieces.push({ startMs, endMs });
    }
    if (pieces.length > 0) out.push({ decision: d, pieces });
  }
  return out;
}

// ── Changing the state (always returns a new state) ─────────────────────────

export function overlapMs(a: { sourceStartMs: number; sourceEndMs: number }, b: { sourceStartMs: number; sourceEndMs: number }): number {
  return Math.max(0, Math.min(a.sourceEndMs, b.sourceEndMs) - Math.max(a.sourceStartMs, b.sourceStartMs));
}

/** Overlap as a fraction of the SHORTER of the two ranges (1 when one contains the other). */
export function overlapRatio(a: Decision, b: Decision): number {
  const shorter = Math.min(a.sourceEndMs - a.sourceStartMs, b.sourceEndMs - b.sourceStartMs);
  if (shorter <= 0) return a.sourceStartMs === b.sourceStartMs && a.sourceEndMs === b.sourceEndMs ? 1 : 0;
  return overlapMs(a, b) / shorter;
}

export function setDecisionState(state: EditState, id: string, next: "applied" | "reverted"): EditState {
  return { ...state, decisions: state.decisions.map((d) => (d.id === id ? { ...d, state: next } : d)) };
}

export function setCategoryEnabled(state: EditState, type: DecisionType, enabled: boolean): EditState {
  return { ...state, categoryEnabled: { ...state.categoryEnabled, [type]: enabled } };
}

/** Restore the footage in a source range: reverts EVERY cut decision that overlaps it. */
export function restoreRange(state: EditState, sourceStartMs: number, sourceEndMs: number): EditState {
  const range = { sourceStartMs, sourceEndMs };
  return {
    ...state,
    decisions: state.decisions.map((d) =>
      isCutType(d.type) && d.state === "applied" && overlapMs(d, range) > 0
        ? { ...d, state: "reverted" as const }
        : d,
    ),
  };
}

/** A cut the user made by hand; it wins over any later AI plan. */
export function addUserCut(state: EditState, sourceStartMs: number, sourceEndMs: number): EditState {
  const d = makeDecision("silenceCut", sourceStartMs, sourceEndMs, { origin: "user" });
  return { ...state, decisions: sortDecisions(dedupe([...state.decisions.filter((x) => x.id !== d.id), d])) };
}

/**
 * Fold a new AI plan for `types` into the state. User wins: the old AI decisions of
 * those types are replaced, but user decisions stay, and any reverted decision is
 * kept as a tombstone. A planned decision that overlaps a tombstone by at least
 * 50% (of the shorter range) comes back reverted, so a user-reverted decision is
 * never resurrected, even when a sensitivity change shifts its edges.
 *
 * `resolved` is the plan in its input order with its final states.
 */
export function mergePlan(
  state: EditState,
  planned: Decision[],
  types: DecisionType[],
): { state: EditState; resolved: Decision[] } {
  const tombstones = state.decisions.filter((d) => d.state === "reverted");
  const kept = state.decisions.filter(
    (d) => d.origin === "user" || d.state === "reverted" || !types.includes(d.type),
  );
  const resolved = planned.map((p) => {
    const same = kept.find((k) => k.id === p.id);
    if (same) return same;
    const blocked = tombstones.some((t) => overlapRatio(p, t) >= 0.5);
    return blocked ? { ...p, state: "reverted" as const } : p;
  });
  return {
    state: { ...state, decisions: sortDecisions(dedupe([...kept, ...resolved])) },
    resolved,
  };
}

/** Set the state of several decisions at once (the Review sheet's switches). */
export function setStates(state: EditState, states: Record<string, "applied" | "reverted">): EditState {
  return {
    ...state,
    decisions: state.decisions.map((d) => (states[d.id] ? { ...d, state: states[d.id]! } : d)),
  };
}
