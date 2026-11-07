/**
 * A clip can never play, render or be captioned past the end of its FILE. The recorder's (and sometimes the player's) stated
 * length can be longer than what was written (camera flips end a segment early: the container may claim more than the video
 * track holds), so every place that turns clips into a range clamps to the real length first:
 *  - the real length is measured from the file (the native track timing: end of the video track) and remembered per uri,
 *  - `boundedEnd` / `sanitizeClips` clamp a clip's end to it (the clip's own durationMs is the fallback when the file was not
 *    measured), drop clips that become empty, and never throw,
 *  - `measureAndSanitize` measures the files (with an injected prober and a time limit) and then sanitizes.
 * One bad clip is clamped or dropped; it never blocks playback, posting or saving.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type BoundedClip = { uri?: string; type?: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

/** A clip shorter than this after clamping is dropped (it cannot be played or rendered into a frame). */
export const MIN_BOUNDED_CLIP_MS = 80;

const lengths = new Map<string, number>();

/** Remember a file's real length (ms). Ignores anything that is not a positive number. */
export function setFileLengthMs(uri: string | undefined | null, ms: number | undefined | null): void {
  if (!uri || typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return;
  lengths.set(uri, Math.round(ms));
}

export function fileLengthMs(uri: string | undefined | null): number | undefined {
  return uri ? lengths.get(uri) : undefined;
}

export function resetFileLengths(): void {
  lengths.clear();
}

export type TrackTimingLike = { durationMs?: number; videoStartMs?: number; videoDurationMs?: number; audioStartMs?: number; audioDurationMs?: number } | null | undefined;

const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Everything known about how long one file really is (any of it may be missing or wrong). */
export type LengthEvidence = {
  /** The asset's own duration (the container). */
  containerMs?: number | null;
  /** The first video sample's time and the video track's duration, in movie time (the track need not start at 0). */
  videoStartMs?: number | null;
  videoDurationMs?: number | null;
  /** What the recorder measured while the take ran (wall clock). */
  recorderMs?: number | null;
  /** What a player reports for the file. */
  playerMs?: number | null;
};

export type LengthDecision = {
  /** The length to trust (ms); null when nothing reliable is known (the clip keeps its own numbers). */
  lengthMs: number | null;
  /** The FILE holds nothing: every measure that exists is under MIN_BOUNDED_CLIP_MS. Only then is the clip dropped. */
  empty: boolean;
  /** The measures contradict each other by a lot (worth a client error). */
  disagree: boolean;
  /** Where the video track ends (start + duration), if known. */
  videoEndMs: number | null;
};

/**
 * The length of a file from all the evidence. The end of the video track (its START plus its duration: a track may begin
 * after 0) is used when it agrees with the container; when it is tiny or far from the container / player (a bad probe) the
 * safest real value is used instead: min(container, player). A file is "empty" only if every measure says so.
 */
export function decideLength(e: LengthEvidence): LengthDecision {
  const container = isPos(e.containerMs) ? Math.round(e.containerMs) : null;
  const player = isPos(e.playerMs) ? Math.round(e.playerMs) : null;
  const recorder = isPos(e.recorderMs) ? Math.round(e.recorderMs) : null;
  const videoEnd = isPos(e.videoDurationMs) ? Math.round(Math.max(0, e.videoStartMs ?? 0) + e.videoDurationMs) : null;
  const all = [container, player, recorder, videoEnd].filter((v): v is number => v !== null);
  if (all.length === 0) return { lengthMs: null, empty: false, disagree: false, videoEndMs: null };
  if (all.every((v) => v < MIN_BOUNDED_CLIP_MS)) return { lengthMs: Math.max(...all), empty: true, disagree: false, videoEndMs: videoEnd };

  const playable = [container, player].filter((v): v is number => v !== null && v >= MIN_BOUNDED_CLIP_MS);
  const far = (a: number, b: number) => Math.abs(a - b) > Math.max(500, 0.3 * Math.max(a, b));
  const videoOk = videoEnd !== null && videoEnd >= MIN_BOUNDED_CLIP_MS;
  const minPlayable = playable.length > 0 ? Math.min(...playable) : null;
  // the video track is distrusted when it is tiny, or under half of what the container / player say (a bad probe);
  // a track that is merely shorter than the audio is real and is used
  const videoBad = videoEnd !== null && (!videoOk || (isPos(e.videoDurationMs) && e.videoDurationMs < MIN_BOUNDED_CLIP_MS) || (minPlayable !== null && videoEnd < 0.5 * minPlayable));
  const videoFar = videoEnd !== null && minPlayable !== null && far(videoEnd, minPlayable);
  const recorderFar = recorder !== null && minPlayable !== null && far(recorder, minPlayable);
  const disagree = videoBad || videoFar || (container !== null && player !== null && far(container, player)) || recorderFar || (videoBad && recorder !== null);

  let lengthMs: number | null;
  if (videoOk && !videoBad) {
    // the video track ends where it ends (audio may run longer); never past the container
    lengthMs = container !== null && container < videoEnd! ? container : videoEnd!;
  } else if (playable.length > 0) {
    lengthMs = Math.min(...playable);   // the safest real value, never the bogus tiny one
  } else {
    lengthMs = null;                     // only the recorder's clock is long: nothing reliable to clamp to
  }
  return { lengthMs, empty: false, disagree, videoEndMs: videoEnd };
}

/** The playable length from a native timing probe alone (see decideLength for the cross-checks); null if unknown. */
export function realLengthFromTiming(t: TrackTimingLike): number | null {
  if (!t) return null;
  const d = decideLength({ containerMs: t.durationMs, videoStartMs: t.videoStartMs, videoDurationMs: t.videoDurationMs });
  return d.lengthMs;
}

/** What `resolveLength` needs from the phone (all optional; each may fail or hang without harm). */
export type LengthIO = {
  timing: (uri: string) => Promise<TrackTimingLike>;
  playerMs?: (uri: string) => Promise<number | null>;
  fileSize?: (uri: string) => Promise<number | null>;
  recorderMs?: (uri: string) => number | null | undefined;
  /** Called when the measures disagree: everything we know, for the client error. */
  report?: (info: Record<string, unknown>) => void;
};

/**
 * One file's length: the native track timing first; when it disagrees with the other measures (or says the file is tiny while
 * the recorder / player say it is long) the player is asked too, both values are reported, and the safest real value is used.
 * A tiny result is returned as is only when the file is empty by every measure (then the clip is dropped).
 */
export async function resolveLength(uri: string, io: LengthIO): Promise<number | null> {
  const t = await io.timing(uri).catch(() => null);
  const ev: LengthEvidence = {
    containerMs: t?.durationMs,
    videoStartMs: t?.videoStartMs,
    videoDurationMs: t?.videoDurationMs,
    recorderMs: io.recorderMs?.(uri) ?? null,
  };
  let d = decideLength(ev);
  if (d.disagree && io.playerMs) {
    ev.playerMs = await io.playerMs(uri).catch(() => null);
    d = decideLength(ev);
  }
  if (d.disagree) {
    let fileSize: number | null = null;
    try {
      fileSize = (await io.fileSize?.(uri)) ?? null;
    } catch {
      fileSize = null;
    }
    try {
      io.report?.({ uri, fileSize, containerMs: ev.containerMs ?? null, videoStartMs: ev.videoStartMs ?? null, videoDurationMs: ev.videoDurationMs ?? null, videoEndMs: d.videoEndMs, audioDurationMs: t?.audioDurationMs ?? null, recorderMs: ev.recorderMs ?? null, playerMs: ev.playerMs ?? null, usedMs: d.lengthMs });
    } catch {
      // reporting never matters
    }
  }
  return d.lengthMs;
}

/** What a clip may not go beyond: the measured length of its file, else its own durationMs; undefined when neither is known. */
export function limitOf(c: BoundedClip): number | undefined {
  const real = fileLengthMs(c.uri);
  if (real !== undefined) return real;
  return typeof c.durationMs === "number" && Number.isFinite(c.durationMs) && c.durationMs > 0 ? c.durationMs : undefined;
}

/** A clip's source end: trimEnd 0 / missing means the end of the file; never past the file's real length. */
export function boundedEnd(c: BoundedClip): number {
  const raw = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
  const end = Number.isFinite(raw) ? raw : (c.trimStartMs ?? 0);
  const limit = limitOf(c);
  return limit !== undefined && end > limit ? limit : end;
}

/**
 * The clips with every end clamped to the real length of its file, and clips that become empty (or were already empty
 * ranges past the end) dropped. Images are left alone. Returns the SAME array when nothing changed.
 */
export function sanitizeClips<T extends BoundedClip>(clips: T[]): T[] {
  let changed = false;
  const out: T[] = [];
  for (const c of clips) {
    if (c.type === "image") {
      out.push(c);
      continue;
    }
    const limit = limitOf(c);
    const start = c.trimStartMs ?? 0;
    const rawEnd = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
    if (limit === undefined || !(rawEnd > limit || (c.durationMs !== undefined && c.durationMs > limit))) {
      out.push(c);
      continue;
    }
    changed = true;
    const end = Math.min(rawEnd > 0 ? rawEnd : limit, limit);
    if (end - start < MIN_BOUNDED_CLIP_MS) continue;
    out.push({ ...c, trimEndMs: end, durationMs: limit });
  }
  return changed ? out : clips;
}

/** True when the clip holds nothing once clamped to its file (sanitizeClips would drop it); false when it needs no clamping. */
export function isEmptyAfterClamp(c: BoundedClip): boolean {
  return sanitizeClips([c]).length === 0;
}

export type LengthProbe = (uri: string) => Promise<number | null>;

/** Measure every distinct video file of `clips` (a failed or slow probe just leaves that file unmeasured). */
export async function measureFiles(clips: BoundedClip[], probe: LengthProbe, timeoutMs: number = 2500): Promise<void> {
  const uris = [...new Set(clips.filter((c) => c.type !== "image" && c.uri && fileLengthMs(c.uri) === undefined).map((c) => c.uri as string))];
  await Promise.all(
    uris.map(async (uri) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const ms = await Promise.race([
          probe(uri).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        setFileLengthMs(uri, ms);
      } catch {
        // unmeasured: the clip keeps its own numbers
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}

/** Measure the files, then clamp / drop. Clips that arrive without a durationMs get the measured one. Never throws. */
export async function measureAndSanitize<T extends BoundedClip>(clips: T[], probe: LengthProbe, timeoutMs?: number): Promise<T[]> {
  try {
    await measureFiles(clips, probe, timeoutMs);
  } catch {
    // sanitize with whatever is known
  }
  const withLength = clips.map((c) => {
    const real = c.type === "image" ? undefined : fileLengthMs(c.uri);
    return real !== undefined && !(c.durationMs && c.durationMs > 0) ? { ...c, durationMs: real } : c;
  });
  return sanitizeClips(withLength);
}

/**
 * What a player's status event may change on the clip it is attributed to. A file with a known length (measured, or the merged
 * file's verified render length) keeps it: the event can still be the previous clip's player. Only an unmeasured file takes
 * the player's number. Returns the corrected clip, or null when nothing changes.
 */
export function applyPlayerDuration<T extends BoundedClip>(clip: T, sourceDur: number): T | null {
  const known = fileLengthMs(clip.uri);
  const realDur = known !== undefined ? known : sourceDur;
  if (!(realDur > 0)) return null;
  const end = clip.trimEndMs ?? 0;
  const needs = clip.durationMs === undefined || clip.durationMs === 0 || Math.abs(clip.durationMs - realDur) > 100 || end > realDur + 100;
  if (!needs) return null;
  return { ...clip, durationMs: realDur, trimEndMs: clip.trimEndMs !== undefined && clip.trimEndMs > 0 ? Math.min(clip.trimEndMs, realDur) : realDur };
}
