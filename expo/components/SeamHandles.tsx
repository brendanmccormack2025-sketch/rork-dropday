import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { getThumbnailAsync } from "expo-video-thumbnails";
import { theme } from "@/constants/theme";
import type { SeamEdgeInfo, SeamHandleSpec } from "@/lib/autoEdit/seams";

/** Each side of a seam is a 44 pt wide drag target (the minimum). */
export const SEAM_HANDLE_W = 44;
/** A touch that moves less than this and ends quickly is a tap, not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 350;
/** Spacing of the ghost strip's frames. */
const GHOST_STEP_MS = 1000;
const GHOST_MAX_TILES = 12;
const PREVIEW_W = 56;
const PREVIEW_H = 100;

type SeamHandleProps = {
  spec: SeamHandleSpec;
  /** Screen x of the seam, top and height of the clips. */
  x: number;
  top: number;
  height: number;
  msPerPx: number;
  active: boolean;
  onDragStart: (edge: SeamEdgeInfo) => void;
  onDragMove: (edge: SeamEdgeInfo, newSourceMs: number) => void;
  onDragEnd: (edge: SeamEdgeInfo, newSourceMs: number) => void;
  onTap: (clipId: string) => void;
};

/**
 * The drag handle of one seam. Touching the left half grabs the end of the clip before the seam, the right half the
 * start of the clip after it. A short touch is a tap on that clip (selecting it), so clips stay tappable under it.
 */
export function SeamHandle(props: SeamHandleProps) {
  const ref = useRef(props);
  ref.current = props;
  const gesture = useRef<{ edge: SeamEdgeInfo; startedAt: number; dragged: boolean } | null>(null);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const { spec } = ref.current;
          const edge = spec.prev && spec.next ? (e.nativeEvent.locationX < SEAM_HANDLE_W ? spec.prev : spec.next) : (spec.prev ?? spec.next);
          if (!edge) return;
          gesture.current = { edge, startedAt: Date.now(), dragged: false };
        },
        onPanResponderMove: (_, gs) => {
          const g = gesture.current;
          if (!g) return;
          if (!g.dragged) {
            if (Math.abs(gs.dx) < TAP_SLOP_PX) return;
            g.dragged = true;
            ref.current.onDragStart(g.edge);
          }
          ref.current.onDragMove(g.edge, g.edge.atMs + gs.dx * ref.current.msPerPx);
        },
        onPanResponderRelease: (_, gs) => {
          const g = gesture.current;
          gesture.current = null;
          if (!g) return;
          if (g.dragged) ref.current.onDragEnd(g.edge, g.edge.atMs + gs.dx * ref.current.msPerPx);
          else if (Date.now() - g.startedAt <= TAP_MAX_MS) ref.current.onTap(g.edge.clipId);
        },
        onPanResponderTerminate: (_, gs) => {
          const g = gesture.current;
          gesture.current = null;
          // A drag the system takes away is not applied.
          if (g?.dragged) ref.current.onDragEnd(g.edge, g.edge.atMs);
        },
      }),
    [],
  );

  const { spec, x, top, height, active } = props;
  const leftW = spec.prev ? SEAM_HANDLE_W : 0;
  const width = leftW + (spec.next ? SEAM_HANDLE_W : 0);
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Drag to show or cut footage"
      style={[styles.zone, { left: x - leftW, top, width, height }]}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={[styles.pill, { left: leftW - 2 }, active && styles.pillActive]} />
    </View>
  );
}

// ── Frames ───────────────────────────────────────────────────────────────────

const frameCache = new Map<string, string>();

async function frameAt(uri: string, ms: number): Promise<string | null> {
  const t = Math.max(0, Math.round(ms));
  const key = `${uri}@${t}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  try {
    const r = await getThumbnailAsync(uri, { time: t, quality: 0.4 });
    frameCache.set(key, r.uri);
    return r.uri;
  } catch {
    return null;
  }
}

/** Frames for a set of source times, loaded one after the other; what is loaded so far is returned. */
function useFrames(uri: string, times: number[]): Record<number, string> {
  const [frames, setFrames] = useState<Record<number, string>>({});
  const key = times.join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const t of times) {
        if (cancelled) return;
        const hit = frameCache.get(`${uri}@${Math.round(t)}`);
        if (hit) {
          setFrames((p) => (p[t] === hit ? p : { ...p, [t]: hit }));
          continue;
        }
        const f = await frameAt(uri, t);
        if (f && !cancelled) setFrames((p) => ({ ...p, [t]: f }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, key]);
  return frames;
}

export type SeamDragView = {
  uri: string;
  side: "left" | "right";
  kind: "reveal" | "cut";
  /** The footage that comes back or goes (source ms). */
  startMs: number;
  endMs: number;
  /** Where the edge is now (source ms), and how far it moved. */
  edgeMs: number;
  deltaMs: number;
};

/** "+0.4s" / "-0.4s": how much footage was added or removed. */
export function seamDeltaLabel(deltaMs: number): string {
  const s = Math.abs(deltaMs) / 1000;
  return `${deltaMs < 0 ? "-" : "+"}${s.toFixed(1)}s`;
}

/**
 * While a seam is dragged: the cut-out footage as a ghosted strip at the seam, and a live frame of the edge with
 * its time label above the timeline.
 */
export function SeamDragOverlay({
  view,
  x,
  top,
  height,
  pxPerMs,
  containerW,
  bubbleTop,
}: {
  view: SeamDragView;
  x: number;
  top: number;
  height: number;
  pxPerMs: number;
  containerW: number;
  bubbleTop: number;
}) {
  const stripW = (view.endMs - view.startMs) * pxPerMs;
  const step = Math.max(GHOST_STEP_MS, Math.ceil((view.endMs - view.startMs) / GHOST_MAX_TILES / GHOST_STEP_MS) * GHOST_STEP_MS);
  // The strip is a fixed grid starting at the original edge, so frames loaded earlier in the drag are reused.
  const anchorMs = view.side === "right" ? view.startMs : view.endMs;
  const dir = view.side === "right" ? 1 : -1;
  const count = view.kind === "reveal" ? Math.min(GHOST_MAX_TILES, Math.max(1, Math.ceil((view.endMs - view.startMs) / step))) : 0;
  const tileTimes = useMemo(
    () => Array.from({ length: count }, (_, k) => Math.max(0, Math.round(anchorMs + dir * (k * step + step / 2)))),
    [count, anchorMs, dir, step],
  );
  const tiles = useFrames(view.uri, tileTimes);

  // The live frame at the edge, one request at a time, newest wins.
  const [live, setLive] = useState<string | null>(null);
  const wanted = useRef(0);
  const busy = useRef(false);
  const bucket = Math.round(view.edgeMs / 60) * 60;
  useEffect(() => {
    wanted.current = bucket;
    if (busy.current) return;
    busy.current = true;
    (async () => {
      let last = -1;
      while (last !== wanted.current) {
        last = wanted.current;
        const f = await frameAt(view.uri, last);
        if (f) setLive(f);
      }
      busy.current = false;
    })();
  }, [bucket, view.uri]);

  const bubbleLeft = Math.min(Math.max(4, x - PREVIEW_W / 2), Math.max(4, containerW - PREVIEW_W - 4));
  const stripLeft = view.side === "right" ? x : x - stripW;
  return (
    <>
      {view.kind === "reveal" && stripW > 0 && (
        <View pointerEvents="none" style={[styles.strip, { left: stripLeft, top, width: stripW, height }]}>
          {tileTimes.map((t, k) => {
            const w = (step * pxPerMs);
            const left = view.side === "right" ? k * w : stripW - (k + 1) * w;
            return tiles[t] ? <Image key={t} source={{ uri: tiles[t]! }} style={{ position: "absolute", left, top: 0, width: w, height }} resizeMode="cover" /> : null;
          })}
        </View>
      )}
      <View pointerEvents="none" style={[styles.bubble, { left: bubbleLeft, top: bubbleTop, width: PREVIEW_W, height: PREVIEW_H }]}>
        {live ? <Image source={{ uri: live }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={styles.bubbleLabel}>
          <UiText style={styles.bubbleText} numberOfLines={1}>{`${(view.edgeMs / 1000).toFixed(1)}s`}</UiText>
          <UiText style={styles.bubbleDelta} numberOfLines={1}>{seamDeltaLabel(view.deltaMs)}</UiText>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  zone: { position: "absolute", zIndex: 20, justifyContent: "center" },
  pill: { position: "absolute", top: "20%", bottom: "20%", width: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.9)" },
  pillActive: { backgroundColor: theme.accent },
  strip: { position: "absolute", zIndex: 22, overflow: "hidden", opacity: 0.45, backgroundColor: "#000", borderRadius: 4 },
  bubble: { position: "absolute", zIndex: 70, borderRadius: 8, overflow: "hidden", backgroundColor: "#111", borderWidth: 1, borderColor: "rgba(255,255,255,0.4)" },
  bubbleLabel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 2, alignItems: "center", backgroundColor: "rgba(0,0,0,0.55)" },
  bubbleText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  bubbleDelta: { color: "#fff", fontSize: 10, opacity: 0.85 },
});
