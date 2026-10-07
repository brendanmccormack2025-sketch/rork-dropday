/**
 * The owner's "Share AI debug" text: plain, one fact per line.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { sourceToOutputMs, type EditClip } from "../editModel.ts";
import type { Decision } from "./decisions.ts";
import type { TranscriptionInfo } from "../transcription/types.ts";
import type { Alignment } from "./alignment.ts";
import type { ProtectionReport } from "./decisions.ts";
import { formatFeatures, formatUmChecks, type ClassifiedSound } from "./classifySound.ts";
import { outputPositionOfSource } from "./markers.ts";
import type { UmCutReport } from "./umCuts.ts";
import type { StretchedReport } from "./stretchedUms.ts";
import type { AdjacentFinding } from "./adjacentSounds.ts";
import type { NonWordStretch } from "./classifySound.ts";
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
  candidates: Array<UnexplainedSound & Partial<Pick<ClassifiedSound, "cls" | "features" | "checks" | "adjacent" | "blocked">>>;
  /** Applied hook trim decisions and applied method-1 filler decisions. */
  hookTrims: Decision[];
  fillers: Decision[];
  /** Timeline check (words vs loudness) and the speech baseline, to tune from real clips. */
  alignment?: Alignment | null;
  speechBaselineDb?: number;
  /** The applied and skipped method-2 um cuts, with the seam counts. */
  umReport?: UmCutReport;
  /** Every stretch of sound outside the words longer than 1 s, with its laugh verdict. */
  stretches?: NonWordStretch[];
  /** What comes right after (or before) each word that has a pause beside it. */
  adjacent?: AdjacentFinding[];
  /** Stretched words (ums absorbed into a word) and the diagnosis of the gaps next to them. */
  stretched?: StretchedReport;
  /** Protected laugh ranges and the cuts they shortened or dropped. */
  protection?: ProtectionReport;
  /** Sounds the creator cut by hand ("Cut this sound"). */
  userCuts?: Decision[];
  /** How the transcription of this clip went. */
  transcription?: TranscriptionInfo | null;
  /** The transcript after dedupe (ms on the source clip). */
  transcriptWords?: Array<{ text: string; startMs: number; endMs: number }> | null;
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
  // How the transcription went comes first, then the alignment summary.
  const t = input.transcription;
  if (t) {
    const why = t.status === "ok" ? "" : ` (${t.code ?? "no code"}${t.message ? `: ${t.message}` : ""})`;
    lines.push(`Transcription: ${t.status}${why}; ${t.wordCount} words; from cache: ${t.fromCache ? "yes" : "no"}`);
    if (t.status === "ok" && (t.repeatedWordsRemoved !== undefined || t.overlappingWordsRemoved !== undefined)) {
      lines.push(`Duplicates removed: ${t.repeatedWordsRemoved ?? 0} repeated words, ${t.overlappingWordsRemoved ?? 0} overlapping words`);
      for (const d of t.dedupeDecisions ?? []) {
        lines.push(`  ${d.outcome === "removed" ? "REMOVED" : "KEPT"} "${d.text}" (${d.wordCount} words at ${formatClock(d.earlierStartMs)} and ${formatClock(d.laterStartMs)}): ${d.reason}`);
      }
    }
    lines.push(`Cache key: ${t.key ?? "none (file could not be read)"}`);
    if (input.transcriptWords && input.transcriptWords.length > 0) {
      lines.push("Transcript (after dedupe):");
      for (const w of input.transcriptWords) lines.push(`  ${formatClock(w.startMs)}-${formatClock(w.endMs)}  ${w.text}`);
    }
  } else if (input.transcription === null) {
    lines.push("Transcription: not run");
  }
  // The transcript alignment summary.
  const a = input.alignment;
  if (a) {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const shift = `${a.bestShiftMs >= 0 ? "+" : ""}${a.bestShiftMs} ms`;
    lines.push(
      `Timeline check: ${a.wordCount} words ${formatClock(a.firstWordMs)}-${formatClock(a.lastWordMs)}, loudness ${formatClock(a.loudnessMs)}; ` +
        `word time on sound ${pct(a.shareAtZero)} as is, best ${pct(a.bestShare)} at ${shift}`,
    );
  } else if (input.alignment === null) {
    lines.push("Timeline check: unavailable (no transcript words)");
  }
  if (input.speechBaselineDb !== undefined) {
    lines.push(`Speech baseline: ${input.speechBaselineDb.toFixed(1)} dB`);
  }
  lines.push(`Clip duration: ${formatClock(input.sourceDurationMs)} (edited ${formatClock(editedMs)})`);

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
      ? `Filler candidates, method 2 (display only, never cut): ${input.candidates.length} (um? ${count("um")}, laugh ${count("laugh")}, unsure ${count("unsure")})`
      : `Filler candidates, method 2 (not applied): ${input.candidates.length}`,
  );
  for (const c of input.candidates) {
    lines.push(
      c.cls && c.features
        ? `${outputTime(clips, uri, c.startMs)}  ${c.cls === "um" ? "um?" : c.cls}  ${formatFeatures(c.features)}${c.adjacent ? `  [adjacent: ${c.adjacent}]` : ""}${c.blocked ? `  [not cut: ${c.blocked}]` : ""}`
        : `${outputTime(clips, uri, c.startMs)}  ${Math.round(c.lengthMs)} ms  sound with no transcript word`,
    );
    if (c.checks && c.features) lines.push(`    ${formatUmChecks(c.checks, c.features)}`);
  }

  const prot = input.protection;
  if (prot) {
    lines.push("", `Protected laughs: ${prot.ranges.length}`);
    for (const r of prot.ranges) {
      lines.push(
        `source ${formatClock(r.startMs)}-${formatClock(r.endMs)}  ${r.laughs} laugh sound${r.laughs === 1 ? "" : "s"}` +
          (r.others > 0 ? ` (+${r.others} other sound${r.others === 1 ? "" : "s"} in the episode)` : ""),
      );
    }
    lines.push(`Cuts changed by protection: ${prot.affected.length}`);
    for (const a of prot.affected) {
      const what =
        a.result === "dropped"
          ? "dropped"
          : `${a.result} to ${a.pieces.map((p) => `${formatClock(p.startMs)}-${formatClock(p.endMs)}`).join(" + ")}`;
      lines.push(`${a.type}  source ${formatClock(a.startMs)}-${formatClock(a.endMs)}  ${what}`);
    }
  }

  const mine = input.userCuts ?? [];
  if (mine.length > 0) {
    lines.push("", `Sounds you cut: ${mine.length}`);
    for (const d of mine) {
      const p = (d.payload ?? {}) as { cls?: string; mergedWithSilence?: boolean };
      lines.push(
        `source ${formatClock(d.sourceStartMs)}-${formatClock(d.sourceEndMs)}  ${p.cls === "um" ? "um?" : (p.cls ?? "sound")}  merged with silence: ${p.mergedWithSilence ? "yes" : "no"}  ${d.state}`,
      );
    }
  }

  const report = input.umReport;
  if (report) {
    const keep = clips.filter((c) => c.uri === uri).map((c) => ({ startMs: c.trimStartMs, endMs: c.trimEndMs }));
    lines.push("", `Um cuts, method 2 (applied): ${report.applied.length}`);
    for (const u of report.applied) {
      lines.push(
        `${formatClock(outputPositionOfSource(keep, u.startMs))}  ${Math.round(u.lengthMs)} ms  merged with silence: ${u.mergedWithSilence ? "yes" : "no"}`,
      );
    }
    lines.push(`Um candidates skipped: ${report.skipped.length}`);
    for (const u of report.skipped) {
      lines.push(`${outputTime(clips, uri, u.startMs)}  ${Math.round(u.lengthMs)} ms  ${u.reason}`);
    }
    lines.push(`Seams: ${report.finalSeams} final vs ${report.silenceOnlySeams} silence-only`);
    if (report.seamLimit.capped) {
      lines.push(
        `Seam limit hit: at most ${report.seamLimit.allowed} new seams for ${formatClock(report.seamLimit.editedMs)} edited; only the longest ums were applied`,
      );
    }
  }

  if (input.stretches) {
    lines.push("", `Non-word sound stretches over 1 s: ${input.stretches.length}`);
    for (const s of input.stretches) {
      lines.push(
        `${outputTime(clips, uri, s.startMs)}  ${Math.round(s.lengthMs)} ms  bursts ${s.burstCount}  peak vs speech ${s.peakVsSpeechDb >= 0 ? "+" : ""}${s.peakVsSpeechDb.toFixed(1)} dB  ${s.verdict}`,
      );
    }
  }

  const adj = input.adjacent;
  if (adj) {
    lines.push("", `Sound next to words (a pause of more than 300 ms beside the word): ${adj.length}`);
    for (const f of adj) {
      const what = f.kind === "tail" ? "tail" : "head";
      const where = f.kind === "tail" ? `after '${f.text}'` : `before '${f.text}'`;
      const range = `source ${formatClock(f.wordStartMs)}-${formatClock(f.wordEndMs)}, pause ${f.pauseMs === null ? "none" : `${Math.round(f.pauseMs)} ms`}`;
      const db = f.dbVsSpeech === undefined || !Number.isFinite(f.dbVsSpeech) ? "" : `${f.dbVsSpeech >= 0 ? "+" : ""}${f.dbVsSpeech.toFixed(0)} dB`;
      const len = Math.round(f.lengthMs ?? 0);
      let result: string;
      if (f.status === "no sound") result = `no ${what}`;
      else if (f.status === "separate sound") result = `a separate sound, ${len} ms at ${db} (a regular candidate, see the list above)`;
      else if (f.status === "too short") result = `${what} too short (${len} ms)`;
      else if (f.status === "too long") result = `${what} too long (${len} ms)`;
      else if (f.status === "too quiet") result = `${what} ${len} ms, too quiet (${db})`;
      else if (f.status === "too loud") result = `${what} ${len} ms, too loud (${db})`;
      else {
        const cand = input.candidates.find((c) => c.startMs === f.startMs);
        const hit = <T extends { startMs: number; endMs: number }>(r: T) => r.startMs < (f.endMs ?? 0) && r.endMs > (f.startMs ?? 0);
        const cut = input.umReport?.applied.find(hit);
        const skipped = input.umReport?.skipped.find(hit);
        const outcome = cand && cand.cls !== "um" ? `${cand.cls}, not cut` : cut ? "cut" : skipped ? `not cut: ${skipped.reason}` : "not cut";
        result = `${what} ${len} ms at ${db} -> um candidate (${outcome})`;
      }
      lines.push(`${where} (${range}): ${result}`);
      if (f.status !== "no sound") lines.push(`    profile (50 ms, dB vs speech): ${f.profile}`);
    }
  }

  const st = input.stretched;
  if (st) {
    lines.push(
      "",
      `Stretched words: ${st.words.length}` + (st.expectedMsPerChar === null ? " (no estimate: too few words)" : ` (expected ${Math.round(st.expectedMsPerChar)} ms per character)`),
    );
    for (const s of st.words) {
      const pause = (ms: number | null) => (ms === null ? "none" : `${Math.round(ms)} ms`);
      lines.push(
        `'${s.text}' source ${formatClock(s.startMs)}-${formatClock(s.endMs)}  ${Math.round(s.durationMs)} ms vs expected ${Math.round(s.expectedMs)} ms (${(s.durationMs / s.expectedMs).toFixed(1)}x)  pause before ${pause(s.pauseBeforeMs)}, after ${pause(s.pauseAfterMs)}`,
      );
      lines.push(
        s.dipFound && s.dip
          ? `    dip found: yes (${s.dip.dropDb.toFixed(1)} dB at ${formatClock(s.dip.startMs)}-${formatClock(s.dip.endMs)}, ${s.side} of the word)`
          : "    dip found: no",
      );
      lines.push(
        s.cut
          ? `    cut range: source ${formatClock(s.cut.startMs)}-${formatClock(s.cut.endMs)} (${Math.round(s.cut.endMs - s.cut.startMs)} ms, ${Math.round(s.cut.insideWordMs)} ms inside the word = ${Math.round((100 * s.cut.insideWordMs) / s.durationMs)}%)`
          : `    cut range: none${s.note ? ` (${s.note})` : ""}`,
      );
      for (const g of s.gapDiagnosis) lines.push(`    ${g}`);
      lines.push(`    profile (50 ms, dB vs speech): ${s.profile}`);
    }
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

  return lines.join("\n");
}
