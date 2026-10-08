/**
 * Where the drag handles go on the Cuts-screen timeline, and keeping text overlays on their footage when the
 * clips change. Pure; erasable TypeScript only so the Node tests can run it.
 */
import { mapOutputPosition } from "./markers.ts";
import type { SeamEdge } from "./reshape.ts";

export type SeamClip = { id: string; uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

export type SeamEdgeInfo = SeamEdge & { clipId: string };

/** One handle: at `outputMs` on the output timeline, for the clip ending there (`prev`) and the one starting there (`next`). */
export type SeamHandleSpec = { id: string; outputMs: number; prev?: SeamEdgeInfo; next?: SeamEdgeInfo };

function bounds(c: SeamClip) {
  const start = c.trimStartMs ?? 0;
  const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
  return { start, end };
}

/**
 * A handle at the start, at the end and at every seam between two clips of the source. Nothing for other clips
 * (photos, other videos): they keep their own trim handles.
 */
export function buildSeamHandles(clips: SeamClip[], sourceUri: string): SeamHandleSpec[] {
  if (clips.length === 0 || !clips.every((c) => c.uri === sourceUri)) return [];
  const out: SeamHandleSpec[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    const { start, end } = bounds(c);
    if (end <= start) return;
    const left: SeamEdgeInfo = { side: "left", atMs: start, clipId: c.id };
    const right: SeamEdgeInfo = { side: "right", atMs: end, clipId: c.id };
    if (i === 0) out.push({ id: "seam:0", outputMs: 0, next: left });
    else out[out.length - 1]!.next = left;
    t += end - start;
    out.push({ id: `seam:${Math.round(t)}`, outputMs: t, prev: right });
  });
  return out;
}

type Timed = { startMs?: number; endMs?: number };

/**
 * Keep timed overlays on the footage they were placed on when the clips change: a time is mapped to the source
 * moment it showed and back onto the new clips. An overlay anchored to the very start or end of the video stays
 * anchored to it; one without times (the whole video) is untouched.
 */
export function remapOverlayTimes<T extends Timed>(
  overlays: T[],
  oldClips: Array<{ uri: string; trimStartMs: number; trimEndMs: number }>,
  newClips: Array<{ uri: string; trimStartMs: number; trimEndMs: number }>,
  sourceUri: string,
): T[] {
  const total = (cs: typeof oldClips) => cs.reduce((n, c) => n + Math.max(0, c.trimEndMs - c.trimStartMs), 0);
  const oldTotal = total(oldClips);
  const newTotal = total(newClips);
  const map = (ms: number, edge: "start" | "end") => {
    if (edge === "start" && ms <= 0) return 0;
    if (edge === "end" && ms >= oldTotal) return newTotal;
    return Math.round(mapOutputPosition(oldClips, newClips, ms, sourceUri));
  };
  return overlays.map((o) => {
    if (o.startMs === undefined && o.endMs === undefined) return o;
    const startMs = o.startMs === undefined ? undefined : map(o.startMs, "start");
    const endMs = o.endMs === undefined ? undefined : map(o.endMs, "end");
    if (startMs === o.startMs && endMs === o.endMs) return o;
    return { ...o, ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs: Math.max(endMs, (startMs ?? 0) + 1) } : {}) };
  });
}
