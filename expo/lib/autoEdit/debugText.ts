/**
 * The owner's "Share AI debug" text: plain, one fact per line.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { sourceToOutputMs, type EditClip } from "../editModel.ts";
import type { Decision } from "./decisions.ts";
import type { Alignment } from "./alignment.ts";
import { formatFeatures, type ClassifiedSound } from "./classifySound.ts";
import type { UnexplainedSound } from "./fillerCuts.ts";

/** m:ss.s, rounded to tenths first so 59.96 s reads 1:00.0. */
export function formatClock(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export type AiDebugInput = {
  sourceDurationMs: number;
  /** The clips as rendered now (for output-timeline times). */
  clips: EditClip[];
  sourceUri: string;
  /** Emphasis proposals (zoom decisions with score and reasons); not applied. */
  proposals: Decision[];
  /** Every method-2 candidate, classified (um candidates are cut; laugh and unsure are not). */
  candidates: Array<UnexplainedSound & Partial<Pick<ClassifiedSound, "cls" | "features">>>;
  /** Applied hook trim decisions and applied method-1 filler decisions. */
  hookTrims: Decision[];
  fillers: Decision[];
  /** Applied method-2 um cuts. */
  ums?: Decision[];
  /** Timeline check (words vs loudness) and the speech baseline, to tune from real clips. */
  alignment?: Alignment | null;
  speechBaselineDb?: number;
};

function outputTime(clips: EditClip[], uri: string, sourceMs: number): string {
  const out = sourceToOutputMs(clips, sourceMs, uri);
  return out === null ? "cut" : formatClock(out);
}

export function formatAiDebug(input: AiDebugInput): string {
  const { clips, sourceUri: uri } = input;
  const editedMs = clips.reduce((sum, c) => sum + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
  const lines: string[] = [];
  lines.push("Trial AI debug");
  lines.push(`Clip duration: ${formatClock(input.sourceDurationMs)} (edited ${formatClock(editedMs)})`);
  const a = input.alignment;
  if (a) {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const shift = `${a.bestShiftMs >= 0 ? "+" : ""}${a.bestShiftMs} ms`;
    lines.push(
      `Timeline check: ${a.wordCount} words ${formatClock(a.firstWordMs)}-${formatClock(a.lastWordMs)}, loudness ${formatClock(a.loudnessMs)}; ` +
        `word time on sound ${pct(a.shareAtZero)} as is, best ${pct(a.bestShare)} at ${shift}`,
    );
  }
  if (input.speechBaselineDb !== undefined) {
    lines.push(`Speech baseline: ${input.speechBaselineDb.toFixed(1)} dB`);
  }

  lines.push("", `Emphasis proposals (not applied): ${input.proposals.length}`);
  for (const d of input.proposals) {
    const p = (d.payload ?? {}) as { score?: number; reasons?: string[] };
    lines.push(
      `${outputTime(clips, uri, d.sourceStartMs)}  score ${(p.score ?? 0).toFixed(2)}  ${(p.reasons ?? []).join(", ")}`,
    );
  }

  const count = (cls: string) => input.candidates.filter((c) => c.cls === cls).length;
  lines.push(
    "",
    input.candidates.some((c) => c.cls)
      ? `Filler candidates, method 2: ${input.candidates.length} (um ${count("um")}, laugh ${count("laugh")}, unsure ${count("unsure")})`
      : `Filler candidates, method 2 (not applied): ${input.candidates.length}`,
  );
  for (const c of input.candidates) {
    lines.push(
      c.cls && c.features
        ? `${outputTime(clips, uri, c.startMs)}  ${c.cls}  ${formatFeatures(c.features)}`
        : `${outputTime(clips, uri, c.startMs)}  ${Math.round(c.lengthMs)} ms  sound with no transcript word`,
    );
  }

  lines.push("", `Hook trim (applied): ${input.hookTrims.length}`);
  for (const d of input.hookTrims) {
    const p = (d.payload ?? {}) as { edge?: string; reason?: string };
    lines.push(
      `${p.edge ?? "start"}  source ${formatClock(d.sourceStartMs)}-${formatClock(d.sourceEndMs)}  ${p.reason ?? ""}`.trimEnd(),
    );
  }

  lines.push("", `Fillers, method 1 (applied): ${input.fillers.length}`);
  for (const d of input.fillers) {
    const p = (d.payload ?? {}) as { text?: string };
    lines.push(`'${p.text ?? ""}'  source ${formatClock(d.sourceStartMs)}-${formatClock(d.sourceEndMs)}`);
  }
  const ums = input.ums ?? [];
  lines.push("", `Um cuts, method 2 (applied): ${ums.length}`);
  for (const d of ums) lines.push(`um  source ${formatClock(d.sourceStartMs)}-${formatClock(d.sourceEndMs)}`);
  return lines.join("\n");
}
