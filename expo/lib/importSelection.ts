/**
 * What the camera-roll picker returns -> clips for the editor: one photo or video as before, or several VIDEOS
 * in the order they were picked (up to MAX_IMPORT_VIDEOS, within the total length limit). Reordering helpers
 * for the "Arrange" step.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
export const MAX_IMPORT_VIDEOS = 10;

export type PickedAsset = { uri: string; type?: string | null; duration?: number | null };

export type ImportClip = { id: string; uri: string; type: "image" | "video"; durationMs?: number };

export type SelectionResult =
  | { ok: true; kind: "single" | "multi"; clips: ImportClip[] }
  | { ok: false; reason: "empty" | "mixed" | "too-long" | "too-many"; title: string; message: string };

const isVideo = (a: PickedAsset) => a.type === "video";

/**
 * Validate a pick. `maxTotalMs` applies to the SUM of the videos (the same limit as one recording);
 * `newId` makes the clip ids. Order is kept exactly as given.
 */
export function validateSelection(assets: PickedAsset[], maxTotalMs: number, newId: () => string): SelectionResult {
  if (assets.length === 0) return { ok: false, reason: "empty", title: "Nothing selected", message: "Pick a photo or a video." };
  const maxMinutes = Math.round((maxTotalMs / 60000) * 10) / 10;
  if (assets.length === 1) {
    const a = assets[0]!;
    if (isVideo(a) && (a.duration ?? 0) > maxTotalMs) {
      return { ok: false, reason: "too-long", title: "Video too long", message: `Clips can be up to ${maxMinutes} minutes. Trim the video in your photo library and try again.` };
    }
    return { ok: true, kind: "single", clips: [toClip(a, newId())] };
  }
  if (assets.length > MAX_IMPORT_VIDEOS) {
    return { ok: false, reason: "too-many", title: "Too many videos", message: `Pick up to ${MAX_IMPORT_VIDEOS} videos.` };
  }
  if (!assets.every(isVideo)) {
    return { ok: false, reason: "mixed", title: "Videos only", message: "To combine clips, pick videos only. For a photo, pick just one." };
  }
  const total = assets.reduce((sum, a) => sum + (a.duration ?? 0), 0);
  if (total > maxTotalMs) {
    return { ok: false, reason: "too-long", title: "Too long together", message: `Your videos add up to more than ${maxMinutes} minutes. Pick fewer or shorter videos.` };
  }
  return { ok: true, kind: "multi", clips: assets.map((a) => toClip(a, newId())) };
}

function toClip(a: PickedAsset, id: string): ImportClip {
  return { id, uri: a.uri, type: isVideo(a) ? "video" : "image", ...(isVideo(a) && a.duration ? { durationMs: Math.round(a.duration) } : {}) };
}

/** Move the item at `from` to `to` (both clamped). Returns a new list. */
export function moveItem<T>(list: ReadonlyArray<T>, from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item!);
  return out;
}

export function removeItem<T>(list: ReadonlyArray<T>, at: number): T[] {
  return list.filter((_, i) => i !== at);
}

export function totalDurationMs(clips: ReadonlyArray<{ durationMs?: number }>): number {
  return clips.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
}
