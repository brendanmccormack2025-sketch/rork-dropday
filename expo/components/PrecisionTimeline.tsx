import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withDecay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { ChevronLeft, ChevronRight, X } from "lucide-react-native";

import UiText from "@/components/UiText";
import { MARKER_LOOK } from "@/components/TimelineEditor";
import { theme } from "@/constants/theme";
import { analysis } from "@/lib/autoEdit/analysis";
import type { LoudnessData } from "@/lib/autoEdit/analysisCache";
import type { TimelineMarker } from "@/lib/autoEdit/markers";
import type { EdgeDrag } from "@/lib/autoEdit/reshape";
import type { SeamEdgeInfo, SeamHandleSpec } from "@/lib/autoEdit/seams";
import { buildSnapTargets, snapParams, snapStart, snapStep, type SnapState, type TimedWord } from "@/lib/autoEdit/edgeSnap";
import {
  BOTTOM_MARKER_Y,
  INFO_H,
  LANE_H,
  LANE_TOP,
  TL_PAD,
  TOP_MARKER_Y,
  clampOffset,
  clampScale,
  edgeDragMs,
  fitScale,
  fitView,
  formatDeltaSeconds,
  formatTimeCs,
  grabAt,
  handleGeoms,
  msToX,
  nudgeFrameMs,
  pinchView,
  revealOffset,
  followOffset,
  safeFps,
  tapAt,
  timelineRects,
  waveformColumns,
  waveformPath,
  wavePiecesOf,
  xToMs,
  type ClipGeom,
  type HandleGeom,
  type MarkerGeom,
} from "@/lib/autoEdit/timelineView";
import type { DraftClip } from "@/providers/PostsProvider";

/** Bar pitch of the waveform, in points. */
const WAVE_PITCH = 3;
/** How far a settled drawing may drift from the live zoom before it is drawn again. */
const WAVE_REDRAW_RATIO = 0.12;
const FIT_ANIM_MS = 240;
/** Finger travel under this is a tap, not a drag. */
const TAP_SLOP = 3;
/** Preview frames are requested at most this often while an edge is dragged. */
const PREVIEW_EVERY_MS = 50;
/** An edge selected before an edit is found again after it within this distance (source ms). */
const EDGE_MATCH_MS = 150;

export type PrecisionSeams = {
  handles: SeamHandleSpec[];
  sourceUri: string;
  /** What a drag to `newSourceMs` would do. `minDragMs` lowers the jitter gate (precise drags, one-frame nudges). */
  describe: (edge: SeamEdgeInfo, newSourceMs: number, minDragMs?: number) => EdgeDrag;
  /** The places the automatic edit cut at. */
  boundaries: number[];
  onDragEnd: (edge: SeamEdgeInfo, newSourceMs: number, opts?: { minDragMs?: number }) => void;
  /** Transcript words (source ms): edges snap to their starts and ends. */
  words?: TimedWord[];
  /** The video's frame rate, when the player reports it (30 otherwise). */
  frameRate?: number | null;
  /** Length of the source video, ms. */
  sourceDurationMs: number;
  /** The automatic edit is idle: a missing loudness analysis may be made now (otherwise only a cached one is used). */
  canAnalyze?: boolean;
  /** Show the video frame at a source time (an edge being moved); null: back to the normal preview. */
  onEdgePreview?: (sourceMs: number | null) => void;
};

export type PrecisionTimelineProps = {
  clips: DraftClip[];
  totalDurationMs: number;
  positionMs: number;
  selectedClipId: string | null;
  onSeek: (positionMs: number) => void;
  onSelectClip: (clipId: string) => void;
  onDeselectAndPreview?: () => void;
  markers?: TimelineMarker[];
  onMarkerPress?: (marker: TimelineMarker) => void;
  /** Output-timeline ranges drawn as a subtle band (protected laughs). */
  bands?: Array<{ startMs: number; endMs: number }>;
  seams: PrecisionSeams;
  /** An error was caught in this timeline (a handler, a worklet): the owner switches to the previous timeline. */
  onFatal?: (error: unknown, where: string) => void;
};

type SelectedEdge = { side: "left" | "right"; atMs: number };

function haptic(kind: "light" | "select") {
  try {
    if (kind === "select") void Haptics.selectionAsync().catch(() => {});
    else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  } catch {
    // no haptics here
  }
}

/**
 * The loudness of the source, from the analysis the silence detector already made. Only what is already cached is
 * used while the automatic edit is still working (`canAnalyze` false): the waveform never starts a second audio
 * analysis next to the edit, the speech recognizer and the render. Once the edit is idle a missing analysis is made
 * once and cached. It is read a moment after the screen opens, and any failure just means no waveform.
 */
function useLoudness(uri: string, canAnalyze: boolean): LoudnessData | null {
  const [data, setData] = useState<LoudnessData | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const usable = (d: LoudnessData | null) => (d && Array.isArray(d.windows) && d.windows.length > 0 && d.durationMs > 0 ? d : null);
    const timer = setTimeout(() => {
      (async () => {
        try {
          let d = usable(await analysis.cachedLoudness(uri));
          if (!d && canAnalyze) d = usable(await analysis.loudness(uri));
          if (!cancelled) setData(d);
        } catch {
          // no waveform
        }
      })();
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [uri, canAnalyze]);
  return data;
}

// ── Pieces drawn from the shared view (they animate without re-rendering) ────

function ClipBar({ startMs, durMs, selected, scale, offset }: { startMs: number; durMs: number; selected: boolean; scale: SharedValue<number>; offset: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: msToX(startMs, scale.value, offset.value) }],
    width: Math.max(1, durMs * scale.value),
  }));
  return <Animated.View pointerEvents="none" style={[styles.clip, selected && styles.clipSelected, style]} />;
}

function Band({ startMs, endMs, scale, offset }: { startMs: number; endMs: number; scale: SharedValue<number>; offset: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: msToX(startMs, scale.value, offset.value) }],
    width: Math.max(2, (endMs - startMs) * scale.value),
  }));
  return <Animated.View pointerEvents="none" style={[styles.band, style]} />;
}

function HandlePills({
  geom,
  index,
  scale,
  offset,
  selIdx,
  selSide,
}: {
  geom: HandleGeom;
  index: number;
  scale: SharedValue<number>;
  offset: SharedValue<number>;
  selIdx: SharedValue<number>;
  selSide: SharedValue<number>;
}) {
  const prev = useAnimatedStyle(() => {
    const sel = selIdx.value === index && selSide.value === 0;
    return {
      transform: [{ translateX: msToX(geom.outputMs, scale.value, offset.value) - 5 }],
      top: LANE_TOP + (sel ? 0 : LANE_H * 0.18),
      height: sel ? LANE_H : LANE_H * 0.64,
      backgroundColor: sel ? theme.accent : "rgba(10,10,10,0.82)",
      width: sel ? 5 : 4,
    };
  });
  const next = useAnimatedStyle(() => {
    const sel = selIdx.value === index && selSide.value === 1;
    return {
      transform: [{ translateX: msToX(geom.outputMs, scale.value, offset.value) + 1 }],
      top: LANE_TOP + (sel ? 0 : LANE_H * 0.18),
      height: sel ? LANE_H : LANE_H * 0.64,
      backgroundColor: sel ? theme.accent : "rgba(10,10,10,0.82)",
      width: sel ? 5 : 4,
    };
  });
  return (
    <>
      {geom.hasPrev ? <Animated.View pointerEvents="none" style={[styles.pill, prev]} /> : null}
      {geom.hasNext ? <Animated.View pointerEvents="none" style={[styles.pill, next]} /> : null}
    </>
  );
}

function MarkerGlyph({ marker, scale, offset }: { marker: TimelineMarker; scale: SharedValue<number>; offset: SharedValue<number> }) {
  const look = MARKER_LOOK[marker.kind];
  const y = look.bottom ? BOTTOM_MARKER_Y : TOP_MARKER_Y;
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: msToX(marker.outputMs, scale.value, offset.value) - 6 }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.markerBox, { top: y - 6 }, style]}>
      <View style={[styles.markerGlyph, look.glyph]} />
    </Animated.View>
  );
}

// ── The component ────────────────────────────────────────────────────────────

/**
 * The Cuts screen's timeline right after the automatic edit: pinch to zoom (whole video down to about a second
 * across the screen), pan when zoomed, double-tap for the whole video. The edge handles keep a 44 pt touch zone at
 * every zoom; an edge drags at the zoom's precision, snaps to word starts / ends and the silence cuts, the preview
 * shows its frame, and the arrows move a selected edge one frame. Every change ends in the existing seam drag
 * handler (reshapeCutAtEdge: one undo step, captions and text follow).
 *
 * The view (scale, offset) lives in shared values and every drawn piece reads it in a worklet, so zoom, pan and the
 * edge drag run on the UI thread; React only re-renders when the clips change or the waveform is redrawn.
 */
export default function PrecisionTimeline({
  clips,
  totalDurationMs,
  positionMs,
  selectedClipId,
  onSeek,
  onSelectClip,
  onDeselectAndPreview,
  markers,
  onMarkerPress,
  bands,
  seams,
  onFatal,
}: PrecisionTimelineProps) {
  const [viewW, setViewW] = useState(0);
  const scale = useSharedValue(0.05);
  const offset = useSharedValue(0);
  const viewWSV = useSharedValue(0);
  const totalSV = useSharedValue(Math.max(1, totalDurationMs));
  const playMs = useSharedValue(positionMs);
  const touching = useSharedValue(false);

  // geometry for the UI thread
  const geomsSV = useSharedValue<HandleGeom[]>([]);
  const markersSV = useSharedValue<MarkerGeom[]>([]);
  const clipsSV = useSharedValue<ClipGeom[]>([]);
  const targetsSV = useSharedValue<number[]>([]);

  // selected edge (seam index + side) and the edge drag
  const selIdx = useSharedValue(-1);
  const selSide = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragIdx = useSharedValue(-1);
  const dragSide = useSharedValue(0);
  const dragAtMs = useSharedValue(0);
  const dragOutputMs = useSharedValue(0);
  const dragMs = useSharedValue(0);
  const dragMin = useSharedValue(-1e12);
  const dragMax = useSharedValue(1e12);
  const dragDx = useSharedValue(0);
  const dragOffsetStart = useSharedValue(0);
  const fingerX = useSharedValue(0);
  const snapState = useSharedValue<SnapState>({ target: null, released: null, anchorMs: 0, movedAt: 0 });
  const lastPreviewAt = useSharedValue(0);
  const lastPreviewMs = useSharedValue(-1);

  // gesture bookkeeping
  const mode = useSharedValue(0); // 1 edge, 2 playhead, 3 scroll
  const modeIdx = useSharedValue(-1);
  const modeSide = useSharedValue(0);
  const offsetStart = useSharedValue(0);
  const playGrabDx = useSharedValue(0);
  const lastSeekMs = useSharedValue(-1);
  const pinchStart = useSharedValue({ scale: 1, offset: 0, focalX: 0 });

  // waveform: drawn for a window around the settled view, moved and scaled by the live view in between
  const waveS0 = useSharedValue(0);
  const waveO0 = useSharedValue(0);
  const [wave, setWave] = useState<{ path: string; width: number } | null>(null);
  const settledRef = useRef<{ scale: number; offset: number } | null>(null);
  const waveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestView = useRef({ scale: 0, offset: 0 });

  const [selected, setSelectedState] = useState<SelectedEdge | null>(null);
  // the handle list the selection was made against: an edit that changes it can leave the edge nowhere
  const selectedAgainst = useRef<SeamHandleSpec[] | null>(null);
  // the edge being dragged right now (updated at most every PREVIEW_EVERY_MS from the UI thread)
  const [liveEdge, setLiveEdge] = useState<{ ms: number; atMs: number } | null>(null);
  const loudness = useLoudness(seams.sourceUri, seams.canAnalyze === true);

  // The latest props for the callbacks the UI thread calls (their identity never changes).
  const live = useRef({ clips, markers, seams, selected, selectedClipId, totalDurationMs, onSeek, onSelectClip, onDeselectAndPreview, onMarkerPress });
  live.current = { clips, markers, seams, selected, selectedClipId, totalDurationMs, onSeek, onSelectClip, onDeselectAndPreview, onMarkerPress };
  const setSelected = useCallback((next: SelectedEdge | null) => {
    selectedAgainst.current = live.current.seams.handles;
    setSelectedState(next);
  }, []);

  // Anything that goes wrong in a handler or a worklet is reported to the owner (which switches to the previous
  // timeline) instead of crashing the app.
  const fatalRef = useRef(onFatal);
  fatalRef.current = onFatal;
  const guard = useMemo(
    () =>
      <A extends unknown[]>(where: string, fn: (...a: A) => void) =>
      (...a: A): void => {
        try {
          fn(...a);
        } catch (e) {
          fatalRef.current?.(e, where);
        }
      },
    [],
  );
  const reportFatal = useCallback((where: string, message: string) => {
    fatalRef.current?.(new Error(message), where);
  }, []);

  // ── geometry ──
  const geoms = useMemo(() => handleGeoms(seams.handles), [seams.handles]);
  const clipGeoms = useMemo(() => {
    const out: ClipGeom[] = [];
    let t = 0;
    for (const c of clips) {
      const start = c.trimStartMs ?? 0;
      const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
      const dur = Math.max(0, end - start);
      out.push({ startMs: t, durMs: dur });
      t += dur;
    }
    return out;
  }, [clips]);
  const markerGeoms = useMemo<MarkerGeom[]>(() => (markers ?? []).map((m) => ({ outputMs: m.outputMs, bottom: MARKER_LOOK[m.kind].bottom })), [markers]);
  const targets = useMemo(() => buildSnapTargets(seams.words, seams.boundaries), [seams.words, seams.boundaries]);
  useEffect(() => {
    geomsSV.value = geoms;
    markersSV.value = markerGeoms;
    clipsSV.value = clipGeoms;
    targetsSV.value = targets;
  }, [geoms, markerGeoms, clipGeoms, targets, geomsSV, markersSV, clipsSV, targetsSV]);

  // ── the view: fit the whole video; keep the zoom when the clips change ──
  const prevFit = useRef<number | null>(null);
  useEffect(() => {
    if (viewW <= 0) return;
    viewWSV.value = viewW;
    totalSV.value = Math.max(1, totalDurationMs);
    const fit = fitScale(totalDurationMs, viewW);
    const wasFit = prevFit.current === null || Math.abs(scale.value - prevFit.current) <= prevFit.current * 0.001;
    prevFit.current = fit;
    if (wasFit) {
      scale.value = fit;
      offset.value = 0;
    } else {
      const s = clampScale(scale.value, totalDurationMs, viewW);
      scale.value = s;
      offset.value = clampOffset(offset.value, totalDurationMs, s, viewW);
    }
  }, [viewW, totalDurationMs, scale, offset, viewWSV, totalSV]);

  // the playhead follows the player (and scrolls into view when zoomed)
  useEffect(() => {
    if (!touching.value) playMs.value = positionMs;
    if (touching.value || viewW <= 0 || dragging.value) return;
    const next = followOffset(positionMs, scale.value, offset.value, totalDurationMs, viewW);
    if (next !== null) offset.value = withTiming(next, { duration: 180, easing: Easing.out(Easing.cubic) });
  }, [positionMs, viewW, totalDurationMs, touching, playMs, scale, offset, dragging]);

  // ── the selected edge → shared values ──
  const selectedHandle = useMemo(() => {
    if (!selected) return null;
    const want = selected.side;
    let best: { index: number; edge: SeamEdgeInfo } | null = null;
    let bestD = EDGE_MATCH_MS + 1;
    seams.handles.forEach((h, index) => {
      const edge = want === "right" ? h.prev : h.next;
      if (!edge) return;
      const d = Math.abs(edge.atMs - selected.atMs);
      if (d < bestD) {
        bestD = d;
        best = { index, edge };
      }
    });
    return best as { index: number; edge: SeamEdgeInfo } | null;
  }, [selected, seams.handles]);
  useEffect(() => {
    selIdx.value = selectedHandle ? selectedHandle.index : -1;
    selSide.value = selected?.side === "right" ? 0 : 1;
  }, [selectedHandle, selected, selIdx, selSide]);
  // an edit moved the edge somewhere we can no longer find: nothing is selected any more
  useEffect(() => {
    if (selected && !selectedHandle && seams.handles !== selectedAgainst.current) {
      setSelected(null);
      live.current.seams.onEdgePreview?.(null);
    }
  }, [selected, selectedHandle, seams.handles, setSelected]);
  // bring a selected edge back into view
  useEffect(() => {
    if (!selectedHandle || viewW <= 0) return;
    const next = revealOffset(seamsOutputMs(seams.handles, selectedHandle.index), scale.value, offset.value, totalDurationMs, viewW);
    if (next !== null) offset.value = withTiming(next, { duration: 200, easing: Easing.out(Easing.cubic) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle?.index, selectedHandle?.edge.atMs]);

  useEffect(
    () => () => {
      live.current.seams.onEdgePreview?.(null);
      if (waveTimer.current) clearTimeout(waveTimer.current);
    },
    [],
  );

  // ── waveform ──
  const pieces = useMemo(() => wavePiecesOf(clips), [clips]);
  const drawWave = useCallback(
    (s0: number, o0: number) => {
      try {
        drawWaveNow(s0, o0);
      } catch (e) {
        // a waveform that cannot be drawn is left out; the timeline itself carries on
        if (__DEV__) console.warn("[precision timeline] waveform failed", (e as Error)?.message);
        setWave(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loudness, viewW, pieces],
  );
  const drawWaveNow = useCallback(
    (s0: number, o0: number) => {
      if (!loudness || viewW <= 0 || loudness.windows.length === 0 || !(s0 > 0) || !Number.isFinite(o0)) return;
      const windowMs = loudness.durationMs / loudness.windows.length;
      const width = 3 * viewW;
      const startMs = xToMs(-viewW, s0, o0);
      const endMs = xToMs(2 * viewW, s0, o0);
      const columns = Math.ceil(width / WAVE_PITCH);
      const heights = waveformColumns(loudness.windows, windowMs, pieces, startMs, endMs, columns);
      settledRef.current = { scale: s0, offset: o0 };
      waveS0.value = s0;
      waveO0.value = o0;
      setWave({ path: waveformPath(heights, WAVE_PITCH, LANE_H), width });
    },
    [loudness, viewW, pieces, waveS0, waveO0],
  );
  // a new drawing when the data, the clips or the width change
  useEffect(() => {
    if (viewW <= 0) return;
    settledRef.current = null;
    drawWave(scale.value, offset.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loudness, pieces, viewW, totalDurationMs]);
  const onViewSettle = useCallback(
    (s: number, o: number) => {
      latestView.current = { scale: s, offset: o };
      if (waveTimer.current) return;
      waveTimer.current = setTimeout(() => {
        waveTimer.current = null;
        const cur = latestView.current;
        const set = settledRef.current;
        if (!set || Math.abs(cur.scale / set.scale - 1) > WAVE_REDRAW_RATIO || Math.abs(cur.offset - set.offset) > viewW * 0.7) {
          drawWave(cur.scale, cur.offset);
        }
      }, 110);
    },
    [drawWave, viewW],
  );
  const safeSettle = useMemo(() => guard("waveform", onViewSettle), [guard, onViewSettle]);
  useAnimatedReaction(
    () => scale.value * 1e6 + offset.value,
    () => {
      runOnJS(safeSettle)(scale.value, offset.value);
    },
  );
  const waveStyle = useAnimatedStyle(() => {
    const s0 = waveS0.value;
    const a = s0 > 0 ? scale.value / s0 : 1;
    const b = TL_PAD * (1 - a) + waveO0.value * a - offset.value;
    return { opacity: s0 > 0 ? 1 : 0, transform: [{ translateX: b + 0.5 * viewWSV.value * (a - 1) }, { scaleX: a }] };
  });

  // ── JS side of the gestures (called from the UI thread) ──
  const resolveEdge = useCallback((index: number, side: number): { geomIndex: number; edge: SeamEdgeInfo } | null => {
    const h = live.current.seams.handles[index];
    if (!h) return null;
    const edge = side === 0 ? h.prev : h.next;
    return edge ? { geomIndex: index, edge } : null;
  }, []);

  const selectEdge = useCallback((edge: SeamEdgeInfo) => {
    setSelected({ side: edge.side, atMs: edge.atMs });
    live.current.seams.onEdgePreview?.(edge.atMs);
  }, [setSelected]);

  const onGrab = useCallback(
    (index: number, side: number) => {
      const r = resolveEdge(index, side);
      if (!r) return;
      haptic("select");
      selectEdge(r.edge);
      setLiveEdge({ ms: r.edge.atMs, atMs: r.edge.atMs });
      const cfg = live.current.seams;
      // how far this edge can move either way (it cannot cross its own clip or leave the video)
      const lo = cfg.describe(r.edge, -1e9, 1).clampedMs;
      const hi = cfg.describe(r.edge, 1e9, 1).clampedMs;
      dragMin.value = Math.min(lo, hi, r.edge.atMs);
      dragMax.value = Math.max(lo, hi, r.edge.atMs);
    },
    [resolveEdge, selectEdge, dragMin, dragMax],
  );

  const onPreview = useCallback((ms: number, atMs: number) => {
    setLiveEdge({ ms, atMs });
    live.current.seams.onEdgePreview?.(ms);
  }, []);

  const onEdgeEnd = useCallback(
    (index: number, side: number, ms: number, moved: boolean) => {
      setLiveEdge(null);
      const r = resolveEdge(index, side);
      if (!r || !moved) return;
      const cfg = live.current.seams;
      const drag = cfg.describe(r.edge, ms, 1);
      if (drag.kind === "none") return;
      cfg.onDragEnd(r.edge, drag.clampedMs, { minDragMs: 1 });
      setSelected({ side: r.edge.side, atMs: drag.clampedMs });
      cfg.onEdgePreview?.(drag.clampedMs);
    },
    [resolveEdge, setSelected],
  );

  const onScrub = useCallback((ms: number) => {
    live.current.onSeek(ms);
  }, []);

  const onTap = useCallback(
    (kind: string, index: number, side: number) => {
      const l = live.current;
      if (kind === "marker") {
        const m = l.markers?.[index];
        if (m) l.onMarkerPress?.(m);
        return;
      }
      if (kind === "edge") {
        const r = resolveEdge(index, side);
        if (r) {
          haptic("select");
          selectEdge(r.edge);
        }
        return;
      }
      if (kind === "clip") {
        const c = l.clips[index];
        if (c) {
          setSelected(null);
          l.seams.onEdgePreview?.(null);
          l.onSelectClip(c.id);
        }
        return;
      }
      if (l.selected) {
        setSelected(null);
        l.seams.onEdgePreview?.(null);
      } else if (l.selectedClipId) {
        l.onDeselectAndPreview?.();
      }
    },
    [resolveEdge, selectEdge, setSelected],
  );

  const onSnapHaptic = useCallback(() => haptic("light"), []);

  // What the UI thread calls goes through these: an error there is reported, not thrown into the app.
  const safeGrab = useMemo(() => guard("grab", onGrab), [guard, onGrab]);
  const safePreview = useMemo(() => guard("preview", onPreview), [guard, onPreview]);
  const safeEdgeEnd = useMemo(() => guard("edgeEnd", onEdgeEnd), [guard, onEdgeEnd]);
  const safeScrub = useMemo(() => guard("scrub", onScrub), [guard, onScrub]);
  const safeTap = useMemo(() => guard("tap", onTap), [guard, onTap]);

  // ── the edge under the finger, recomputed on every move and every frame (a pause is noticed without moves) ──
  const stepEdge = () => {
    "worklet";
    if (!dragging.value) return;
    const s = scale.value;
    const rawUnclamped = edgeDragMs(dragAtMs.value, dragDx.value + (offset.value - dragOffsetStart.value), s);
    const raw = Math.min(dragMax.value, Math.max(dragMin.value, rawUnclamped));
    const now = Date.now();
    const r = snapStep(snapState.value, raw, now, targetsSV.value, snapParams(s));
    snapState.value = r.state;
    const ms = Math.min(dragMax.value, Math.max(dragMin.value, r.ms));
    if (r.caught) runOnJS(onSnapHaptic)();
    if (ms !== dragMs.value) dragMs.value = ms;
    if (ms !== lastPreviewMs.value && now - lastPreviewAt.value >= PREVIEW_EVERY_MS) {
      lastPreviewAt.value = now;
      lastPreviewMs.value = ms;
      runOnJS(safePreview)(ms, dragAtMs.value);
    }
  };

  const frame = useFrameCallback(() => {
    "worklet";
    try {
      if (!dragging.value) return;
      // near the screen edge: the timeline scrolls on by itself, and the edge goes with it
      const w = viewWSV.value;
      const x = fingerX.value;
      const zone = 40;
      if (scale.value > fitScale(totalSV.value, w) * 1.001) {
        let v = 0;
        if (x < zone) v = -((zone - x) / zone) * 14;
        else if (x > w - zone) v = ((x - (w - zone)) / zone) * 14;
        if (v !== 0) offset.value = clampOffset(offset.value + v, totalSV.value, scale.value, w);
      }
      stepEdge();
    } catch (err) {
      dragging.value = false;
      runOnJS(reportFatal)("frame", String(err));
    }
  }, false);
  const setFrameActive = useCallback((on: boolean) => {
    try {
      frame.setActive(on);
    } catch (e) {
      fatalRef.current?.(e, "frame");
    }
  }, [frame]);

  // ── gestures ──
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(TAP_SLOP)
      .maxPointers(1)
      .onBegin((e) => {
        "worklet";
        try {
          cancelAnimation(offset);
          touching.value = true;
          const g = grabAt(e.x, e.y, geomsSV.value, playMs.value, scale.value, offset.value);
          mode.value = g.kind === "edge" ? 1 : g.kind === "playhead" ? 2 : 3;
          modeIdx.value = g.index;
          modeSide.value = g.side;
        } catch (err) {
          mode.value = 0;
          runOnJS(reportFatal)("pan.begin", String(err));
        }
      })
      .onStart((e) => {
        "worklet";
        try {
          if (mode.value === 1) {
            const geom = geomsSV.value[modeIdx.value];
            if (!geom) {
              mode.value = 0;
              return;
            }
            dragIdx.value = modeIdx.value;
            dragSide.value = modeSide.value;
            dragOutputMs.value = geom.outputMs;
            dragAtMs.value = modeSide.value === 0 ? geom.prevAtMs : geom.nextAtMs;
            dragMs.value = dragAtMs.value;
            dragMin.value = -1e12;   // the real bounds arrive from onGrab
            dragMax.value = 1e12;
            dragging.value = true;
            dragDx.value = 0;
            dragOffsetStart.value = offset.value;
            fingerX.value = e.x;
            const t = Date.now();
            lastPreviewAt.value = 0;
            lastPreviewMs.value = -1;
            snapState.value = snapStart(dragAtMs.value, t);
            runOnJS(safeGrab)(modeIdx.value, modeSide.value);
            runOnJS(setFrameActive)(true);
          } else if (mode.value === 2) {
            playGrabDx.value = msToX(playMs.value, scale.value, offset.value) - e.x;
            lastSeekMs.value = -1;
          } else {
            offsetStart.value = offset.value;
          }
        } catch (err) {
          dragging.value = false;
          mode.value = 0;
          runOnJS(reportFatal)("pan.start", String(err));
        }
      })
      .onUpdate((e) => {
        "worklet";
        try {
          if (mode.value === 1) {
            dragDx.value = e.translationX;
            fingerX.value = e.x;
            stepEdge();
          } else if (mode.value === 2) {
            const ms = Math.min(totalSV.value, Math.max(0, xToMs(e.x + playGrabDx.value, scale.value, offset.value)));
            playMs.value = ms;
            if (Math.abs(ms - lastSeekMs.value) >= 1) {
              lastSeekMs.value = ms;
              runOnJS(safeScrub)(ms);
            }
          } else if (mode.value === 3) {
            offset.value = clampOffset(offsetStart.value - e.translationX, totalSV.value, scale.value, viewWSV.value);
          }
        } catch (err) {
          dragging.value = false;
          mode.value = 0;
          runOnJS(reportFatal)("pan.update", String(err));
        }
      })
      .onEnd((e) => {
        "worklet";
        try {
          if (mode.value === 3) {
            const max = Math.max(0, 2 * TL_PAD + totalSV.value * scale.value - viewWSV.value);
            const v = Number.isFinite(e.velocityX) ? e.velocityX : 0;
            if (max > 0) offset.value = withDecay({ velocity: -v, clamp: [0, max], deceleration: 0.997 });
          }
        } catch (err) {
          runOnJS(reportFatal)("pan.end", String(err));
        }
      })
      .onFinalize((e, success) => {
        "worklet";
        try {
          if (mode.value === 1 && dragging.value) {
            const moved = success && (Math.abs(e.translationX) >= TAP_SLOP || Math.abs(dragMs.value - dragAtMs.value) >= 1);
            const ms = dragMs.value;
            dragging.value = false;
            runOnJS(setFrameActive)(false);
            runOnJS(safeEdgeEnd)(dragIdx.value, dragSide.value, ms, moved);
          }
        } catch (err) {
          dragging.value = false;
          runOnJS(reportFatal)("pan.finalize", String(err));
        }
        mode.value = 0;
        touching.value = false;
      });

    const singleTap = Gesture.Tap()
      .maxDuration(300)
      .maxDistance(10)
      .onEnd((e, ok) => {
        "worklet";
        try {
          if (!ok) return;
          const t = tapAt(e.x, e.y, markersSV.value, geomsSV.value, clipsSV.value, scale.value, offset.value);
          runOnJS(safeTap)(t.kind, t.index, t.side);
        } catch (err) {
          runOnJS(reportFatal)("tap", String(err));
        }
      });
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(300)
      .maxDelay(280)
      .maxDistance(24)
      .onEnd((_e, ok) => {
        "worklet";
        try {
          if (!ok) return;
          const target = fitView(totalSV.value, viewWSV.value);
          cancelAnimation(offset);
          scale.value = withTiming(target.scale, { duration: FIT_ANIM_MS, easing: Easing.out(Easing.cubic) });
          offset.value = withTiming(target.offset, { duration: FIT_ANIM_MS, easing: Easing.out(Easing.cubic) });
        } catch (err) {
          runOnJS(reportFatal)("doubleTap", String(err));
        }
      });

    const pinch = Gesture.Pinch()
      .onBegin(() => {
        "worklet";
        try {
          cancelAnimation(scale);
          cancelAnimation(offset);
        } catch (err) {
          runOnJS(reportFatal)("pinch.begin", String(err));
        }
      })
      .onStart((e) => {
        "worklet";
        try {
          pinchStart.value = { scale: scale.value, offset: offset.value, focalX: e.focalX };
          touching.value = true;
        } catch (err) {
          runOnJS(reportFatal)("pinch.start", String(err));
        }
      })
      .onUpdate((e) => {
        "worklet";
        try {
          const p = pinchStart.value;
          const v = pinchView({ scale: p.scale, offset: p.offset }, e.scale, p.focalX, e.focalX, totalSV.value, viewWSV.value);
          if (Number.isFinite(v.scale) && Number.isFinite(v.offset)) {
            scale.value = v.scale;
            offset.value = v.offset;
          }
        } catch (err) {
          runOnJS(reportFatal)("pinch.update", String(err));
        }
      })
      .onFinalize(() => {
        "worklet";
        touching.value = false;
      });

    return Gesture.Simultaneous(pinch, Gesture.Race(pan, Gesture.Simultaneous(singleTap, doubleTap)));
    // everything the worklets use is a shared value or a stable callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── the nudge buttons ──
  const fps = safeFps(seams.frameRate);
  const nudge = useCallback(
    (direction: 1 | -1) => {
      const l = live.current;
      if (!selectedHandle) return;
      const edge = selectedHandle.edge;
      const target = nudgeFrameMs(edge.atMs, direction, fps, l.seams.sourceDurationMs);
      const drag = l.seams.describe(edge, target, 1);
      if (drag.kind === "none" || drag.clampedMs === edge.atMs) {
        haptic("light");
        return;
      }
      haptic("select");
      l.seams.onDragEnd(edge, drag.clampedMs, { minDragMs: 1 });
      setSelected({ side: edge.side, atMs: drag.clampedMs });
      l.seams.onEdgePreview?.(drag.clampedMs);
    },
    [selectedHandle, fps, setSelected],
  );
  const clearSelection = useCallback(() => {
    setSelected(null);
    live.current.seams.onEdgePreview?.(null);
  }, [setSelected]);

  // ── drag overlay (ghost strip + moving edge line) ──
  const ghostStyle = useAnimatedStyle(() => {
    if (!dragging.value) return { opacity: 0 };
    const d = dragMs.value - dragAtMs.value;
    const x0 = msToX(dragOutputMs.value, scale.value, offset.value);
    const x1 = msToX(dragOutputMs.value + d, scale.value, offset.value);
    const outward = dragSide.value === 0 ? d > 0 : d < 0;
    return {
      opacity: 1,
      transform: [{ translateX: Math.min(x0, x1) }],
      width: Math.abs(x1 - x0),
      backgroundColor: outward ? "rgba(31,168,77,0.38)" : "rgba(232,41,28,0.34)",
    };
  });
  const edgeLineStyle = useAnimatedStyle(() => {
    if (!dragging.value) return { opacity: 0 };
    const d = dragMs.value - dragAtMs.value;
    return { opacity: 1, transform: [{ translateX: msToX(dragOutputMs.value + d, scale.value, offset.value) - 1 }] };
  });

  // ── playhead ──
  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: msToX(Math.min(totalSV.value, Math.max(0, playMs.value)), scale.value, offset.value) - 1 }],
  }));

  const onLayout = useCallback((e: LayoutChangeEvent) => setViewW(Math.round(e.nativeEvent.layout.width)), []);
  const rects = useMemo(() => timelineRects(viewW), [viewW]);
  const totalH = LANE_TOP + LANE_H + INFO_H;
  const edgeCaption = selected ? `${selected.side === "right" ? "End" : "Start"} of clip · ${Math.round(fps * 100) / 100} fps` : "";

  return (
    <View style={[styles.container, { height: totalH }]} onLayout={onLayout}>
      {viewW > 0 && (
        <>
          <GestureDetector gesture={gesture}>
            <Animated.View collapsable={false} style={[styles.touchArea, { height: LANE_TOP + LANE_H }]}>
              {/* lane: clips, waveform, bands, the drag ghost (clipped to the lane) */}
              <View pointerEvents="none" style={styles.lane}>
                {clips.map((c, i) => (
                  <ClipBar
                    key={c.id}
                    startMs={clipGeoms[i]?.startMs ?? 0}
                    durMs={clipGeoms[i]?.durMs ?? 0}
                    selected={c.id === selectedClipId}
                    scale={scale}
                    offset={offset}
                  />
                ))}
                {wave ? (
                  <Animated.View pointerEvents="none" style={[styles.wave, { left: -viewW, width: wave.width }, waveStyle]}>
                    <Svg width={wave.width} height={LANE_H}>
                      <Path d={wave.path} stroke="rgba(10,10,10,0.72)" strokeWidth={2} strokeLinecap="round" />
                    </Svg>
                  </Animated.View>
                ) : null}
                {bands?.map((b, i) => (
                  <Band key={`band${i}`} startMs={b.startMs} endMs={b.endMs} scale={scale} offset={offset} />
                ))}
                <Animated.View pointerEvents="none" style={[styles.ghost, ghostStyle]} />
              </View>
              {/* handles, markers, playhead: drawn over the lane */}
              <View pointerEvents="none" style={styles.overlay}>
                {geoms.map((g, i) => (
                  <HandlePills key={`h${i}`} geom={g} index={i} scale={scale} offset={offset} selIdx={selIdx} selSide={selSide} />
                ))}
                <Animated.View pointerEvents="none" style={[styles.edgeLine, edgeLineStyle]} />
                {markers?.map((m) => (
                  <MarkerGlyph key={m.id} marker={m} scale={scale} offset={offset} />
                ))}
                <Animated.View pointerEvents="none" style={[styles.playhead, playheadStyle]}>
                  <View style={styles.playheadDot} />
                  <View style={styles.playheadLine} />
                </Animated.View>
              </View>
            </Animated.View>
          </GestureDetector>

          {/* info row: the selected edge's time, one-frame nudges, or a hint */}
          {selected && selectedHandle ? (
            <>
              <Pressable
                onPress={guard("nudge", () => nudge(-1))}
                accessibilityRole="button"
                accessibilityLabel="Move edge one frame earlier"
                style={({ pressed }) => [styles.nudge, box(rects.nudgeBack), pressed && styles.pressed]}
              >
                <ChevronLeft size={22} color={theme.text} strokeWidth={2.4} />
              </Pressable>
              <View pointerEvents="none" style={[styles.readout, { left: rects.readout.x, top: rects.readout.y, width: rects.readout.w, height: rects.readout.h }]}>
                <View style={styles.readoutRow}>
                  <UiText style={styles.readoutTime}>{formatTimeCs(liveEdge ? liveEdge.ms : selectedHandle.edge.atMs)}</UiText>
                  {liveEdge && Math.round(liveEdge.ms - liveEdge.atMs) !== 0 ? (
                    <UiText style={styles.readoutDelta}>{formatDeltaSeconds(liveEdge.ms - liveEdge.atMs)}</UiText>
                  ) : null}
                </View>
                <UiText style={styles.readoutCaption} numberOfLines={1}>
                  {edgeCaption}
                </UiText>
              </View>
              <Pressable
                onPress={guard("nudge", () => nudge(1))}
                accessibilityRole="button"
                accessibilityLabel="Move edge one frame later"
                style={({ pressed }) => [styles.nudge, box(rects.nudgeFwd), pressed && styles.pressed]}
              >
                <ChevronRight size={22} color={theme.text} strokeWidth={2.4} />
              </Pressable>
              <Pressable
                onPress={guard("clear", clearSelection)}
                accessibilityRole="button"
                accessibilityLabel="Done adjusting this edge"
                style={({ pressed }) => [styles.nudge, box(rects.clearBtn), pressed && styles.pressed]}
              >
                <X size={18} color={theme.text} strokeWidth={2.4} />
              </Pressable>
            </>
          ) : (
            <View pointerEvents="none" style={[styles.hintBox, { top: rects.info.y, height: rects.info.h }]}>
              <UiText style={styles.hint} numberOfLines={1}>
                Pinch to zoom · drag a handle to fine-tune a cut
              </UiText>
            </View>
          )}
        </>
      )}
    </View>
  );
}

/** A layout rect as absolute-position style. */
function box(r: { x: number; y: number; w: number; h: number }) {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

function seamsOutputMs(handles: SeamHandleSpec[], index: number): number {
  return handles[index]?.outputMs ?? 0;
}

const styles = StyleSheet.create({
  container: { position: "relative", alignSelf: "stretch" },
  touchArea: { position: "absolute", top: 0, left: 0, right: 0 },
  lane: { position: "absolute", left: 0, right: 0, top: LANE_TOP, height: LANE_H, overflow: "hidden", borderRadius: 6, backgroundColor: "rgba(10,10,10,0.05)" },
  overlay: { ...StyleSheet.absoluteFill },
  clip: {
    position: "absolute",
    left: 0,
    top: 0,
    height: LANE_H,
    backgroundColor: "#FFFFFF",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(10,10,10,0.18)",
  },
  clipSelected: { backgroundColor: "#FFF3F1", borderWidth: 2, borderColor: theme.accent },
  wave: { position: "absolute", top: 0, height: LANE_H },
  band: { position: "absolute", left: 0, top: 0, height: LANE_H, backgroundColor: "rgba(242,140,40,0.28)" },
  ghost: { position: "absolute", left: 0, top: 0, height: LANE_H },
  pill: { position: "absolute", left: 0, top: LANE_TOP, borderRadius: 2 },
  edgeLine: { position: "absolute", left: 0, top: LANE_TOP, width: 2, height: LANE_H, backgroundColor: theme.text },
  markerBox: { position: "absolute", left: 0, width: 12, height: 12, alignItems: "center", justifyContent: "center" },
  markerGlyph: { width: 12, height: 12 },
  playhead: { position: "absolute", left: 0, top: 0, width: 2, height: LANE_TOP + LANE_H, alignItems: "center" },
  playheadDot: { position: "absolute", top: 1, width: 14, height: 14, borderRadius: 7, backgroundColor: theme.accent, borderWidth: 2, borderColor: "#fff" },
  playheadLine: { position: "absolute", top: 14, bottom: 0, width: 2, backgroundColor: theme.accent },
  nudge: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: "rgba(10,10,10,0.07)",
  },
  pressed: { backgroundColor: "rgba(10,10,10,0.16)" },
  readout: { position: "absolute", alignItems: "center", justifyContent: "center" },
  readoutRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 6 },
  readoutTime: { color: theme.text, fontSize: 17, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] },
  readoutDelta: { color: theme.textMuted, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  readoutCaption: { color: theme.textMuted, fontSize: 11, marginTop: -1 },
  hintBox: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  hint: { color: theme.textMuted, fontSize: 12 },
});
