import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
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
  DIVIDER_W,
  FRAME_LINE,
  HANDLE_PRESS_SCALE,
  HANDLE_RADIUS,
  HANDLE_W,
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
  flingStep,
  followOffset,
  formatDeltaSeconds,
  formatTimeCs,
  frameOf,
  frameHandleXs,
  grabAt,
  handleGeoms,
  lerpView,
  nudgeFrameMs,
  pinchView,
  revealOffset,
  safeFps,
  tapAt,
  timelineRects,
  waveformColumns,
  waveformPath,
  wavePiecesOf,
  xToMs,
  type ClipGeom,
  type FrameGeom,
  type MarkerGeom,
  type View as ViewState,
} from "@/lib/autoEdit/timelineView";
import type { DraftClip } from "@/providers/PostsProvider";

/**
 * Why everything here runs on the JS thread: every other gesture in the app does (`runOnJS(true)`), and the only
 * animation code that has ever run on the UI thread in this app is `useAnimatedStyle` on transforms and opacity
 * (the text overlays). This timeline stays inside exactly that: gestures, snapping, fling and zoom animation are plain
 * JS that write shared values, and the styles read those values with transform / opacity only (no layout props, no
 * frame callbacks, no reactions, no worklet functions, nothing captured from JS on the UI thread).
 */

/** Bar pitch of the waveform, in points: a few hundred bars across the drawn window, about 125 per screen. */
const WAVE_PITCH = 3;
/** How far a settled drawing may drift from the live zoom before it is drawn again. */
const WAVE_REDRAW_RATIO = 0.12;
const FIT_ANIM_MS = 240;
/** Finger travel under this is a tap, not a drag. */
const TAP_SLOP = 3;
/** Preview frames and the readout are updated at most this often while an edge is dragged. */
const PREVIEW_EVERY_MS = 50;
/** An edge selected before an edit is found again after it within this distance (source ms). */
const EDGE_MATCH_MS = 150;
/** Bars (clips, bands, the drag ghost) are one fixed-width view scaled sideways: no layout props are animated. */
const BAR_BASE = 1000;

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
  /** An error was caught in this timeline: the owner switches to the previous timeline. */
  onFatal?: (error: unknown, where: string) => void;
  /** A step reached (saved at once, uploaded later): the trail a native crash leaves. */
  onBreadcrumb?: (name: string, data?: Record<string, unknown>) => void;
};

type SelectedEdge = { side: "left" | "right"; atMs: number };

type GestureState = { mode: "none" | "edge" | "playhead" | "scroll"; idx: number; side: 0 | 1; startOffset: number; grabDx: number; lastSeekMs: number };

type EdgeDragState = {
  idx: number;
  side: 0 | 1;
  edge: SeamEdgeInfo;
  atMs: number;
  min: number;
  max: number;
  dx: number;
  fingerX: number;
  offsetStart: number;
  snap: SnapState;
  ms: number;
  lastPreviewAt: number;
  lastPreviewMs: number;
};

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

// ── Pieces drawn from the shared view: transform and opacity only ────────────

/** A bar from `startMs` lasting `durMs`: one BAR_BASE wide view, moved and scaled sideways. */
function Bar({
  startMs,
  durMs,
  scale,
  offset,
  style,
}: {
  startMs: number;
  durMs: number;
  scale: SharedValue<number>;
  offset: SharedValue<number>;
  style: object;
}) {
  const anim = useAnimatedStyle(() => {
    const w = Math.max(1, durMs * scale.value);
    return { transform: [{ translateX: TL_PAD + startMs * scale.value - offset.value + (w - BAR_BASE) / 2 }, { scaleX: w / BAR_BASE }] };
  });
  return <Animated.View pointerEvents="none" style={[styles.bar, style, anim]} />;
}

/** A thin, subtle divider on a cut boundary that is not part of the selected clip. */
function Divider({ outputMs, scale, offset }: { outputMs: number; scale: SharedValue<number>; offset: SharedValue<number> }) {
  const anim = useAnimatedStyle(() => ({ transform: [{ translateX: TL_PAD + outputMs * scale.value - offset.value - DIVIDER_W / 2 }] }));
  return <Animated.View pointerEvents="none" style={[styles.divider, anim]} />;
}

/**
 * The selected clip's frame, iOS Photos / CapCut trim style: a thick rounded handle on each end (Trial red, two short
 * white grip lines) joined by a red outline along the top and bottom. Only transform and opacity are animated: the
 * outline is one wide bar per side scaled sideways, a touched handle scales up.
 */
function Frame({
  frameStart,
  frameEnd,
  pressLeft,
  pressRight,
  scale,
  offset,
}: {
  frameStart: SharedValue<number>;
  frameEnd: SharedValue<number>;
  pressLeft: SharedValue<number>;
  pressRight: SharedValue<number>;
  scale: SharedValue<number>;
  offset: SharedValue<number>;
}) {
  const topBar = useAnimatedStyle(() => {
    if (frameStart.value < 0) return { opacity: 0 };
    const x0 = TL_PAD + frameStart.value * scale.value - offset.value - HANDLE_W / 2;
    const x1 = TL_PAD + frameEnd.value * scale.value - offset.value + HANDLE_W / 2;
    const w = Math.max(1, x1 - x0);
    return { opacity: 1, transform: [{ translateX: x0 + (w - BAR_BASE) / 2 }, { scaleX: w / BAR_BASE }] };
  });
  const bottomBar = useAnimatedStyle(() => {
    if (frameStart.value < 0) return { opacity: 0 };
    const x0 = TL_PAD + frameStart.value * scale.value - offset.value - HANDLE_W / 2;
    const x1 = TL_PAD + frameEnd.value * scale.value - offset.value + HANDLE_W / 2;
    const w = Math.max(1, x1 - x0);
    return { opacity: 1, transform: [{ translateX: x0 + (w - BAR_BASE) / 2 }, { scaleX: w / BAR_BASE }] };
  });
  const left = useAnimatedStyle(() => ({
    opacity: frameStart.value < 0 ? 0 : 1,
    transform: [{ translateX: TL_PAD + frameStart.value * scale.value - offset.value - HANDLE_W }, { scale: pressLeft.value }],
  }));
  const right = useAnimatedStyle(() => ({
    opacity: frameStart.value < 0 ? 0 : 1,
    transform: [{ translateX: TL_PAD + frameEnd.value * scale.value - offset.value }, { scale: pressRight.value }],
  }));
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.frameBar, { top: LANE_TOP }, topBar]} />
      <Animated.View pointerEvents="none" style={[styles.frameBar, { top: LANE_TOP + LANE_H - FRAME_LINE }, bottomBar]} />
      <Animated.View pointerEvents="none" style={[styles.handle, styles.handleLeft, left]}>
        <View style={styles.grip} />
        <View style={styles.grip} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.handle, styles.handleRight, right]}>
        <View style={styles.grip} />
        <View style={styles.grip} />
      </Animated.View>
    </>
  );
}

function MarkerGlyph({ outputMs, glyph, y, scale, offset }: { outputMs: number; glyph: object; y: number; scale: SharedValue<number>; offset: SharedValue<number> }) {
  const anim = useAnimatedStyle(() => ({ transform: [{ translateX: TL_PAD + outputMs * scale.value - offset.value - 6 }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.markerBox, { top: y - 6 }, anim]}>
      <View style={[styles.markerGlyph, glyph]} />
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
  onBreadcrumb,
}: PrecisionTimelineProps) {
  const [viewW, setViewW] = useState(0);

  // the view lives in refs (the truth, for the gesture code) and in shared values (for the styles)
  const view = useRef<ViewState>({ scale: 0.05, offset: 0 });
  const viewWRef = useRef(0);
  const totalRef = useRef(Math.max(1, totalDurationMs));
  const scale = useSharedValue(0.05);
  const offset = useSharedValue(0);
  const viewWSV = useSharedValue(0);
  const playMs = useSharedValue(positionMs);
  const playRef = useRef(positionMs);
  const frameStart = useSharedValue(-1);
  const frameEnd = useSharedValue(-1);
  const pressLeft = useSharedValue(1);
  const pressRight = useSharedValue(1);
  const dragOn = useSharedValue(0);
  const dragMs = useSharedValue(0);
  const dragAtMs = useSharedValue(0);
  const dragOutputMs = useSharedValue(0);
  const dragSide = useSharedValue(0);
  const waveS0 = useSharedValue(0);
  const waveO0 = useSharedValue(0);

  const [selected, setSelectedState] = useState<SelectedEdge | null>(null);
  const selectedAgainst = useRef<SeamHandleSpec[] | null>(null);
  const [liveEdge, setLiveEdge] = useState<{ ms: number; atMs: number } | null>(null);
  const [wave, setWave] = useState<{ path: string; width: number } | null>(null);
  const loudness = useLoudness(seams.sourceUri, seams.canAnalyze === true);

  // The latest props for the callbacks the gestures call (their identity never changes).
  const live = useRef({ clips, markers, seams, selected, selectedClipId, onSeek, onSelectClip, onDeselectAndPreview, onMarkerPress, onFatal, onBreadcrumb });
  live.current = { clips, markers, seams, selected, selectedClipId, onSeek, onSelectClip, onDeselectAndPreview, onMarkerPress, onFatal, onBreadcrumb };
  const setSelected = useCallback((next: SelectedEdge | null) => {
    selectedAgainst.current = live.current.seams.handles;
    setSelectedState(next);
  }, []);
  const crumb = useCallback((name: string, data?: Record<string, unknown>) => {
    try {
      live.current.onBreadcrumb?.(name, data);
    } catch {
      // a breadcrumb never matters
    }
  }, []);

  // Anything that goes wrong in a handler is reported to the owner (which switches to the previous timeline).
  const guard = useMemo(
    () =>
      <A extends unknown[]>(where: string, fn: (...a: A) => void) =>
      (...a: A): void => {
        try {
          fn(...a);
        } catch (e) {
          live.current.onFatal?.(e, where);
        }
      },
    [],
  );

  // ── geometry ──
  const geoms = useMemo(() => handleGeoms(seams.handles), [seams.handles]);
  const clipGeoms = useMemo(() => {
    const out: ClipGeom[] = [];
    let t = 0;
    for (const c of clips) {
      const start = c.trimStartMs ?? 0;
      const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0);
      const raw = Math.max(0, end - start);
      const dur = Number.isFinite(raw) ? raw : 0;
      out.push({ startMs: t, durMs: dur });
      t += dur;
    }
    return out;
  }, [clips]);
  const markerGeoms = useMemo<MarkerGeom[]>(() => (markers ?? []).map((m) => ({ outputMs: m.outputMs, bottom: MARKER_LOOK[m.kind]?.bottom ?? false })), [markers]);
  const targets = useMemo(() => buildSnapTargets(seams.words, seams.boundaries), [seams.words, seams.boundaries]);
  const geo = useRef<{ geoms: typeof geoms; markerGeoms: MarkerGeom[]; clipGeoms: ClipGeom[]; targets: number[]; frame: FrameGeom | null }>({ geoms, markerGeoms, clipGeoms, targets, frame: null });
  geo.current.geoms = geoms;
  geo.current.markerGeoms = markerGeoms;
  geo.current.clipGeoms = clipGeoms;
  geo.current.targets = targets;

  // ── the view ──
  const waveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settled = useRef<{ scale: number; offset: number } | null>(null);
  const drawWaveRef = useRef<(s: number, o: number) => void>(() => {});
  const scheduleWave = useCallback(() => {
    if (waveTimer.current) return;
    waveTimer.current = setTimeout(() => {
      waveTimer.current = null;
      const cur = view.current;
      const set = settled.current;
      if (!set || Math.abs(cur.scale / set.scale - 1) > WAVE_REDRAW_RATIO || Math.abs(cur.offset - set.offset) > viewWRef.current * 0.7) {
        drawWaveRef.current(cur.scale, cur.offset);
      }
    }, 110);
  }, []);

  const setView = useCallback(
    (v: ViewState) => {
      const w = viewWRef.current;
      if (w <= 0 || !Number.isFinite(v.scale) || !Number.isFinite(v.offset)) return;
      const total = totalRef.current;
      const s = clampScale(v.scale, total, w);
      const o = clampOffset(v.offset, total, s, w);
      view.current = { scale: s, offset: o };
      scale.value = s;
      offset.value = o;
      scheduleWave();
    },
    [scale, offset, scheduleWave],
  );

  // animations: one at a time, one step per frame, cancelled by any touch
  const animId = useRef(0);
  const raf = useRef<number | null>(null);
  const cancelAnim = useCallback(() => {
    animId.current += 1;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);
  const animateTo = useCallback(
    (target: ViewState, ms: number) => {
      cancelAnim();
      const id = animId.current;
      const from = { ...view.current };
      const t0 = Date.now();
      const tick = () => {
        if (animId.current !== id) return;
        const k = Math.min(1, (Date.now() - t0) / ms);
        setView(lerpView(from, target, k));
        raf.current = k < 1 ? requestAnimationFrame(tick) : null;
      };
      raf.current = requestAnimationFrame(tick);
    },
    [cancelAnim, setView],
  );
  const fling = useCallback(
    (velocity: number) => {
      cancelAnim();
      const id = animId.current;
      let v = velocity;
      let last = Date.now();
      const tick = () => {
        if (animId.current !== id) return;
        const now = Date.now();
        const max = Math.max(0, 2 * TL_PAD + totalRef.current * view.current.scale - viewWRef.current);
        const step = flingStep(view.current.offset, v, (now - last) / 1000, max);
        last = now;
        v = step.velocity;
        setView({ scale: view.current.scale, offset: step.offset });
        raf.current = step.done ? null : requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [cancelAnim, setView],
  );

  // fit the whole video; keep the zoom when the clips change
  const prevFit = useRef<number | null>(null);
  useEffect(() => {
    viewWRef.current = viewW;
    viewWSV.value = viewW;
    totalRef.current = Math.max(1, totalDurationMs);
    if (viewW <= 0) return;
    const fit = fitScale(totalDurationMs, viewW);
    const wasFit = prevFit.current === null || Math.abs(view.current.scale - prevFit.current) <= prevFit.current * 0.001;
    prevFit.current = fit;
    if (wasFit) setView({ scale: fit, offset: 0 });
    else setView(view.current);
  }, [viewW, totalDurationMs, setView, viewWSV]);

  useEffect(() => {
    if (viewW > 0) crumb("precision timeline: mounted", { viewW, clips: clips.length, handles: seams.handles.length, markers: (markers ?? []).length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewW > 0]);

  // the playhead follows the player (and scrolls into view when zoomed)
  const touching = useRef(0);
  const edge = useRef<EdgeDragState | null>(null);
  useEffect(() => {
    if (!touching.current) {
      playRef.current = positionMs;
      playMs.value = Number.isFinite(positionMs) ? positionMs : 0;
    }
    if (touching.current || viewW <= 0 || edge.current) return;
    const next = followOffset(positionMs, view.current.scale, view.current.offset, totalDurationMs, viewW);
    if (next !== null) animateTo({ scale: view.current.scale, offset: next }, 180);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionMs, viewW, totalDurationMs]);

  // ── the selected edge ──
  const selectedHandle = useMemo(() => {
    if (!selected) return null;
    let best: { index: number; edge: SeamEdgeInfo } | null = null;
    let bestD = EDGE_MATCH_MS + 1;
    seams.handles.forEach((h, index) => {
      const e = selected.side === "right" ? h.prev : h.next;
      if (!e) return;
      const d = Math.abs(e.atMs - selected.atMs);
      if (d < bestD) {
        bestD = d;
        best = { index, edge: e };
      }
    });
    return best as { index: number; edge: SeamEdgeInfo } | null;
  }, [selected, seams.handles]);
  // The framed clip: the clip the selected edge belongs to (it follows the edge through edits, which give clips new
  // ids), else the clip that was tapped.
  const frameClipIndex = useMemo(() => {
    const id = selectedHandle?.edge.clipId ?? selectedClipId;
    return id ? clips.findIndex((c) => c.id === id) : -1;
  }, [selectedHandle, selectedClipId, clips]);
  const frame = useMemo(() => (frameClipIndex >= 0 ? frameOf(clipGeoms[frameClipIndex], geoms) : null), [frameClipIndex, clipGeoms, geoms]);
  geo.current.frame = frame;
  useEffect(() => {
    frameStart.value = frame ? frame.startMs : -1;
    frameEnd.value = frame ? frame.endMs : -1;
  }, [frame, frameStart, frameEnd]);
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
    const outputMs = seams.handles[selectedHandle.index]?.outputMs ?? 0;
    const next = revealOffset(outputMs, view.current.scale, view.current.offset, totalDurationMs, viewW);
    if (next !== null) animateTo({ scale: view.current.scale, offset: next }, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle?.index, selectedHandle?.edge.atMs]);

  // ── waveform ──
  const pieces = useMemo(() => wavePiecesOf(clips), [clips]);
  const drawWave = useCallback(
    (s0: number, o0: number) => {
      try {
        if (!loudness || viewW <= 0 || loudness.windows.length === 0 || !(s0 > 0) || !Number.isFinite(o0)) return;
        const t0 = Date.now();
        const windowMs = loudness.durationMs / loudness.windows.length;
        const width = 3 * viewW;
        const startMs = xToMs(-viewW, s0, o0);
        const endMs = xToMs(2 * viewW, s0, o0);
        const columns = Math.ceil(width / WAVE_PITCH);
        const heights = waveformColumns(loudness.windows, windowMs, pieces, startMs, endMs, columns);
        settled.current = { scale: s0, offset: o0 };
        waveS0.value = s0;
        waveO0.value = o0;
        setWave({ path: waveformPath(heights, WAVE_PITCH, LANE_H), width });
        crumb("precision timeline: waveform ready", { bars: columns, ms: Date.now() - t0 });
      } catch (e) {
        // a waveform that cannot be drawn is left out; the timeline itself carries on
        if (__DEV__) console.warn("[precision timeline] waveform failed", (e as Error)?.message);
        setWave(null);
      }
    },
    [loudness, viewW, pieces, waveS0, waveO0, crumb],
  );
  drawWaveRef.current = drawWave;
  useEffect(() => {
    if (viewW <= 0) return;
    settled.current = null;
    drawWave(view.current.scale, view.current.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loudness, pieces, viewW, totalDurationMs]);

  // ── edge drag (JS) ──
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      cancelAnim();
      if (waveTimer.current) clearTimeout(waveTimer.current);
      if (ticker.current) clearInterval(ticker.current);
      live.current.seams.onEdgePreview?.(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resolveEdge = useCallback((index: number, side: number): SeamEdgeInfo | null => {
    const h = live.current.seams.handles[index];
    if (!h) return null;
    return (side === 0 ? h.prev : h.next) ?? null;
  }, []);

  const selectEdge = useCallback(
    (e: SeamEdgeInfo) => {
      setSelected({ side: e.side, atMs: e.atMs });
      live.current.seams.onEdgePreview?.(e.atMs);
    },
    [setSelected],
  );

  const stepEdge = useCallback(() => {
    const d = edge.current;
    if (!d) return;
    const v = view.current;
    const rawUnclamped = edgeDragMs(d.atMs, d.dx + (v.offset - d.offsetStart), v.scale);
    const raw = Math.min(d.max, Math.max(d.min, rawUnclamped));
    const now = Date.now();
    const r = snapStep(d.snap, raw, now, geo.current.targets, snapParams(v.scale));
    d.snap = r.state;
    const ms = Math.min(d.max, Math.max(d.min, r.ms));
    if (r.caught) haptic("light");
    if (ms !== d.ms) {
      d.ms = ms;
      dragMs.value = ms;
    }
    if (ms !== d.lastPreviewMs && now - d.lastPreviewAt >= PREVIEW_EVERY_MS) {
      d.lastPreviewAt = now;
      d.lastPreviewMs = ms;
      setLiveEdge({ ms, atMs: d.atMs });
      live.current.seams.onEdgePreview?.(ms);
    }
  }, [dragMs]);

  // A touched handle grows a little and ticks (transform only); it goes back when the finger lifts.
  const tweenId = useRef(0);
  const press = useCallback(
    (side: 0 | 1 | null) => {
      const id = ++tweenId.current;
      const fromL = pressLeft.value;
      const fromR = pressRight.value;
      const toL = side === 1 ? HANDLE_PRESS_SCALE : 1;
      const toR = side === 0 ? HANDLE_PRESS_SCALE : 1;
      const t0 = Date.now();
      const tick = () => {
        if (tweenId.current !== id) return;
        const k = Math.min(1, (Date.now() - t0) / 90);
        pressLeft.value = fromL + (toL - fromL) * k;
        pressRight.value = fromR + (toR - fromR) * k;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [pressLeft, pressRight],
  );

  const stopTicker = useCallback(() => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  }, []);

  const tickEdge = useMemo(
    () =>
      guard("edgeTick", () => {
        const d = edge.current;
        if (!d) return;
        // near the screen edge: the timeline scrolls on by itself, and the edge goes with it
        const w = viewWRef.current;
        const zone = 40;
        const v = view.current;
        if (v.scale > fitScale(totalRef.current, w) * 1.001) {
          let step = 0;
          if (d.fingerX < zone) step = -((zone - d.fingerX) / zone) * 14;
          else if (d.fingerX > w - zone) step = ((d.fingerX - (w - zone)) / zone) * 14;
          if (step !== 0) setView({ scale: v.scale, offset: v.offset + step });
        }
        stepEdge();
      }),
    [guard, setView, stepEdge],
  );

  const beginEdge = useCallback(
    (idx: number, side: 0 | 1, fingerX: number) => {
      const e = resolveEdge(idx, side);
      const g = geo.current.geoms[idx];
      if (!e || !g) return false;
      const cfg = live.current.seams;
      // how far this edge can move either way (it cannot cross its own clip or leave the video)
      const lo = cfg.describe(e, -1e9, 1).clampedMs;
      const hi = cfg.describe(e, 1e9, 1).clampedMs;
      const now = Date.now();
      edge.current = {
        idx,
        side,
        edge: e,
        atMs: e.atMs,
        min: Math.min(lo, hi, e.atMs),
        max: Math.max(lo, hi, e.atMs),
        dx: 0,
        fingerX,
        offsetStart: view.current.offset,
        snap: snapStart(e.atMs, now),
        ms: e.atMs,
        lastPreviewAt: 0,
        lastPreviewMs: -1,
      };
      dragAtMs.value = e.atMs;
      dragMs.value = e.atMs;
      dragOutputMs.value = g.outputMs;
      dragSide.value = side;
      dragOn.value = 1;
      selectEdge(e);
      setLiveEdge({ ms: e.atMs, atMs: e.atMs });
      stopTicker();
      ticker.current = setInterval(tickEdge, 16);
      crumb("precision timeline: edge drag started", { zoom: Math.round(view.current.scale * 1000) / 1000 });
      return true;
    },
    [resolveEdge, dragAtMs, dragMs, dragOutputMs, dragSide, dragOn, selectEdge, stopTicker, tickEdge, crumb],
  );

  const endEdge = useCallback(
    (success: boolean, translationX: number) => {
      const d = edge.current;
      edge.current = null;
      stopTicker();
      dragOn.value = 0;
      setLiveEdge(null);
      if (!d) return;
      const moved = success && (Math.abs(translationX) >= TAP_SLOP || Math.abs(d.ms - d.atMs) >= 1);
      if (!moved) return;
      const cfg = live.current.seams;
      const drag = cfg.describe(d.edge, d.ms, 1);
      if (drag.kind === "none") return;
      cfg.onDragEnd(d.edge, drag.clampedMs, { minDragMs: 1 });
      setSelected({ side: d.edge.side, atMs: drag.clampedMs });
      cfg.onEdgePreview?.(drag.clampedMs);
    },
    [stopTicker, dragOn, setSelected],
  );

  const handleTap = useCallback(
    (kind: string, index: number, side: number) => {
      const l = live.current;
      if (kind === "marker") {
        const m = l.markers?.[index];
        if (m) l.onMarkerPress?.(m);
        return;
      }
      if (kind === "edge") {
        const e = resolveEdge(index, side);
        if (e) selectEdge(e);
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
      }
      if (l.selectedClipId) l.onDeselectAndPreview?.();
    },
    [resolveEdge, selectEdge, setSelected],
  );

  // ── gestures: plain JS, like every other gesture in the app ──
  const g1 = useRef<GestureState>({ mode: "none", idx: -1, side: 0, startOffset: 0, grabDx: 0, lastSeekMs: -1 });
  const pinchStart = useRef({ scale: 1, offset: 0, focalX: 0 });
  const firstGesture = useRef(new Set<string>());
  const once = useCallback(
    (kind: string) => {
      if (firstGesture.current.has(kind)) return;
      firstGesture.current.add(kind);
      crumb(`precision timeline: first ${kind}`);
    },
    [crumb],
  );

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(TAP_SLOP)
      .maxPointers(1)
      .onBegin(
        guard("pan.begin", (e: { x: number; y: number }) => {
          cancelAnim();
          touching.current += 1;
          const g = grabAt(e.x, e.y, geo.current.frame, playRef.current, view.current.scale, view.current.offset);
          g1.current = { mode: g.kind === "edge" ? "edge" : g.kind === "playhead" ? "playhead" : "scroll", idx: g.index, side: g.side, startOffset: view.current.offset, grabDx: 0, lastSeekMs: -1 };
          if (g.kind === "edge") {
            press(g.side);
            haptic("light");
          }
        }),
      )
      .onStart(
        guard("pan.start", (e: { x: number }) => {
          const g = g1.current;
          if (g.mode === "edge") {
            once("edge drag");
            if (!beginEdge(g.idx, g.side, e.x)) g.mode = "none";
          } else if (g.mode === "playhead") {
            once("playhead drag");
            const px = TL_PAD + playRef.current * view.current.scale - view.current.offset;
            g.grabDx = px - e.x;
          } else if (g.mode === "scroll") {
            once("pan");
          }
        }),
      )
      .onUpdate(
        guard("pan.update", (e: { x: number; translationX: number }) => {
          const g = g1.current;
          if (g.mode === "edge" && edge.current) {
            edge.current.dx = e.translationX;
            edge.current.fingerX = e.x;
            stepEdge();
          } else if (g.mode === "playhead") {
            const ms = Math.min(totalRef.current, Math.max(0, xToMs(e.x + g.grabDx, view.current.scale, view.current.offset)));
            playRef.current = ms;
            playMs.value = ms;
            if (Math.abs(ms - g.lastSeekMs) >= 1) {
              g.lastSeekMs = ms;
              live.current.onSeek(ms);
            }
          } else if (g.mode === "scroll") {
            setView({ scale: view.current.scale, offset: g.startOffset - e.translationX });
          }
        }),
      )
      .onEnd(
        guard("pan.end", (e: { velocityX: number }) => {
          if (g1.current.mode !== "scroll") return;
          const v = Number.isFinite(e.velocityX) ? -e.velocityX : 0;
          if (Math.abs(v) > 60) fling(v);
        }),
      )
      .onFinalize(
        guard("pan.finalize", (e: { translationX: number }, success: boolean) => {
          if (g1.current.mode === "edge" || edge.current) endEdge(success, e.translationX);
          if (g1.current.mode === "edge") press(null);
          g1.current.mode = "none";
          touching.current = Math.max(0, touching.current - 1);
        }),
      );

    const singleTap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(300)
      .maxDistance(10)
      .onEnd(
        guard("tap", (e: { x: number; y: number }, ok: boolean) => {
          if (!ok) return;
          once("tap");
          const t = tapAt(e.x, e.y, geo.current.markerGeoms, geo.current.frame, geo.current.clipGeoms, view.current.scale, view.current.offset);
          handleTap(t.kind, t.index, t.side);
        }),
      );
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .maxDuration(300)
      .maxDelay(280)
      .maxDistance(24)
      .onEnd(
        guard("doubleTap", (_e: unknown, ok: boolean) => {
          if (!ok) return;
          once("double tap");
          animateTo(fitView(totalRef.current, viewWRef.current), FIT_ANIM_MS);
        }),
      );

    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(
        guard("pinch.begin", () => {
          cancelAnim();
          touching.current += 1;
        }),
      )
      .onStart(
        guard("pinch.start", (e: { focalX: number }) => {
          once("pinch");
          pinchStart.current = { scale: view.current.scale, offset: view.current.offset, focalX: e.focalX };
        }),
      )
      .onUpdate(
        guard("pinch.update", (e: { scale: number; focalX: number }) => {
          const p = pinchStart.current;
          setView(pinchView({ scale: p.scale, offset: p.offset }, e.scale, p.focalX, e.focalX, totalRef.current, viewWRef.current));
        }),
      )
      .onFinalize(
        guard("pinch.finalize", () => {
          touching.current = Math.max(0, touching.current - 1);
        }),
      );

    return Gesture.Simultaneous(pinch, Gesture.Race(pan, Gesture.Simultaneous(singleTap, doubleTap)));
    // everything the handlers use is a ref, a shared value or a stable callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── the nudge buttons ──
  const fps = safeFps(seams.frameRate);
  const nudge = useCallback(
    (direction: 1 | -1) => {
      const l = live.current;
      if (!selectedHandle) return;
      const e = selectedHandle.edge;
      const target = nudgeFrameMs(e.atMs, direction, fps, l.seams.sourceDurationMs);
      const drag = l.seams.describe(e, target, 1);
      if (drag.kind === "none" || drag.clampedMs === e.atMs) {
        haptic("light");
        return;
      }
      haptic("select");
      l.seams.onDragEnd(e, drag.clampedMs, { minDragMs: 1 });
      setSelected({ side: e.side, atMs: drag.clampedMs });
      l.seams.onEdgePreview?.(drag.clampedMs);
    },
    [selectedHandle, fps, setSelected],
  );
  const clearSelection = useCallback(() => {
    setSelected(null);
    live.current.seams.onEdgePreview?.(null);
  }, [setSelected]);

  // ── styles (transform / opacity only) ──
  const waveStyle = useAnimatedStyle(() => {
    const s0 = waveS0.value;
    const a = s0 > 0 ? scale.value / s0 : 1;
    const b = TL_PAD * (1 - a) + waveO0.value * a - offset.value;
    return { opacity: s0 > 0 ? 1 : 0, transform: [{ translateX: b + 0.5 * viewWSV.value * (a - 1) }, { scaleX: a }] };
  });
  const ghostOutStyle = useAnimatedStyle(() => {
    const d = dragMs.value - dragAtMs.value;
    const outward = dragSide.value === 0 ? d > 0 : d < 0;
    const x0 = TL_PAD + dragOutputMs.value * scale.value - offset.value;
    const w = Math.max(1, Math.abs(d) * scale.value);
    const left = d >= 0 ? x0 : x0 - w;
    return { opacity: dragOn.value === 1 && outward ? 1 : 0, transform: [{ translateX: left + (w - BAR_BASE) / 2 }, { scaleX: w / BAR_BASE }] };
  });
  const ghostCutStyle = useAnimatedStyle(() => {
    const d = dragMs.value - dragAtMs.value;
    const outward = dragSide.value === 0 ? d > 0 : d < 0;
    const x0 = TL_PAD + dragOutputMs.value * scale.value - offset.value;
    const w = Math.max(1, Math.abs(d) * scale.value);
    const left = d >= 0 ? x0 : x0 - w;
    return { opacity: dragOn.value === 1 && !outward && d !== 0 ? 1 : 0, transform: [{ translateX: left + (w - BAR_BASE) / 2 }, { scaleX: w / BAR_BASE }] };
  });
  const edgeLineStyle = useAnimatedStyle(() => {
    const d = dragMs.value - dragAtMs.value;
    return { opacity: dragOn.value === 1 ? 1 : 0, transform: [{ translateX: TL_PAD + (dragOutputMs.value + d) * scale.value - offset.value - 1 }] };
  });
  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: TL_PAD + playMs.value * scale.value - offset.value - 1 }],
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
                  <Bar
                    key={c.id}
                    startMs={clipGeoms[i]?.startMs ?? 0}
                    durMs={clipGeoms[i]?.durMs ?? 0}
                    scale={scale}
                    offset={offset}
                    style={c.id === selectedClipId ? styles.clipSelected : styles.clip}
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
                  <Bar key={`band${i}`} startMs={b.startMs} durMs={Math.max(0, b.endMs - b.startMs)} scale={scale} offset={offset} style={styles.band} />
                ))}
                <Animated.View pointerEvents="none" style={[styles.bar, styles.ghostOut, ghostOutStyle]} />
                <Animated.View pointerEvents="none" style={[styles.bar, styles.ghostCut, ghostCutStyle]} />
              </View>
              {/* handles, markers, playhead: drawn over the lane */}
              <View pointerEvents="none" style={styles.overlay}>
                {geoms.map((g, i) => (g.hasPrev && g.hasNext ? <Divider key={`d${i}`} outputMs={g.outputMs} scale={scale} offset={offset} /> : null))}
                <Frame frameStart={frameStart} frameEnd={frameEnd} pressLeft={pressLeft} pressRight={pressRight} scale={scale} offset={offset} />
                <Animated.View pointerEvents="none" style={[styles.edgeLine, edgeLineStyle]} />
                {(markers ?? []).map((m, i) => {
                  const look = MARKER_LOOK[m.kind];
                  if (!look) return null;
                  return (
                    <MarkerGlyph
                      key={m.id}
                      outputMs={markerGeoms[i]?.outputMs ?? 0}
                      glyph={m.kind === "cut" ? styles.cutDot : look.glyph}
                      y={look.bottom ? BOTTOM_MARKER_Y : TOP_MARKER_Y}
                      scale={scale}
                      offset={offset}
                    />
                  );
                })}
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

const styles = StyleSheet.create({
  container: { position: "relative", alignSelf: "stretch" },
  touchArea: { position: "absolute", top: 0, left: 0, right: 0 },
  lane: { position: "absolute", left: 0, right: 0, top: LANE_TOP, height: LANE_H, overflow: "hidden", borderRadius: 6, backgroundColor: "rgba(10,10,10,0.05)" },
  overlay: { ...StyleSheet.absoluteFill },
  bar: { position: "absolute", left: 0, top: 0, width: BAR_BASE, height: LANE_H },
  clip: { backgroundColor: "#FFFFFF" },
  clipSelected: { backgroundColor: "#FFE3DF" },
  band: { backgroundColor: "rgba(242,140,40,0.28)" },
  ghostOut: { backgroundColor: "rgba(31,168,77,0.38)" },
  ghostCut: { backgroundColor: "rgba(232,41,28,0.34)" },
  wave: { position: "absolute", top: 0, height: LANE_H },
  divider: { position: "absolute", left: 0, top: LANE_TOP + 4, width: DIVIDER_W, height: LANE_H - 8, borderRadius: DIVIDER_W / 2, backgroundColor: "rgba(10,10,10,0.22)" },
  frameBar: { position: "absolute", left: 0, width: BAR_BASE, height: FRAME_LINE, backgroundColor: theme.accent },
  handle: { position: "absolute", left: 0, top: LANE_TOP, width: HANDLE_W, height: LANE_H, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 3 },
  handleLeft: { borderTopLeftRadius: HANDLE_RADIUS, borderBottomLeftRadius: HANDLE_RADIUS },
  handleRight: { borderTopRightRadius: HANDLE_RADIUS, borderBottomRightRadius: HANDLE_RADIUS },
  grip: { width: 2, height: 16, borderRadius: 1, backgroundColor: "#FFFFFF" },
  edgeLine: { position: "absolute", left: 0, top: LANE_TOP, width: 2, height: LANE_H, backgroundColor: theme.text },
  markerBox: { position: "absolute", left: 0, width: 12, height: 12, alignItems: "center", justifyContent: "center" },
  markerGlyph: { width: 12, height: 12 },
  // the cut marker is no longer a red diamond: a small grey dot (still tappable, to see what was cut)
  cutDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(10,10,10,0.35)" },
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
