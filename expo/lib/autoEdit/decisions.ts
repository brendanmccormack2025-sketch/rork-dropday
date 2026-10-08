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
  type CaptionStyle,
  type EditClip,
  type KeepRange,
} from "../editModel.ts";

/** 'audio' is reserved for future text-to-speech; nothing implements it yet. */
/** laughProtect is not a cut: a source range no cut may remove time from (a laugh). */
export type DecisionType =
  | "silenceCut"
  | "hookTrim"
  | "fillerCut"
  | "umCut"
  | "laughProtect"
  | "zoom"
  | "caption"
  | "audio";

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
  /** Clip-wide caption size and position (owner); absent = the preset's own. Undo/redo cover it like any state. */
  captionStyle?: CaptionStyle;
  /**
   * The creator's caption edits, keyed by the index of the word in the SOURCE transcript (so they survive when cuts
   * change): a new text, or "" for a deleted word (Delete line deletes every word of the line). Undo/redo cover it.
   */
  captionEdits?: Record<number, string>;
};

/** The state with new caption edits; the same object when nothing changes (so it is not an undo step). */
export function setCaptionEdits(state: EditState, edits: Record<number, string>): EditState {
  const old = state.captionEdits ?? {};
  const keys = Object.keys(edits);
  if (keys.length === Object.keys(old).length && keys.every((k) => old[Number(k)] === edits[Number(k)])) return state;
  if (keys.length === 0) {
    const { captionEdits: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, captionEdits: { ...edits } };
}

/** Same box and same look (an absent look field counts as its default only when both are absent). */
export function sameCaptionStyle(a: CaptionStyle, b: CaptionStyle): boolean {
  return (
    a.scale === b.scale &&
    a.yCenter === b.yCenter &&
    a.xCenter === b.xCenter &&
    a.fontId === b.fontId &&
    a.textColor === b.textColor &&
    a.backgroundColor === b.backgroundColor
  );
}

/** The state back at the preset's own caption box (no stored style); the same object when it already is. */
export function clearCaptionStyle(state: EditState): EditState {
  if (state.captionStyle === undefined) return state;
  const { captionStyle: _drop, ...rest } = state;
  return rest;
}

/** The state with a new caption style; the same object when nothing changes (so it is not an undo step). */
export function setCaptionStyle(state: EditState, style: CaptionStyle): EditState {
  const old = state.captionStyle;
  if (old && sameCaptionStyle(old, style)) return state;
  return { ...state, captionStyle: style };
}

export const DECISION_TYPES: DecisionType[] = ["silenceCut", "hookTrim", "fillerCut", "umCut", "laughProtect", "zoom", "caption", "audio"];

/** Laugh protection: padding, how far apart laugh sounds may be to stay one episode (see planLaughProtection), and the smallest cut piece worth keeping. */
export const LAUGH_PROTECT_CONFIG = { padMs: 150, mergeGapMs: 4000, minCutMs: 120 };
export const CUT_TYPES: DecisionType[] = ["silenceCut", "hookTrim", "fillerCut", "umCut"];

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

export function dedupe(list: Decision[]): Decision[] {
  const seen = new Set<string>();
  return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

export function sortDecisions(list: Decision[]): Decision[] {
  return [...list].sort((a, b) => a.sourceStartMs - b.sourceStartMs || a.sourceEndMs - b.sourceEndMs);
}

/** A part the creator deleted by hand from the Cuts screen (see addManualCut). */
export function isManualDelete(d: Decision): boolean {
  return d.origin === "user" && (d.payload as { manual?: boolean } | undefined)?.manual === true;
}

export function isActiveCut(state: EditState, d: Decision): boolean {
  // A category missing from an older saved state counts as on. A part the creator deleted by hand stays deleted
  // whatever the automatic categories do ("Keep original" turns off the AI's cuts, not the creator's).
  return isCutType(d.type) && d.state === "applied" && (isManualDelete(d) || state.categoryEnabled[d.type] !== false);
}

// ── Laugh protection ────────────────────────────────────────────────────────

type Range = { startMs: number; endMs: number };

/** The protected laugh ranges in force (applied, category on), merged and sorted. */
export function protectedRangesOf(state: EditState): Range[] {
  const sorted = state.decisions
    .filter((d) => d.type === "laughProtect" && d.state === "applied" && state.categoryEnabled.laughProtect !== false)
    .map((d) => ({ startMs: d.sourceStartMs, endMs: d.sourceEndMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * What is left of a cut once protected ranges are taken out: it stops at a protected
 * range's edge. Only a cut that touches a protected range is changed, and pieces
 * shorter than minPieceMs are dropped.
 */
export function effectivePieces(
  range: Range,
  protectedRanges: Range[],
  minPieceMs: number = LAUGH_PROTECT_CONFIG.minCutMs,
): Range[] {
  if (!protectedRanges.some((p) => p.startMs < range.endMs && p.endMs > range.startMs)) return [range];
  const pieces: Range[] = [];
  let cursor = range.startMs;
  for (const p of protectedRanges) {
    if (p.endMs <= cursor || p.startMs >= range.endMs) continue;
    if (p.startMs > cursor) pieces.push({ startMs: cursor, endMs: p.startMs });
    cursor = Math.max(cursor, p.endMs);
  }
  if (cursor < range.endMs) pieces.push({ startMs: cursor, endMs: range.endMs });
  return pieces.filter((x) => x.endMs - x.startMs >= minPieceMs);
}

/** The ranges the applied, enabled cuts really remove: protection already taken out. */
export function effectiveCutRanges(state: EditState, type?: DecisionType): Range[] {
  const prot = protectedRangesOf(state);
  return state.decisions
    .filter((d) => isActiveCut(state, d) && (!type || d.type === type))
    // A cut the creator made by hand is never held back: the user wins.
    .flatMap((d) =>
      effectivePieces({ startMs: d.sourceStartMs, endMs: d.sourceEndMs }, d.origin === "user" ? [] : prot),
    );
}

export type ProtectionReport = {
  ranges: Array<{ startMs: number; endMs: number; laughs: number; others: number }>;
  affected: Array<{
    id: string;
    type: DecisionType;
    startMs: number;
    endMs: number;
    result: "shortened" | "split" | "dropped";
    pieces: Range[];
  }>;
};

/** Which protected ranges are in force and which cuts they shortened, split or dropped. */
export function protectionReport(state: EditState): ProtectionReport {
  const prot = protectedRangesOf(state);
  const ranges = state.decisions
    .filter((d) => d.type === "laughProtect" && d.state === "applied" && state.categoryEnabled.laughProtect !== false)
    .map((d) => ({
      startMs: d.sourceStartMs,
      endMs: d.sourceEndMs,
      laughs: ((d.payload ?? {}) as { laughs?: number }).laughs ?? 1,
      others: ((d.payload ?? {}) as { others?: number }).others ?? 0,
    }));
  const affected: ProtectionReport["affected"] = [];
  for (const d of state.decisions) {
    if (!isActiveCut(state, d) || d.origin === "user") continue;
    const pieces = effectivePieces({ startMs: d.sourceStartMs, endMs: d.sourceEndMs }, prot);
    const unchanged = pieces.length === 1 && pieces[0]!.startMs === d.sourceStartMs && pieces[0]!.endMs === d.sourceEndMs;
    if (unchanged) continue;
    affected.push({
      id: d.id,
      type: d.type,
      startMs: d.sourceStartMs,
      endMs: d.sourceEndMs,
      result: pieces.length === 0 ? "dropped" : pieces.length === 1 ? "shortened" : "split",
      pieces,
    });
  }
  return { ranges, affected };
}

// ── Render derivation ───────────────────────────────────────────────────────

/**
 * The footage that stays: the complement (within 0..sourceDurationMs) of every
 * applied, category-enabled cut decision. With only silence cuts this equals the
 * detector's own keepRanges. Never mutates the state.
 */
export function keepRangesOf(state: EditState, sourceDurationMs: number): KeepRange[] {
  if (!(sourceDurationMs > 0)) return [];
  const cuts = effectiveCutRanges(state)
    .map((d) => ({
      startMs: Math.max(0, d.startMs),
      endMs: Math.min(sourceDurationMs, d.endMs),
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
  return effectiveCutRanges(state);
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

/** "Delete this part": a cut the creator made by hand. Like any cut it can be restored (restoreRange) and undone. */
export function addManualCut(state: EditState, sourceStartMs: number, sourceEndMs: number): EditState {
  const d = makeDecision("silenceCut", sourceStartMs, sourceEndMs, { origin: "user", payload: { manual: true } });
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
  // A reverted cut blocks a planned cut; a protection is only blocked by a reverted protection.
  const blockers = (p: Decision) =>
    tombstones.filter((t) => (isCutType(p.type) ? isCutType(t.type) : t.type === p.type));
  const kept = state.decisions.filter(
    (d) => d.origin === "user" || d.state === "reverted" || !types.includes(d.type),
  );
  const resolved = planned.map((p) => {
    const same = kept.find((k) => k.id === p.id);
    if (same) return same;
    // The creator's own decisions are never blocked by an earlier reversal.
    const blocked = p.origin !== "user" && blockers(p).some((t) => overlapRatio(p, t) >= 0.5);
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
