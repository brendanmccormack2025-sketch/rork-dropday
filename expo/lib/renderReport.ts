/**
 * One short message (about 6 s) describing what the render path did for the
 * post that was just published. Internal testers only (callers check).
 */
import { useEffect, useState } from "react";

type Listener = (message: string | null) => void;

export type RenderStats = {
  kind: "ahead" | "post";
  renderMs: number;
  durationMs: number;
  sizeBytes: number;
};

/** "Rendered in X s for a Y s clip (Z x real time), W MB"; Z = render time / clip length. */
export function formatRenderStats(s: RenderStats): string {
  const ratio = s.durationMs > 0 ? s.renderMs / s.durationMs : 0;
  return `Rendered${s.kind === "ahead" ? " ahead" : ""} in ${(s.renderMs / 1000).toFixed(1)} s for a ${(s.durationMs / 1000).toFixed(1)} s clip (${ratio.toFixed(2)} x real time), ${(s.sizeBytes / 1048576).toFixed(1)} MB`;
}

let lastStats: RenderStats | null = null;
const statsListeners = new Set<(s: RenderStats | null) => void>();

/** Remember the latest render (shown in Playback diagnostics) and log it in development. */
export function recordRenderStats(s: RenderStats): void {
  lastStats = s;
  if (__DEV__) console.log("[render]", formatRenderStats(s));
  statsListeners.forEach((l) => l(s));
}

export function useLastRenderStats(): RenderStats | null {
  const [s, setS] = useState<RenderStats | null>(lastStats);
  useEffect(() => {
    statsListeners.add(setS);
    setS(lastStats);
    return () => {
      statsListeners.delete(setS);
    };
  }, []);
  return s;
}

const SHOW_MS = 6000;
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

export function reportRender(message: string): void {
  current = message;
  listeners.forEach((l) => l(current));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    listeners.forEach((l) => l(null));
  }, SHOW_MS);
}

export function subscribeRenderReport(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
