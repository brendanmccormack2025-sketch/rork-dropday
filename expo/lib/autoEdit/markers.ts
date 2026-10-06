/**
 * Timeline markers for the decision model, and keeping the playhead on its
 * content across a re-render.
 *
 * Cut decisions become markers at their seam on the OUTPUT timeline (cuts at one
 * seam share one marker); a restored (reverted) cut shows a subtler marker that can
 * re-apply it. The kind list also reserves styles for zooms (future) and the owner's
 * debug proposals, so the timeline can draw each its own way.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import {
  isCutType,
  keepRangesOf,
  overlapMs,
  restoreRange,
  setStates,
  type Decision,
  type DecisionType,
  type EditState,
} from "./decisions.ts";
import type { ClassifiedSound, SoundClass, SoundFeatures } from "./classifySound.ts";
import type { UnexplainedSound } from "./fillerCuts.ts";
import {
  outputToSourceMs,
  sourceToOutputMs,
  type EditClip,
  type KeepRange,
} from "../editModel.ts";

/** cut/restored: cut decisions. zoom: reserved for future zoom decisions. proposal/filler2/laugh/um: owner debug (never applied). */
export type MarkerKind = "cut" | "restored" | "zoom" | "proposal" | "filler2" | "laugh" | "um";

export type MarkerItem = {
  decisionId: string;
  type: DecisionType;
  label: string;
  lengthMs: number;
  /** A method-2 um cut: its class and the features it was judged on. */
  sound?: { cls: SoundClass; features: SoundFeatures };
};

export type TimelineMarker = {
  id: string;
  kind: MarkerKind;
  /** Where the marker sits on the output timeline. */
  outputMs: number;
  items: MarkerItem[];
  /** The source span the marker covers (what Restore works on). */
  srcStartMs: number;
  srcEndMs: number;
  /** Debug markers only. */
  detail?: { score: number; reasons: string[]; cls?: SoundClass; features?: SoundFeatures };
};

function seconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

/** "Silence 0.6s", "Filler 'um'", "Hook trim 0.8s"... */
export function describeDecision(d: Decision): MarkerItem {
  const lengthMs = Math.max(0, d.sourceEndMs - d.sourceStartMs);
  const payload = (d.payload ?? {}) as {
    text?: string;
    edge?: string;
    reason?: string;
    method?: number;
    cls?: SoundClass;
    features?: SoundFeatures;
  };
  let label: string;
  switch (d.type) {
    case "silenceCut":
      label = `Silence ${seconds(lengthMs)}`;
      break;
    case "fillerCut":
      label = payload.method === 2 ? `Filler (${payload.text ?? "um"})` : `Filler '${payload.text ?? "filler"}'`;
      break;
    case "hookTrim":
      label =
        payload.edge === "end"
          ? `Ending trim ${seconds(lengthMs)}`
          : payload.reason === "weakOpener"
            ? `Weak opener ${seconds(lengthMs)}`
            : `Hook trim ${seconds(lengthMs)}`;
      break;
    case "zoom":
      label = "Zoom";
      break;
    case "caption":
      label = "Caption";
      break;
    default:
      label = d.type;
  }
  const sound =
    payload.method === 2 && payload.cls && payload.features
      ? { cls: payload.cls, features: payload.features }
      : undefined;
  return { decisionId: d.id, type: d.type, label, lengthMs, ...(sound ? { sound } : {}) };
}

/** Output time of a source moment: all kept footage before it. A cut moment lands on its seam. */
export function outputPositionOfSource(keep: KeepRange[], sourceMs: number): number {
  let total = 0;
  for (const k of keep) total += Math.max(0, Math.min(k.endMs, sourceMs) - k.startMs);
  return total;
}

function toMarker(
  kind: "cut" | "restored",
  outputMs: number,
  ds: Decision[],
): TimelineMarker {
  return {
    id: `${kind}:${Math.round(outputMs)}`,
    kind,
    outputMs,
    items: ds.map(describeDecision),
    srcStartMs: Math.min(...ds.map((d) => d.sourceStartMs)),
    srcEndMs: Math.max(...ds.map((d) => d.sourceEndMs)),
  };
}

/** Applied cuts that land on the same output position share one marker. */
function groupBySeam(entries: Array<{ outputMs: number; decision: Decision }>): TimelineMarker[] {
  const byPosition = new Map<number, Decision[]>();
  for (const e of entries) {
    const key = Math.round(e.outputMs);
    byPosition.set(key, [...(byPosition.get(key) ?? []), e.decision]);
  }
  return [...byPosition.entries()].map(([outputMs, ds]) => toMarker("cut", outputMs, ds));
}

/** Restored cuts whose source ranges touch or overlap are one restored section. */
function groupRestored(entries: Array<{ outputMs: number; decision: Decision }>): TimelineMarker[] {
  const sorted = [...entries].sort((a, b) => a.decision.sourceStartMs - b.decision.sourceStartMs);
  const groups: Array<{ outputMs: number; endMs: number; ds: Decision[] }> = [];
  for (const e of sorted) {
    const last = groups[groups.length - 1];
    if (last && e.decision.sourceStartMs <= last.endMs) {
      last.ds.push(e.decision);
      last.endMs = Math.max(last.endMs, e.decision.sourceEndMs);
    } else {
      groups.push({ outputMs: e.outputMs, endMs: e.decision.sourceEndMs, ds: [e.decision] });
    }
  }
  return groups.map((g) => toMarker("restored", g.outputMs, g.ds));
}

/**
 * Markers for the cut decisions of enabled categories: one per seam for the applied
 * cuts, and one per spot for the restored ones (only where the footage is really
 * back). Categories switched off draw nothing.
 */
export function buildCutMarkers(state: EditState, sourceDurationMs: number): TimelineMarker[] {
  const keep = keepRangesOf(state, sourceDurationMs);
  const applied: Array<{ outputMs: number; decision: Decision }> = [];
  const restored: Array<{ outputMs: number; decision: Decision }> = [];
  for (const d of state.decisions) {
    if (!isCutType(d.type) || !state.categoryEnabled[d.type]) continue;
    const outputMs = outputPositionOfSource(keep, d.sourceStartMs);
    if (d.state === "applied") {
      applied.push({ outputMs, decision: d });
    } else if (keep.some((k) => overlapMs({ sourceStartMs: k.startMs, sourceEndMs: k.endMs }, d) > 0)) {
      restored.push({ outputMs, decision: d });
    }
  }
  return [...groupBySeam(applied), ...groupRestored(restored)].sort((a, b) => a.outputMs - b.outputMs);
}

/** Restore the footage a marker covers: reverts every cut overlapping its span. */
export function restoreMarker(state: EditState, marker: TimelineMarker): EditState {
  return restoreRange(state, marker.srcStartMs, marker.srcEndMs);
}

/** Put a restored marker's cuts back. */
export function reapplyMarker(state: EditState, marker: TimelineMarker): EditState {
  const ids: Record<string, "applied"> = {};
  for (const item of marker.items) ids[item.decisionId] = "applied";
  return setStates(state, ids);
}

/**
 * Where the playhead goes after the clips change: the output position is mapped to
 * the source moment it was showing, then to its place in the new clips. A moment
 * that is now cut lands on the seam. Never resets to 0.
 */
export function mapOutputPosition(
  oldClips: EditClip[],
  newClips: EditClip[],
  outputMs: number,
  sourceUri: string,
): number {
  const sourceMs = outputToSourceMs(oldClips, outputMs);
  const newTotal = newClips.reduce((sum, c) => sum + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
  if (sourceMs === null) return Math.min(Math.max(0, outputMs), newTotal);
  const direct = sourceToOutputMs(newClips, sourceMs, sourceUri);
  if (direct !== null) return direct;
  const keep = newClips
    .filter((c) => c.uri === sourceUri)
    .map((c) => ({ startMs: c.trimStartMs, endMs: c.trimEndMs }));
  return Math.min(outputPositionOfSource(keep, sourceMs), newTotal);
}

/**
 * Owner debug markers: emphasis proposals and method-2 filler candidates, placed on
 * the output timeline. Nothing here is applied. Moments inside cut footage are skipped.
 */
export function buildDebugMarkers(
  proposals: Decision[],
  candidates: Array<UnexplainedSound & Partial<Pick<ClassifiedSound, "cls" | "features" | "why">>>,
  clips: EditClip[],
  sourceUri: string,
): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  proposals.forEach((d, i) => {
    const outputMs = sourceToOutputMs(clips, d.sourceStartMs, sourceUri);
    if (outputMs === null) return;
    const p = (d.payload ?? {}) as { score?: number; reasons?: string[] };
    out.push({
      id: `proposal:${i}`,
      kind: "proposal",
      outputMs,
      items: [{ decisionId: d.id, type: d.type, label: "Emphasis moment", lengthMs: d.sourceEndMs - d.sourceStartMs }],
      srcStartMs: d.sourceStartMs,
      srcEndMs: d.sourceEndMs,
      detail: { score: p.score ?? 0, reasons: p.reasons ?? [] },
    });
  });
  candidates.forEach((c, i) => {
    const outputMs = sourceToOutputMs(clips, c.startMs, sourceUri);
    if (outputMs === null) return;
    const kind: MarkerKind = c.cls === "laugh" ? "laugh" : c.cls === "um" ? "um" : "filler2";
    out.push({
      id: `${kind}:${i}`,
      kind,
      outputMs,
      items: [
        {
          decisionId: `filler2:${c.startMs}`,
          type: "fillerCut",
          label: kind === "laugh" ? "Laugh (never cut)" : kind === "um" ? "um?" : "Unexplained sound",
          lengthMs: c.lengthMs,
        },
      ],
      srcStartMs: c.startMs,
      srcEndMs: c.endMs,
      detail: {
        score: 0,
        reasons: c.cls ? (c.why ?? []) : [`sound with no word, ${Math.round(c.lengthMs)} ms`],
        ...(c.cls ? { cls: c.cls, features: c.features } : {}),
      },
    });
  });
  return out.sort((a, b) => a.outputMs - b.outputMs);
}
