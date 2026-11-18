/**
 * Long footage is stored as ~1-minute SEGMENTS (migration-money-segments.sql). Pure helpers: which segments cover a marked section, whether a section
 * can be made yet, how long the rest of an upload will take ("about 12 minutes left"), and the free-space checks. The database decides the plan
 * (how many segments, which times); the phone follows it.
 */
export type SegmentInfo = { idx: number; start_s: number | string; end_s: number | string; status: "uploading" | "ready" | string };

/** A section a clipper marks can be at most this long (the final clip is made from it in the editor). */
export const MAX_SECTION_SECONDS = 180;
/** What the segmenting cut costs on this phone today (the measured speed of the software renderer: about 25 s per minute of video). */
export const DEFAULT_CUT_SECONDS_PER_VIDEO_SECOND = 25 / 60;
/** Home Wi-Fi upstream used for a first estimate before a real upload has been measured (19 Mbps at 80 %). */
export const DEFAULT_UPLOAD_BYTES_PER_SECOND = (19_000_000 / 8) * 0.8;
/** A first guess of a segment's size before one has been cut: about 6 Mbps video. */
export const DEFAULT_BYTES_PER_VIDEO_SECOND = 750_000;
/** Working space needed while cutting and uploading (two segments in flight and a margin). */
export const WORKING_SPACE_BYTES = 600 * 1024 ** 2;
/** Before the camera roll opens: the picker copies each video into Tryal's cache first, so ask for room. */
export const PICK_MIN_FREE_BYTES = 1.5 * 1024 ** 3;

const num = (v: number | string): number => Number(v);

/** The segments that overlap [startS, endS), in order. */
export function coveringSegments<T extends SegmentInfo>(segments: T[], startS: number, endS: number): T[] {
  return segments.filter((s) => num(s.end_s) > startS && num(s.start_s) < endS).sort((a, b) => a.idx - b.idx);
}

/** For each covering segment, the part of IT to keep (milliseconds from the start of that segment's own file), so the pieces join into exactly [startS, endS). */
export function sectionRanges<T extends SegmentInfo>(segments: T[], startS: number, endS: number): Array<{ segment: T; startMs: number; endMs: number }> {
  return coveringSegments(segments, startS, endS).map((segment) => {
    const s0 = num(segment.start_s), s1 = num(segment.end_s);
    return { segment, startMs: Math.round((Math.max(startS, s0) - s0) * 1000), endMs: Math.round((Math.min(endS, s1) - s0) * 1000) };
  });
}

export type SectionCheck = { ok: true; seconds: number } | { ok: false; reason: string };
/** Can this section be made? It must be in order, at most 3 minutes, and every part it needs must be uploaded already. */
export function sectionCheck(segments: SegmentInfo[], startS: number | null, endS: number | null, videoSeconds: number): SectionCheck {
  if (startS === null || endS === null) return { ok: false, reason: "Mark where the section starts and ends." };
  if (!(endS > startS)) return { ok: false, reason: "The end has to be after the start." };
  if (endS - startS > MAX_SECTION_SECONDS) return { ok: false, reason: `A section can be at most ${MAX_SECTION_SECONDS / 60} minutes. Move the start or the end.` };
  if (startS < 0 || endS > videoSeconds + 0.5) return { ok: false, reason: "That is outside the video." };
  const cover = coveringSegments(segments, startS, endS);
  if (!cover.length) return { ok: false, reason: "That part of the video is not available." };
  const missing = cover.filter((s) => s.status !== "ready");
  if (missing.length) return { ok: false, reason: `Part ${missing[0].idx + 1} of this video is still uploading. Try again in a moment, or choose an earlier section.` };
  return { ok: true, seconds: endS - startS };
}

const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Seconds left for a video: the rest of its segments. Cutting and uploading overlap, so each remaining segment costs the SLOWER of the two (measured
 * from the last few finished segments; before any, a first estimate), plus the shorter one once to fill the pipeline.
 */
export function estimateRemainingSeconds(o: { remaining: number; segmentSeconds: number; cutSeconds: number[]; uploadSeconds: number[]; bytesPerSegment?: number; uploadBytesPerSecond?: number }): number {
  if (o.remaining <= 0) return 0;
  const cut = avg(o.cutSeconds.slice(-3)) ?? o.segmentSeconds * DEFAULT_CUT_SECONDS_PER_VIDEO_SECOND;
  const up = avg(o.uploadSeconds.slice(-3)) ?? (o.bytesPerSegment ?? o.segmentSeconds * DEFAULT_BYTES_PER_VIDEO_SECOND) / (o.uploadBytesPerSecond ?? DEFAULT_UPLOAD_BYTES_PER_SECOND);
  return o.remaining * Math.max(cut, up) + Math.min(cut, up);
}

/** "about 12 minutes left" (never false precision: rounds up to whole minutes, switches to hours past 90). */
export function etaLabel(seconds: number): string {
  if (!(seconds > 0)) return "";
  if (seconds < 60) return "less than a minute left";
  const m = Math.ceil(seconds / 60);
  if (m < 90) return `about ${m} ${m === 1 ? "minute" : "minutes"} left`;
  const h = Math.floor(m / 60), r = m % 60;
  return `about ${h} h${r ? ` ${r} min` : ""} left`;
}

export type SpaceCheck = { ok: true } | { ok: false; message: string };
const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`;
/** Is there enough free space? `needBytes` is what the step needs; unknown free space (null) never blocks. */
export function spaceCheck(freeBytes: number | null, needBytes: number): SpaceCheck {
  if (freeBytes === null || freeBytes >= needBytes) return { ok: true };
  return { ok: false, message: `Not enough free space on this phone (${gb(Math.max(0, freeBytes))} free, about ${gb(needBytes)} needed). Free up some space and try again.` };
}
