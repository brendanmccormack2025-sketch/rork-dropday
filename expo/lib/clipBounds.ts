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

export type TrackTimingLike = { durationMs?: number; videoStartMs?: number; videoDurationMs?: number } | null | undefined;

/** The playable length from a native timing probe: the end of the video track, else the asset's duration; null if unknown. */
export function realLengthFromTiming(t: TrackTimingLike): number | null {
  if (!t) return null;
  const vd = t.videoDurationMs ?? -1;
  if (vd > 0) return Math.round(Math.max(0, t.videoStartMs ?? 0) + vd);
  const d = t.durationMs ?? -1;
  return d > 0 ? Math.round(d) : null;
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
export async function measureFiles(clips: BoundedClip[], probe: LengthProbe, timeoutMs: number = 4000): Promise<void> {
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
