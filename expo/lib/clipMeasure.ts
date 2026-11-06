/** The native side of lib/clipBounds.ts: the real length of a recorded file (probeTimingAsync, cross-checked), never ~0 by mistake. */
import { createVideoPlayer } from "expo-video";

import { recordBreadcrumb, recordClientError } from "@/lib/clientErrors";
import { fileLengthMs, measureAndSanitize, measureFiles, resolveLength, type BoundedClip, type LengthIO } from "@/lib/clipBounds";
import { getInfoAsync } from "@/lib/fileSystemCompat";
import { probeTimingAsync } from "@/modules/video-render";

/** All files are measured at once; one that does not answer by then is left unmeasured (its own numbers stay). */
export const MEASURE_TIMEOUT_MS = 2_500;
const PLAYER_MS = 2_500;

let crumbs = 0;

/** What a detached player says the file lasts (ms), or null. Only asked when the native timing disagrees with the rest. */
async function playerDurationMs(uri: string): Promise<number | null> {
  let player: ReturnType<typeof createVideoPlayer> | null = null;
  try {
    player = createVideoPlayer({ uri });
    const p = player;
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        sub.remove();
        resolve(false);
      }, PLAYER_MS);
      const sub = p.addListener("statusChange", ({ status }) => {
        if (status === "readyToPlay" || status === "error") {
          clearTimeout(timer);
          sub.remove();
          resolve(status === "readyToPlay");
        }
      });
    });
    const ms = ok ? Math.round((p.duration || 0) * 1000) : 0;
    return ms > 0 ? ms : null;
  } catch {
    return null;
  } finally {
    try {
      player?.release();
    } catch {
      // released already
    }
  }
}

function ioFor(clips: BoundedClip[]): LengthIO {
  const index = new Map<string, number>();
  const hint = new Map<string, number>();
  clips.forEach((c, i) => {
    if (!c.uri) return;
    if (!index.has(c.uri)) index.set(c.uri, i);
    const m = (c as { measuredMs?: number }).measuredMs;
    if (typeof m === "number" && m > 0) hint.set(c.uri, m);
  });
  return {
    timing: (uri) => probeTimingAsync(uri),
    playerMs: playerDurationMs,
    fileSize: async (uri) => {
      const info = await getInfoAsync(uri);
      return info.exists ? ((info as { size?: number }).size ?? null) : null;
    },
    recorderMs: (uri) => hint.get(uri),
    report: (info) => {
      void recordClientError(new Error("clip length: measurements disagree"), { kind: "clipLength", index: index.get(String(info.uri)) ?? null, ...info, uri: String(info.uri).slice(-32) });
    },
  };
}

/** A prober that leaves a breadcrumb per clip (index, ms it took, length used). */
function loggedProbe(clips: BoundedClip[]): (uri: string) => Promise<number | null> {
  const io = ioFor(clips);
  const index = new Map<string, number>();
  clips.forEach((c, i) => {
    if (c.uri && !index.has(c.uri)) index.set(c.uri, i);
  });
  return async (uri) => {
    const t0 = Date.now();
    const len = await resolveLength(uri, io);
    recordBreadcrumb(`measure clip ${index.get(uri) ?? "?"} #${++crumbs}`, { ms: Date.now() - t0, lengthMs: len });
    return len;
  };
}

/** The playable length of one file in ms, or null when it cannot be measured. */
export function probeFileLengthMs(uri: string): Promise<number | null> {
  return loggedProbe([{ uri }])(uri);
}

/** Clips with their files measured (in parallel, each file once), every end clamped, EMPTY files' clips dropped. Never throws. */
export function measureClips<T extends BoundedClip>(clips: T[], timeoutMs: number = MEASURE_TIMEOUT_MS): Promise<T[]> {
  return measureAndSanitize(clips, loggedProbe(clips), timeoutMs);
}

/** Start measuring in the background (the camera does this as each take ends), so the editor opens at once. */
export function warmFileLengths(clips: BoundedClip[]): void {
  if (clips.every((c) => c.type === "image" || !c.uri || fileLengthMs(c.uri) !== undefined)) return;
  void measureFiles(clips, loggedProbe(clips), MEASURE_TIMEOUT_MS).catch(() => {});
}
