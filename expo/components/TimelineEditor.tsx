import React, {
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  View,
  ScrollView,
  PanResponder,
  StyleSheet,
  Pressable,
  Image,
  Animated,
} from "react-native";
import UiText from "@/components/UiText";
import { getThumbnailAsync, type VideoThumbnailsResult } from "expo-video-thumbnails";
import * as Haptics from "expo-haptics";
import type { DraftClip } from "@/providers/PostsProvider";
import { theme } from "@/constants/theme";

// ── Constants ────────────────────────────────────────────────────────────────
const PX_PER_SEC = 44;
const TIMELINE_H = 64;
const CLIP_H = 48;
const CLIP_TOP = (TIMELINE_H - CLIP_H) / 2;
const PLAYHEAD_ZONE = 44;
const CLIP_GAP = 0;
const MIN_CLIP_PX = 20;
const EDGE_PAD = 20;
const TRIM_HANDLE_W = 32;
const MIN_TRIM_MS = 200;
const LONG_PRESS_MS = 400;

// ── Types ────────────────────────────────────────────────────────────────────
interface ClipLayout {
  clip: DraftClip;
  index: number;
  leftPx: number;
  widthPx: number;
  /** Effective duration after trim (trimEnd - trimStart) */
  durationMs: number;
  /** Original full source duration (ignoring trim) */
  sourceDurationMs: number;
  /** Effective start in content-px (the trimStart offset from clip left) — used only for dim */
  trimLeftOffsetPx: number;
  /** Effective end trim from right edge in content-px */
  trimRightOffsetPx: number;
}

interface DragState {
  clipId: string;
  fromIndex: number;
  originalLeftPx: number;
  clipWidthPx: number;
  offsetX: number;
}

interface TimelineEditorProps {
  clips: DraftClip[];
  totalDurationMs: number;
  positionMs: number;
  activeClipIndex: number;
  selectedClipId: string | null;
  onSeek: (positionMs: number) => void;
  onSelectClip: (clipId: string) => void;
  onClipUpdate: (clipId: string, updates: Partial<DraftClip>) => void;
  /** Called when the user releases a trim handle — the parent should start isolated playback */
  onTrimRelease?: () => void;
  /** Called when the user taps empty space to deselect and preview the full timeline */
  onDeselectAndPreview?: () => void;
  /** Called when the user reorders a clip via long-press drag */
  onReorderClips?: (fromIndex: number, toIndex: number) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function msToPx(ms: number) {
  return (ms / 1000) * PX_PER_SEC;
}

function pxToMs(px: number) {
  return (px / PX_PER_SEC) * 1000;
}

function msToLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 10) return `0:0${s}`;
  if (s < 60) return `0:${s}`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Effective (post-trim) duration in ms — this is what the timeline bar shows */
export function effectiveDurationMs(c: DraftClip): number {
  const dur = Math.max(0, c.durationMs ?? 0);
  const start = c.trimStartMs ?? 0;
  const end = c.trimEndMs ?? dur;
  return Math.max(end - start, pxToMs(MIN_CLIP_PX));
}

function buildClipLayouts(clips: DraftClip[]): ClipLayout[] {
  const layouts: ClipLayout[] = [];
  let timelineMs = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const sourceDur = Math.max(0, c.durationMs ?? 0);
    const eff = effectiveDurationMs(c);
    const wPx = Math.max(MIN_CLIP_PX, msToPx(eff));
    const trimStartMs = c.trimStartMs ?? 0;
    const trimEndMs = c.trimEndMs ?? sourceDur;
    const trimLeftOffsetPx = msToPx(trimStartMs);
    const trimRightOffsetPx = msToPx(sourceDur - trimEndMs);
    layouts.push({
      clip: c,
      index: i,
      leftPx: EDGE_PAD + msToPx(timelineMs),
      widthPx: wPx,
      durationMs: eff,
      sourceDurationMs: sourceDur,
      trimLeftOffsetPx,
      trimRightOffsetPx,
    });
    timelineMs += eff;
  }
  return layouts;
}

/**
 * Compute the target insertion index for a dragged clip.
 *
 * `dragCenterX` is the screen-space center of the dragged clip in content
 * coordinates (original position + drag offset + half width).
 */
function computeDropTarget(
  layouts: ClipLayout[],
  fromIndex: number,
  originalLeftPx: number,
  clipWidthPx: number,
  offsetX: number,
): number {
  if (layouts.length <= 1) return 0;

  const dragCenterX = originalLeftPx + offsetX + clipWidthPx / 2;

  // Walk through all clip midpoints to find the insertion point
  let bestIdx = fromIndex;
  let bestDist = Infinity;

  for (let i = 0; i <= layouts.length; i++) {
    // Compute the "gap center" at position i
    let gapX: number;
    if (i === 0) {
      gapX = layouts[0]!.leftPx - 4;
    } else if (i === layouts.length) {
      const last = layouts[layouts.length - 1]!;
      gapX = last.leftPx + last.widthPx + 4;
    } else {
      const prev = layouts[i - 1]!;
      const next = layouts[i]!;
      gapX = (prev.leftPx + prev.widthPx + next.leftPx) / 2;
    }

    const dist = Math.abs(dragCenterX - gapX);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Adjust: if inserting after the original position, the target index shifts
  if (bestIdx > fromIndex) {
    return bestIdx - 1;
  }
  return bestIdx;
}

/** Trigger haptic if not on web */
function triggerHaptic(style: Haptics.ImpactFeedbackStyle) {
  Haptics.impactAsync(style).catch(() => {});
}

// ── Thumbnail hook ───────────────────────────────────────────────────────────
function useThumbnails(clips: DraftClip[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const newThumbs: Record<string, string> = {};
    async function load() {
      for (const clip of clips) {
        if (clip.type !== "video") continue;
        if (thumbs[clip.id]) {
          newThumbs[clip.id] = thumbs[clip.id]!;
          continue;
        }
        try {
              const result: VideoThumbnailsResult = await getThumbnailAsync(clip.uri, {
            time: Math.round((clip.durationMs ?? 1000) / 2),
          });
          newThumbs[clip.id] = result.uri;
        } catch {
          console.warn(`[timeline-thumb] FAILED clip ${clip.id.slice(-8)}`);
        }
      }
      if (!cancelled) {
        setThumbs((prev) => ({ ...prev, ...newThumbs }));
      }
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.map((c) => c.id).join(",")]);

  return thumbs;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function TimelineEditor({
  clips,
  totalDurationMs,
  positionMs,
  activeClipIndex,
  selectedClipId,
  onSeek,
  onSelectClip,
  onClipUpdate,
  onTrimRelease,
  onDeselectAndPreview,
  onReorderClips,
}: TimelineEditorProps) {
  const scrollRef = useRef<ScrollView>(null);
  const containerW = useRef(1);

  // scrollX as state so overlays re-render
  const [scrollX, setScrollX] = useState(0);
  const scrollXRef = useRef(0);
  useEffect(() => { scrollXRef.current = scrollX; }, [scrollX]);

  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [isTrimming, setIsTrimming] = useState<"left" | "right" | null>(null);

  // Visual drag offset for left trim handle — follows the finger during drag,
  // resets to 0 on release so the handle snaps back to the clip edge.
  const [leftTrimDragPx, setLeftTrimDragPx] = useState(0);

  // ── Drag-to-reorder state ────────────────────────────────────────────────
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  useEffect(() => { dragStateRef.current = dragState; }, [dragState]);
  const dragActiveRef = useRef(false);
  useEffect(() => { dragActiveRef.current = dragState !== null; }, [dragState]);
  const dragOriginRef = useRef<"playhead" | "pressable" | null>(null);
  const dragGrantSnapshotRef = useRef<{ offsetX: number; pageX: number } | null>(null);

  const thumbnails = useThumbnails(clips);

  // ── Layouts ──────────────────────────────────────────────────────────────
  const layouts = useMemo(() => buildClipLayouts(clips), [clips]);
  const contentW = useMemo(
    () => Math.max(EDGE_PAD + msToPx(totalDurationMs) + EDGE_PAD, 400),
    [totalDurationMs],
  );

  const selectedLayout = useMemo(
    () => layouts.find((l) => l.clip.id === selectedClipId) ?? null,
    [layouts, selectedClipId],
  );

  // Playhead px in content coordinates — absolute positioning so trim
  // operations (which change totalDurationMs) never shift the playhead
  const playheadPx = useMemo(
    () => EDGE_PAD + clamp(msToPx(positionMs), 0, msToPx(totalDurationMs)),
    [positionMs, totalDurationMs],
  );

  // ── Drop target indicator position ───────────────────────────────────────
  const dropTargetIdx = useMemo(() => {
    if (!dragState) return null;
    return computeDropTarget(
      layouts,
      dragState.fromIndex,
      dragState.originalLeftPx,
      dragState.clipWidthPx,
      dragState.offsetX,
    );
  }, [dragState, layouts]);

  // Drop indicator X position in content coordinates
  const dropIndicatorX = useMemo(() => {
    if (dropTargetIdx === null || !dragState) return null;
    const fromIdx = dragState.fromIndex;
    let targetIdx = dropTargetIdx;

    // If target >= fromIdx, the visual position is one slot to the right
    // (because the original clip is "removed" during drag)
    if (targetIdx >= fromIdx) {
      targetIdx = Math.min(targetIdx + 1, layouts.length);
    }

    if (targetIdx === 0) {
      return layouts[0]!.leftPx - 1;
    }
    if (targetIdx >= layouts.length) {
      const last = layouts[layouts.length - 1]!;
      return last.leftPx + last.widthPx + 1;
    }
    return layouts[targetIdx]!.leftPx - 1;
  }, [dropTargetIdx, dragState, layouts]);

  // ── Auto-scroll playhead into view ────────────────────────────────────────
  useEffect(() => {
    if (
      isDraggingPlayhead ||
      isTrimming ||
      dragState ||
      !scrollRef.current ||
      containerW.current < 100
    )
      return;
    const pw = playheadPx;
    const sx = scrollXRef.current;
    const cw = containerW.current;
    const margin = 60;
    if (pw < sx + margin || pw > sx + cw - margin) {
      scrollRef.current.scrollTo({
        x: clamp(pw - cw / 2, 0, contentW - cw),
        animated: true,
      });
    }
  }, [playheadPx, isDraggingPlayhead, isTrimming, dragState, contentW]);

  // Auto-scroll to selected clip
  useEffect(() => {
    if (!selectedLayout || !scrollRef.current || containerW.current < 100 || dragState)
      return;
    const cx = selectedLayout.leftPx + selectedLayout.widthPx / 2;
    const cw = containerW.current;
    const sx = scrollXRef.current;
    if (cx < sx + 20 || cx > sx + cw - 20) {
      scrollRef.current.scrollTo({
        x: clamp(cx - cw / 2, 0, contentW - cw),
        animated: true,
      });
    }
  }, [selectedLayout, contentW, dragState]);

  // ── Stable refs ──────────────────────────────────────────────────────────
  const onSeekRef = useRef(onSeek);
  const onSelectClipRef = useRef(onSelectClip);
  const onClipUpdateRef = useRef(onClipUpdate);
  const onTrimReleaseRef = useRef(onTrimRelease);
  const onDeselectAndPreviewRef = useRef(onDeselectAndPreview);
  const onReorderClipsRef = useRef(onReorderClips);
  const selectedLayoutRef = useRef(selectedLayout);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);
  useEffect(() => { onSelectClipRef.current = onSelectClip; }, [onSelectClip]);
  useEffect(() => { onClipUpdateRef.current = onClipUpdate; }, [onClipUpdate]);
  useEffect(() => { onTrimReleaseRef.current = onTrimRelease; }, [onTrimRelease]);
  useEffect(() => { onDeselectAndPreviewRef.current = onDeselectAndPreview; }, [onDeselectAndPreview]);
  useEffect(() => { onReorderClipsRef.current = onReorderClips; }, [onReorderClips]);
  useEffect(() => { selectedLayoutRef.current = selectedLayout; }, [selectedLayout]);

  const totalDurRef = useRef(totalDurationMs);
  useEffect(() => { totalDurRef.current = totalDurationMs; }, [totalDurationMs]);
  const contentWRef = useRef(contentW);
  useEffect(() => { contentWRef.current = contentW; }, [contentW]);
  const layoutsRef = useRef(layouts);
  useEffect(() => { layoutsRef.current = layouts; }, [layouts]);
  const playheadPxRef = useRef(playheadPx);
  useEffect(() => { playheadPxRef.current = playheadPx; }, [playheadPx]);

  // ── Playhead drag with long-press-to-drag detection ──────────────────────
  const dragStartPx = useRef(0);
  const dragInitTotalMs = useRef(0);
  // Tracks whether a touch inside the playhead zone actually moved.
  // When false on release, the touch was a tap and should be forwarded
  // to the underlying clip Pressable / deselection logic instead of
  // being silently consumed.
  const dragMovedRef = useRef(false);

  // Long-press timer for clip drag detection within the playhead zone
  const playheadLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playheadLongPressFired = useRef(false);
  // Track whether the long press activated drag mode so we can handle
  // release correctly (commit reorder vs tap/seek).
  const playheadDragActive = useRef(false);

  const playheadPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !isTrimming && !dragActiveRef.current,
        onMoveShouldSetPanResponder: (_, gs) =>
          !isTrimming && !dragActiveRef.current && Math.abs(gs.dx) > 2,
        onPanResponderGrant: (evt) => {
          const touchPx =
            evt.nativeEvent.locationX +
            playheadPxRef.current -
            PLAYHEAD_ZONE / 2;
          setIsDraggingPlayhead(true);
          dragStartPx.current = clamp(
            touchPx,
            EDGE_PAD,
            contentWRef.current - EDGE_PAD,
          );
          dragInitTotalMs.current = totalDurRef.current;
          dragMovedRef.current = false;
          playheadLongPressFired.current = false;
          playheadDragActive.current = false;

          // Start long-press timer for clip drag detection
          if (playheadLongPressTimer.current) {
            clearTimeout(playheadLongPressTimer.current);
          }
          playheadLongPressTimer.current = setTimeout(() => {
            playheadLongPressFired.current = true;
            // Check if the touch is over a clip — if so, start drag mode
            const touchPx2 = dragStartPx.current;
            for (const l of layoutsRef.current) {
              if (touchPx2 >= l.leftPx && touchPx2 <= l.leftPx + l.widthPx) {
                triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
                playheadDragActive.current = true;
                dragOriginRef.current = "playhead";
                setDragState({
                  clipId: l.clip.id,
                  fromIndex: l.index,
                  originalLeftPx: l.leftPx,
                  clipWidthPx: l.widthPx,
                  offsetX: 0,
                });
                return;
              }
            }
          }, LONG_PRESS_MS);
        },
        onPanResponderMove: (_, gs) => {
          // Mark as a genuine drag once the finger moves beyond the jitter threshold.
          if (Math.abs(gs.dx) > 3) dragMovedRef.current = true;

          // Cancel long-press timer if user started moving significantly
          // before the timer fired (they're trying to scrub, not drag a clip)
          if (
            Math.abs(gs.dx) > 8 &&
            !playheadLongPressFired.current &&
            playheadLongPressTimer.current
          ) {
            clearTimeout(playheadLongPressTimer.current);
            playheadLongPressTimer.current = null;
          }

          if (playheadDragActive.current) {
            // In drag mode — update the drag offset
            setDragState((prev) =>
              prev ? { ...prev, offsetX: gs.dx } : null,
            );
            return;
          }

          const newPx = clamp(
            dragStartPx.current + gs.dx,
            EDGE_PAD,
            contentWRef.current - EDGE_PAD,
          );
          const ms = clamp(
            pxToMs(newPx - EDGE_PAD),
            0,
            dragInitTotalMs.current,
          );
          onSeekRef.current(ms);
        },
        onPanResponderRelease: (_, gs) => {
          setIsDraggingPlayhead(false);

          if (playheadLongPressTimer.current) {
            clearTimeout(playheadLongPressTimer.current);
            playheadLongPressTimer.current = null;
          }

          if (playheadDragActive.current) {
            // Commit the drag reorder — playhead handles own release
            playheadDragActive.current = false;
            dragOriginRef.current = null;
            const ds = dragStateRef.current;
            if (ds) {
              const dropIdx = computeDropTarget(
                layoutsRef.current,
                ds.fromIndex,
                ds.originalLeftPx,
                ds.clipWidthPx,
                ds.offsetX,
              );
              if (dropIdx !== ds.fromIndex) {
                onReorderClipsRef.current?.(ds.fromIndex, dropIdx);
              }
            }
            setDragState(null);
            return;
          }

          // ── Tap fallback ──────────────────────────────────────────────
          if (!dragMovedRef.current) {
            const touchPx = dragStartPx.current;
            let hitClip = false;
            for (const l of layoutsRef.current) {
              if (touchPx >= l.leftPx && touchPx <= l.leftPx + l.widthPx) {
                onSelectClipRef.current(l.clip.id);
                hitClip = true;
                break;
              }
            }
            if (!hitClip) {
              const sel = selectedLayoutRef.current;
              const dur = totalDurRef.current;
              const ms = clamp(pxToMs(touchPx - EDGE_PAD), 0, dur);
              if (sel) {
                onDeselectAndPreviewRef.current?.();
              } else {
                onSeekRef.current(ms);
              }
            }
          }

          playheadLongPressFired.current = false;
        },
        onPanResponderTerminate: () => {
          setIsDraggingPlayhead(false);
          if (playheadLongPressTimer.current) {
            clearTimeout(playheadLongPressTimer.current);
            playheadLongPressTimer.current = null;
          }
          // If a clip drag was in progress, switch origin so the
          // drag overlay’s PanResponder can capture the touch on the
          // next move event.  Otherwise the drag is lost.
          const wasDragging = playheadDragActive.current;
          playheadDragActive.current = false;
          playheadLongPressFired.current = false;
          if (wasDragging) dragOriginRef.current = "pressable";
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTrimming],
  );

  // ── Drag overlay PanResponder ────────────────────────────────────────────
  // When a clip Pressable fires onLongPress, dragState is set. This overlay
  // steals the touch via onMoveShouldSetPanResponderCapture (capture phase)
  // and tracks the drag using absolute pageX coordinates so the offset is
  // correct regardless of where the touch was stolen from.
  const dragPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponderCapture: () =>
          dragOriginRef.current === "pressable",
        onPanResponderGrant: (evt) => {
          const ds = dragStateRef.current;
          if (ds) {
            dragGrantSnapshotRef.current = {
              offsetX: ds.offsetX,
              pageX: evt.nativeEvent.pageX,
            };
          }
        },
        onPanResponderMove: (evt) => {
          const snap = dragGrantSnapshotRef.current;
          const ds = dragStateRef.current;
          if (!snap || !ds) return;
          const newOffsetX =
            snap.offsetX + (evt.nativeEvent.pageX - snap.pageX);
          setDragState((prev) =>
            prev ? { ...prev, offsetX: newOffsetX } : null,
          );
        },
        onPanResponderRelease: (evt) => {
          dragOriginRef.current = null;
          const snap = dragGrantSnapshotRef.current;
          const ds = dragStateRef.current;
          if (snap && ds) {
            const finalOffsetX =
              snap.offsetX + (evt.nativeEvent.pageX - snap.pageX);
            const dropIdx = computeDropTarget(
              layoutsRef.current,
              ds.fromIndex,
              ds.originalLeftPx,
              ds.clipWidthPx,
              finalOffsetX,
            );
            if (dropIdx !== ds.fromIndex) {
              onReorderClipsRef.current?.(ds.fromIndex, dropIdx);
            }
          }
          dragGrantSnapshotRef.current = null;
          setDragState(null);
        },
        onPanResponderTerminate: () => {
          dragOriginRef.current = null;
          dragGrantSnapshotRef.current = null;
          setDragState(null);
        },
      }),
    [],
  );

  // ── Tap on content area ──────────────────────────────────────────────────
  // Only handles taps on empty space (between/outside clips).
  // Clip selection is handled by the Pressable.onPress on each clip bar.
  const handleContentTouchEnd = useCallback(
    (ev: { nativeEvent: { locationX: number } }) => {
      if (isDraggingPlayhead || isTrimming || dragState) return;
      const touchPx = ev.nativeEvent.locationX + scrollXRef.current;

      // Check if the tap landed on any clip bar — if so, let the Pressable
      // handle it and don't also seek.
      for (const l of layoutsRef.current) {
        if (touchPx >= l.leftPx && touchPx <= l.leftPx + l.widthPx) {
          return; // Pressable.onPress will handle selection
        }
      }

      // Tap empty area: deselect and switch to full-timeline preview.
      const cw = contentWRef.current;
      const dur = totalDurRef.current;
      if (cw > EDGE_PAD * 2 && dur > 0) {
        const ms = clamp(pxToMs(touchPx - EDGE_PAD), 0, dur);
        if (selectedClipId) {
          onDeselectAndPreviewRef.current?.();
        } else {
          onSeekRef.current(ms);
        }
      }
    },
    [isDraggingPlayhead, isTrimming, dragState, selectedClipId],
  );

  // ── Trim handle drag with auto-scroll ───────────────────────────────────
  const trimDragStartMs = useRef(0);
  const trimAutoScrollRaf = useRef<number | null>(null);

  // Stable refs so trim bounds survive layout recalc / stale PanResponder closures
  const sourceDurRef = useRef(0);
  const sourceLeftPxRef = useRef(0);
  useEffect(() => {
    if (selectedLayout) sourceDurRef.current = selectedLayout.sourceDurationMs;
  }, [selectedLayout]);

  const leftTrimPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const sl = selectedLayoutRef.current;
          if (!sl) return;
          setIsTrimming("left");
          trimDragStartMs.current = sl.clip.trimStartMs ?? 0;
          sourceDurRef.current = sl.sourceDurationMs;
          sourceLeftPxRef.current = sl.leftPx - sl.trimLeftOffsetPx;
          setLeftTrimDragPx(0);
        },
        onPanResponderMove: (_, gs) => {
          const sl = selectedLayoutRef.current;
          if (!sl) return;
          const msDelta = pxToMs(gs.dx);
          const trimEnd = sl.clip.trimEndMs ?? sourceDurRef.current;
          const newStart = clamp(
            trimDragStartMs.current + msDelta,
            0,
            trimEnd - MIN_TRIM_MS,
          );
          onClipUpdateRef.current(sl.clip.id, {
            trimStartMs: newStart,
          });
          const dragPx = msToPx(newStart - trimDragStartMs.current);
          setLeftTrimDragPx(dragPx);
          trimAutoScroll(TRIM_HANDLE_W, "left");
        },
        onPanResponderRelease: () => {
          setIsTrimming(null);
          setLeftTrimDragPx(0);
          cancelTrimAutoScroll();
          onTrimReleaseRef.current?.();
        },
        onPanResponderTerminate: () => {
          setIsTrimming(null);
          setLeftTrimDragPx(0);
          cancelTrimAutoScroll();
          onTrimReleaseRef.current?.();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedLayout?.clip.id],
  );

  const rightTrimPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const sl = selectedLayoutRef.current;
          if (!sl) return;
          setIsTrimming("right");
          trimDragStartMs.current =
            sl.clip.trimEndMs ?? sl.sourceDurationMs;
          sourceDurRef.current = sl.sourceDurationMs;
        },
        onPanResponderMove: (_, gs) => {
          const sl = selectedLayoutRef.current;
          if (!sl) return;
          const msDelta = pxToMs(gs.dx);
          const trimStart = sl.clip.trimStartMs ?? 0;
          const newEnd = clamp(
            trimDragStartMs.current + msDelta,
            trimStart + MIN_TRIM_MS,
            sourceDurRef.current,
          );
          onClipUpdateRef.current(sl.clip.id, {
            trimEndMs: newEnd,
          });
          trimAutoScroll(TRIM_HANDLE_W, "right");
        },
        onPanResponderRelease: () => {
          setIsTrimming(null);
          cancelTrimAutoScroll();
          onTrimReleaseRef.current?.();
        },
        onPanResponderTerminate: () => {
          setIsTrimming(null);
          cancelTrimAutoScroll();
          onTrimReleaseRef.current?.();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedLayout?.clip.id],
  );

  // ── Auto-scroll helper during trim ──────────────────────────────────────
  const cancelTrimAutoScroll = useCallback(() => {
    if (trimAutoScrollRaf.current !== null) {
      cancelAnimationFrame(trimAutoScrollRaf.current);
      trimAutoScrollRaf.current = null;
    }
  }, []);

  const trimAutoScroll = useCallback(
    (handleW: number, side: "left" | "right") => {
      if (!scrollRef.current || !selectedLayout) return;
      const cw = containerW.current;
      if (cw < 100) return;

      const handleScreenX =
        side === "left"
          ? selectedLayout.leftPx - scrollXRef.current
          : selectedLayout.leftPx + selectedLayout.widthPx - scrollXRef.current;

      const edgeMargin = 44;
      let velocity = 0;
      if (handleScreenX < edgeMargin) {
        velocity = -(edgeMargin - handleScreenX) * 0.3;
      } else if (handleScreenX > cw - edgeMargin) {
        velocity = (handleScreenX - (cw - edgeMargin)) * 0.3;
      }

      if (velocity === 0) {
        cancelTrimAutoScroll();
        return;
      }

      const step = () => {
        const newX = clamp(
          scrollXRef.current + velocity,
          0,
          Math.max(0, contentWRef.current - cw),
        );
        scrollRef.current?.scrollTo({ x: newX, animated: false });
        trimAutoScrollRaf.current = requestAnimationFrame(step);
      };
      if (trimAutoScrollRaf.current === null) {
        trimAutoScrollRaf.current = requestAnimationFrame(step);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedLayout],
  );

  // ── Trim handle screen positions ─────────────────────────────────────────
  const trimLeftScreen = useMemo(() => {
    if (!selectedLayout) return -999;
    return selectedLayout.leftPx + leftTrimDragPx - scrollX - TRIM_HANDLE_W / 2;
  }, [selectedLayout, scrollX, leftTrimDragPx]);

  const trimRightScreen = useMemo(() => {
    if (!selectedLayout) return -999;
    return selectedLayout.leftPx + selectedLayout.widthPx - scrollX - TRIM_HANDLE_W / 2;
  }, [selectedLayout, scrollX]);

  // ── Dimmed segment screen positions ──────────────────────────────────────
  const leftDimmedScreen = useMemo(() => {
    if (!selectedLayout) return null;
    const isDraggingLeft = isTrimming === "left";

    if (isDraggingLeft) {
      const handlePx = selectedLayout.leftPx + leftTrimDragPx;
      const w = handlePx - sourceLeftPxRef.current;
      if (w <= 1) return null;
      return {
        left: sourceLeftPxRef.current - scrollX,
        width: w,
      };
    }

    const w = selectedLayout.trimLeftOffsetPx;
    if (w <= 1) return null;
    return {
      left: selectedLayout.leftPx - w - scrollX,
      width: w,
    };
  }, [selectedLayout, scrollX, leftTrimDragPx, isTrimming]);

  const rightDimmedScreen = useMemo(() => {
    if (!selectedLayout) return null;
    const w = selectedLayout.trimRightOffsetPx;
    if (w <= 1) return null;
    return {
      left: selectedLayout.leftPx + selectedLayout.widthPx - scrollX,
      width: w,
    };
  }, [selectedLayout, scrollX]);

  // ── Render ────────────────────────────────────────────────────────────────
  const playheadScreen = playheadPx - scrollX;

  // Drag visuals: dragged clip overlay, ghost, and drop indicator
  const draggedClipScreen = useMemo(() => {
    if (!dragState) return null;
    return {
      left: dragState.originalLeftPx + dragState.offsetX - scrollX,
      width: dragState.clipWidthPx,
    };
  }, [dragState, scrollX]);

  const dragGhostScreen = useMemo(() => {
    if (!dragState) return null;
    return {
      left: dragState.originalLeftPx - scrollX,
      width: dragState.clipWidthPx,
    };
  }, [dragState, scrollX]);

  const dropIndicatorScreen = useMemo(() => {
    if (dropIndicatorX === null) return null;
    return dropIndicatorX - scrollX;
  }, [dropIndicatorX, scrollX]);

  // Find the dragged clip's layout for thumbnail
  const draggedLayout = useMemo(() => {
    if (!dragState) return null;
    return layouts.find((l) => l.clip.id === dragState.clipId) ?? null;
  }, [dragState, layouts]);

  return (
    <View style={styles.container}>
      {/* ── Drag overlay (captures touch after long-press) ── */}
      {dragState && (
        <View
          style={[styles.dragOverlay, { backgroundColor: "rgba(232,41,28,0.3)", borderWidth: 2, borderColor: "red" }]}
          {...dragPan.panHandlers}
        />
      )}

      {/* ── Drop indicator line ── */}
      {dropIndicatorScreen !== null && dropIndicatorScreen !== undefined && (
        <View
          pointerEvents="none"
          style={[
            styles.dropIndicator,
            { left: dropIndicatorScreen },
          ]}
        />
      )}

      {/* ── Dragged clip overlay (follows finger) ── */}
      {draggedClipScreen && draggedLayout && (
        <View
          pointerEvents="none"
          style={[
            styles.dragClipOverlay,
            {
              left: draggedClipScreen.left,
              width: draggedClipScreen.width,
            },
          ]}
        >
          {thumbnails[draggedLayout.clip.id] ? (
            <Image
              source={{ uri: thumbnails[draggedLayout.clip.id] }}
              style={styles.clipThumb}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.clipPlaceholder} />
          )}
          <View pointerEvents="none" style={styles.clipLabelWrap}>
            <UiText style={styles.clipLabel} numberOfLines={1}>
              {msToLabel(draggedLayout.durationMs)}
            </UiText>
          </View>
        </View>
      )}

      {/* ── ScrollView with clip bars ── */}
      <View style={styles.scrollWrap}>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          bounces={false}
          scrollEventThrottle={16}
          decelerationRate="fast"
          onScroll={(e) => setScrollX(e.nativeEvent.contentOffset.x)}
          onLayout={(e) => {
            containerW.current = e.nativeEvent.layout.width;
          }}
          scrollEnabled={!isDraggingPlayhead && !isTrimming && !dragState}
        >
          <View
            style={[styles.content, { width: contentW, height: TIMELINE_H }]}
            onTouchEnd={handleContentTouchEnd}
          >
            {/* Clip bars */}
            {layouts.map((layout) => {
              const isSelected = layout.clip.id === selectedClipId;
              const isActive = layout.index === activeClipIndex && !selectedClipId;
              const thumb = thumbnails[layout.clip.id];
              const isBeingDragged = dragState?.clipId === layout.clip.id;

              return (
                <Pressable
                  key={layout.clip.id}
                  onPress={() => {
                    if (dragState) return;
                    onSelectClip(layout.clip.id);
                  }}
                  onLongPress={() => {
                    triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
                    dragOriginRef.current = "pressable";
                    setDragState({
                      clipId: layout.clip.id,
                      fromIndex: layout.index,
                      originalLeftPx: layout.leftPx,
                      clipWidthPx: layout.widthPx,
                      offsetX: 0,
                    });
                  }}
                  delayLongPress={LONG_PRESS_MS}
                  style={[
                    styles.clipBar,
                    {
                      left: layout.leftPx,
                      width: layout.widthPx,
                    },
                    isSelected && !isBeingDragged && styles.clipBarSelected,
                    isBeingDragged && styles.clipBarGhost,
                  ]}
                >
                  {/* Thumbnail */}
                  {thumb ? (
                    <Image
                      source={{ uri: thumb }}
                      style={styles.clipThumb}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={styles.clipPlaceholder} />
                  )}

                  {/* Duration label */}
                  <View pointerEvents="none" style={styles.clipLabelWrap}>
                    <UiText style={styles.clipLabel} numberOfLines={1}>
                      {msToLabel(layout.durationMs)}
                    </UiText>
                  </View>

                  {/* Active indicator dot */}
                  {isActive && !isBeingDragged && (
                    <View pointerEvents="none" style={styles.activeDot} />
                  )}
                </Pressable>
              );
            })}

            {/* Faint playhead guide line inside content */}
            <View
              pointerEvents="none"
              style={[
                styles.playheadLineInner,
                { left: playheadPx - 0.5 },
              ]}
            />
          </View>
        </ScrollView>
      </View>

      {/* ── Dimmed trim segments (outside ScrollView, behind handles) ── */}
      {selectedLayout && selectedLayout.clip.type === "video" && !dragState && (
        <>
          {leftDimmedScreen && (
            <View
              pointerEvents="none"
              style={[
                styles.trimDimmedSegment,
                { left: leftDimmedScreen.left, width: leftDimmedScreen.width },
              ]}
            />
          )}
          {rightDimmedScreen && (
            <View
              pointerEvents="none"
              style={[
                styles.trimDimmedSegment,
                { left: rightDimmedScreen.left, width: rightDimmedScreen.width },
              ]}
            />
          )}
        </>
      )}

      {/* ── Trim handles overlay (outside ScrollView) ── */}
      {selectedLayout && selectedLayout.clip.type === "video" && !dragState && (
        <>
          {/* Left trim handle */}
          <View
            style={[
              styles.trimHandleZone,
              { left: trimLeftScreen },
              isTrimming === "left" && styles.trimHandleZoneActive,
            ]}
            {...leftTrimPan.panHandlers}
          >
            <View style={styles.trimHandleBar}>
              <View style={styles.trimHandleGrip} />
              <View style={styles.trimHandleGrip} />
            </View>
          </View>

          {/* Right trim handle */}
          <View
            style={[
              styles.trimHandleZone,
              { left: trimRightScreen },
              isTrimming === "right" && styles.trimHandleZoneActive,
            ]}
            {...rightTrimPan.panHandlers}
          >
            <View style={styles.trimHandleBar}>
              <View style={styles.trimHandleGrip} />
              <View style={styles.trimHandleGrip} />
            </View>
          </View>
        </>
      )}

      {/* ── Playhead dot overlay (outside ScrollView) ── */}
      <View
        style={[
          styles.playheadOverlay,
          { left: playheadScreen - PLAYHEAD_ZONE / 2 },
        ]}
        pointerEvents={dragState ? "none" : "auto"}
        {...playheadPan.panHandlers}
      >
        <View style={styles.playheadLine} />
        <View
          style={[
            styles.playheadDot,
            isDraggingPlayhead && styles.playheadDotActive,
          ]}
        />
      </View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    height: TIMELINE_H + 12,
    position: "relative",
    overflow: "visible",
  },
  scrollWrap: {
    flex: 1,
  },
  content: {
    position: "relative",
  },

  // ── Drag overlay ──
  dragOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    backgroundColor: "transparent",
  },

  // ── Drop indicator ──
  dropIndicator: {
    position: "absolute",
    top: CLIP_TOP - 4,
    width: 3,
    height: CLIP_H + 8,
    borderRadius: 0,
    backgroundColor: theme.accent,
    zIndex: 45,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 6,
  },

  // ── Dragged clip overlay ──
  dragClipOverlay: {
    position: "absolute",
    top: CLIP_TOP,
    height: CLIP_H,
    borderRadius: 0,
    overflow: "hidden",
    zIndex: 46,
    backgroundColor: "#FFFFFF",
    borderWidth: 2,
    borderColor: theme.accent,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
    opacity: 0.9,
  },

  // ── Clip bars ──
  clipBar: {
    position: "absolute",
    top: CLIP_TOP,
    height: CLIP_H,
    borderRadius: 0,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "rgba(10,10,10,0.06)",
  },
  clipBarSelected: {
    backgroundColor: "#FFFFFF",
  },
  clipBarGhost: {
    opacity: 0.25,
    backgroundColor: "rgba(28,28,34,0.4)",
  },
  clipThumb: {
    ...StyleSheet.absoluteFill,
    opacity: 0.55,
  },
  clipPlaceholder: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#FFFFFF",
  },
  clipLabelWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  clipLabel: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 10,
    fontWeight: "900" as const,
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.2,
  },
  activeDot: {
    position: "absolute",
    bottom: 3,
    alignSelf: "center",
    width: 5,
    height: 5,
    borderRadius: 0,
    backgroundColor: "rgba(255,255,255,0.5)",
  },

  // ── Trim dimmed segment (shows trimmed portion outside active bar) ──
  trimDimmedSegment: {
    position: "absolute",
    top: CLIP_TOP,
    height: CLIP_H,
    borderRadius: 0,
    backgroundColor: "rgba(20, 20, 26, 0.55)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.07)",
    borderStyle: "dashed" as const,
  },

  // ── Trim handles ──
  trimHandleZone: {
    position: "absolute",
    top: CLIP_TOP - 4,
    width: TRIM_HANDLE_W,
    height: CLIP_H + 8,
    zIndex: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  trimHandleZoneActive: {
    // visual feedback while dragging
  },
  trimHandleBar: {
    width: 4,
    height: "70%",
    borderRadius: 0,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  trimHandleGrip: {
    width: 2,
    height: 10,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.3)",
  },

  // ── Playhead elements ──
  playheadLineInner: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "rgba(10,10,10,0.08)",
  },
  playheadOverlay: {
    position: "absolute",
    top: 0,
    width: PLAYHEAD_ZONE,
    height: TIMELINE_H,
    alignItems: "center",
    zIndex: 25,
  },
  playheadLine: {
    position: "absolute",
    width: 2,
    top: 0,
    bottom: 0,
    backgroundColor: "#FFFFFF",
    left: PLAYHEAD_ZONE / 2 - 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  playheadDot: {
    position: "absolute",
    top: 2,
    width: 14,
    height: 14,
    borderRadius: 0,
    backgroundColor: theme.accent,
    left: PLAYHEAD_ZONE / 2 - 7,
    borderWidth: 2,
    borderColor: "#fff",
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 6,
    elevation: 8,
  },
  playheadDotActive: {
    transform: [{ scale: 1.3 }],
    shadowOpacity: 0.9,
    shadowRadius: 10,
  },
});
