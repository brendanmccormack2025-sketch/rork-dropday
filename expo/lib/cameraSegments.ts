/**
 * TikTok-style camera recording: a take is made of runs (record -> pause), at most 60 s in total.
 * Pure helpers for the camera screen and its hook; erasable TypeScript only so the Node tests can run them.
 *
 * A run is one start-to-pause stretch. A camera flip during a run splits it into several files, so a run can own
 * more than one clip; "delete last" always removes a whole run.
 */

/** Total recording length the camera allows. */
export const MAX_CAMERA_MS = 60_000;
/** A video reaction is short: at most this long (the camera stops there, and the editor will not post a longer one). */
export const REACTION_MAX_MS = 10_000;
/** A reaction this long is still accepted (rounding of clip lengths). */
const REACTION_SLACK_MS = 250;
/** null when a reaction of this length can be posted, else what to tell the person. */
export function reactionTooLong(totalMs: number): string | null {
  if (totalMs <= REACTION_MAX_MS + REACTION_SLACK_MS) return null;
  const over = Math.ceil((totalMs - REACTION_MAX_MS) / 1000);
  return `Reactions can be up to ${REACTION_MAX_MS / 1000} seconds. Trim ${over} more second${over === 1 ? "" : "s"} to post it.`;
}
/** Next is available once this much is recorded. */
export const MIN_NEXT_MS = 1_000;

export type CameraSegment = { id: string; uri: string; type: "video" | "image"; runId?: string; measuredMs?: number };

/** Length of one clip as measured while recording (photos and unknowns count as 0). */
const lengthOf = (s: CameraSegment) => (s.type === "video" ? Math.max(0, s.measuredMs ?? 0) : 0);

/** The segments worth merging: a video whose recorded length is known to be empty (< 200 ms) is left out. */
export function usableSegments<T extends CameraSegment>(segments: ReadonlyArray<T>): T[] {
  return segments.filter((s) => s.type !== "video" || s.measuredMs === undefined || s.measuredMs >= 200);
}

export function totalMs(segments: ReadonlyArray<CameraSegment>): number {
  return segments.reduce((n, s) => n + lengthOf(s), 0);
}

/** What is left to record, given the live run's length so far. Never negative. */
export function remainingMs(segments: ReadonlyArray<CameraSegment>, liveMs = 0, maxMs = MAX_CAMERA_MS): number {
  return Math.max(0, maxMs - totalMs(segments) - Math.max(0, liveMs));
}

/** The `maxDuration` (whole seconds, at least 1) to give the recorder so it stops by itself at the cap. */
export function maxDurationSeconds(segments: ReadonlyArray<CameraSegment>, liveMs = 0, maxMs = MAX_CAMERA_MS): number {
  return Math.max(1, Math.ceil(remainingMs(segments, liveMs, maxMs) / 1000));
}

export function canRecordMore(segments: ReadonlyArray<CameraSegment>, liveMs = 0, maxMs = MAX_CAMERA_MS): boolean {
  return remainingMs(segments, liveMs, maxMs) >= 250;
}

export function canProceed(segments: ReadonlyArray<CameraSegment>): boolean {
  return totalMs(segments) >= MIN_NEXT_MS;
}

export type Run = { runId: string; ids: string[]; startMs: number; durationMs: number };

/** The runs in order, each with where it starts on the 60 s bar. */
export function runsOf(segments: ReadonlyArray<CameraSegment>): Run[] {
  const runs: Run[] = [];
  let at = 0;
  segments.forEach((s, i) => {
    if (s.type !== "video") return;
    const runId = s.runId ?? `solo:${i}`;
    const last = runs[runs.length - 1];
    if (last && last.runId === runId) {
      last.ids.push(s.id);
      last.durationMs += lengthOf(s);
    } else {
      runs.push({ runId, ids: [s.id], startMs: at, durationMs: lengthOf(s) });
    }
    at += lengthOf(s);
  });
  return runs;
}

/** Remove the most recent run. `removed` are the clips to delete from disk. */
export function deleteLastRun<T extends CameraSegment>(segments: ReadonlyArray<T>): { kept: T[]; removed: T[] } {
  const runs = runsOf(segments);
  const last = runs[runs.length - 1];
  if (!last) return { kept: [...segments], removed: [] };
  const drop = new Set(last.ids);
  return { kept: segments.filter((s) => !drop.has(s.id)), removed: segments.filter((s) => drop.has(s.id)) };
}

/**
 * Segmented progress bar: each run as a fraction of the bar (60 s, or 10 s for a reaction), and a notch at each run's start (not the
 * first). The live run, if any, is the last entry.
 */
export function barSegments(
  segments: ReadonlyArray<CameraSegment>,
  live?: { ms: number; /** The take in progress: its finished segments and the live part are one stretch (a flip makes no notch). */ runId?: string },
  maxMs = MAX_CAMERA_MS,
): Array<{ startFrac: number; widthFrac: number; live: boolean }> {
  const runs = runsOf(segments);
  const out = runs.map((r) => ({
    startFrac: Math.min(1, r.startMs / maxMs),
    widthFrac: Math.min(1, r.durationMs / maxMs),
    live: false,
  }));
  if (live && live.ms > 0) {
    const last = runs[runs.length - 1];
    const room = (ms: number) => Math.max(0, Math.min(1, ms / maxMs));
    if (last && live.runId !== undefined && last.runId === live.runId) {
      const entry = out[out.length - 1]!;
      entry.widthFrac = Math.min(1 - entry.startFrac, entry.widthFrac + room(live.ms));
      entry.live = true;
    } else {
      const start = totalMs(segments);
      out.push({
        startFrac: Math.min(1, start / maxMs),
        widthFrac: Math.max(0, Math.min(1 - start / maxMs, live.ms / maxMs)),
        live: true,
      });
    }
  }
  return out;
}

/** What a tap on the record button does: start (or continue) when stopped, pause when recording. */
export function tapAction(state: "idle" | "recording" | "stopping"): "start" | "pause" | "ignore" {
  if (state === "idle") return "start";
  if (state === "recording") return "pause";
  return "ignore";
}
