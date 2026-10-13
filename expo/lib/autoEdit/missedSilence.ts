/**
 * Missed-silence hints: quiet stretches of the kept footage that the automatic edit left in, found from the loudness
 * analysis it already made (nothing new is analysed). They are only suggestions: tapping one offers "Cut this silence",
 * one tap cuts it. A protected laugh is never suggested (the stretch around it is cut short where it begins).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import { detectSilences, PAD_AFTER_SPEECH_MS, PAD_BEFORE_SPEECH_MS } from "../silenceDetection.ts";

type Range = { startMs: number; endMs: number };

/** A quiet stretch shorter than this is not worth a hint. */
export const HINT_MIN_MS = 400;

export type HintInput = {
  /** dB per window, as the loudness analysis stores them. */
  windows: number[];
  durationMs: number;
  /** The footage that is kept now (source ms). */
  keep: Range[];
  /** Protected laughs (source ms): never inside a hint. */
  protectedRanges?: Range[];
  /** The level at or below which a window is quiet; default: the one the silence detector uses for this audio. */
  thresholdDb?: number;
  minMs?: number;
  /** Breathing room left at each end of a hint (the detector's own padding by default). */
  padStartMs?: number;
  padEndMs?: number;
};

/** What is left of `r` once `holes` are taken out (holes sorted or not). */
function subtractAll(r: Range, holes: Range[]): Range[] {
  let pieces: Range[] = [r];
  for (const h of holes) {
    const next: Range[] = [];
    for (const p of pieces) {
      if (h.endMs <= p.startMs || h.startMs >= p.endMs) {
        next.push(p);
        continue;
      }
      if (h.startMs > p.startMs) next.push({ startMs: p.startMs, endMs: h.startMs });
      if (h.endMs < p.endMs) next.push({ startMs: h.endMs, endMs: p.endMs });
    }
    pieces = next;
  }
  return pieces;
}

/** The quiet stretches (source ms) still in the kept footage that are at least `minMs` long, protected laughs excluded. */
export function findMissedSilences(input: HintInput): Range[] {
  const { windows, durationMs, keep } = input;
  if (!Array.isArray(windows) || windows.length === 0 || !(durationMs > 0)) return [];
  const windowMs = durationMs / windows.length;
  const minMs = input.minMs ?? HINT_MIN_MS;
  const padStart = input.padStartMs ?? PAD_AFTER_SPEECH_MS;
  const padEnd = input.padEndMs ?? PAD_BEFORE_SPEECH_MS;
  const thresholdDb = input.thresholdDb ?? detectSilences(windows, windowMs, { durationMs }).thresholdDb;
  if (!Number.isFinite(thresholdDb)) return [];

  // runs of quiet windows (a window that cannot be measured is not quiet)
  const runs: Range[] = [];
  let from = -1;
  for (let i = 0; i <= windows.length; i++) {
    const v = windows[i];
    const quiet = i < windows.length && typeof v === "number" && Number.isFinite(v) && v <= thresholdDb;
    if (quiet && from < 0) from = i;
    if (!quiet && from >= 0) {
      runs.push({ startMs: from * windowMs, endMs: Math.min(durationMs, i * windowMs) });
      from = -1;
    }
  }

  const prot = [...(input.protectedRanges ?? [])].sort((a, b) => a.startMs - b.startMs);
  const out: Range[] = [];
  for (const run of runs) {
    for (const k of keep) {
      const s = Math.max(run.startMs, k.startMs);
      const e = Math.min(run.endMs, k.endMs);
      if (e - s < minMs) continue;
      for (const piece of subtractAll({ startMs: s, endMs: e }, prot)) {
        if (piece.endMs - piece.startMs < minMs) continue;
        // a stretch that starts or ends where the footage does needs no breathing room there
        const a = piece.startMs <= k.startMs ? piece.startMs : piece.startMs + padStart;
        const b = piece.endMs >= k.endMs ? piece.endMs : piece.endMs - padEnd;
        if (b > a) out.push({ startMs: Math.round(a), endMs: Math.round(b) });
      }
    }
  }
  return out.sort((x, y) => x.startMs - y.startMs);
}
