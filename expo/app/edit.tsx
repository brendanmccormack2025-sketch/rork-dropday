import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Dimensions,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import {
  Play,
  ArrowLeft,
  Type,
  Trash2,
  Scissors,
  Split,
  RectangleEllipsis,
  Undo2,
  Redo2,
  Pencil,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { coverState } from "@/lib/coverState";
import {
  usePosts,
  type DraftClip,
  type DraftProject,
  type TextOverlay,
  type TextBackgroundStyle,
} from "@/providers/PostsProvider";
import TimelineEditor, { effectiveDurationMs } from "@/components/TimelineEditor";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import TextOverlayEditor from "@/components/TextOverlayEditor";
import DraggableTextOverlay, {
  BG_STYLES,
} from "@/components/DraggableTextOverlay";

const DRAG_EDGE_MARGIN = 0.01;
function clampNormalised(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// ── Helpers ──────────────────────────────────────────────────────────────────

function triggerHaptic(style: Haptics.ImpactFeedbackStyle) {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(style).catch(() => {});
  }
}

function newClipId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Minimum ms from either trim edge required to allow a split */
const MIN_SPLIT_EDGE_MS = 200;

function newOverlayId() {
  return `ov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function calcFrameDims(areaW: number, areaH: number, aspect: number) {
  if (areaW <= 0 || areaH <= 0) return { w: areaW, h: areaH };
  if (areaW / areaH > aspect) {
    return { w: areaH * aspect, h: areaH };
  }
  return { w: areaW, h: areaW / aspect };
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function EditScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { createPost, saveDraftProject, deleteDraftProject, draftProjects, draftsLoaded } =
    usePosts();
  const {
    clips: clipsJson,
    videoUrl: nativeVideoUrl,
    draftId,
  } = useLocalSearchParams<{
    clips: string;
    videoUrl?: string;
    draftId?: string;
  }>();

  // ── Frame measurement ────────────────────────────────────────────────────
  const [previewAreaSize, setPreviewAreaSize] = useState({
    w: SCREEN_W,
    h: 400,
  });
  const ASPECT = 9 / 16;
  const frameDims = useMemo(
    () => calcFrameDims(previewAreaSize.w, previewAreaSize.h, ASPECT),
    [previewAreaSize],
  );

  // ── Initialize clips ─────────────────────────────────────────────────────
  const initialClips: DraftClip[] = useMemo(() => {
    if (draftId) {
      const draft = draftProjects.find((d) => d.id === draftId);
      if (draft) return draft.clips;
    }
    if (nativeVideoUrl && !clipsJson) {
      return [{ id: newClipId(), uri: nativeVideoUrl, type: "video" as const }];
    }
    try {
      return (JSON.parse(clipsJson ?? "[]") as DraftClip[]).map((c) => ({
        ...c,
        trimStartMs: c.trimStartMs ?? 0,
        trimEndMs: c.trimEndMs ?? c.durationMs,
      }));
    } catch {
      return [];
    }
  }, [clipsJson, nativeVideoUrl, draftId, draftProjects]);

  const [clips, setClips] = useState<DraftClip[]>(initialClips);

  useEffect(() => {
    if (draftId) {
      const draft = draftProjects.find((d) => d.id === draftId);
      if (draft?.clips.length) setClips(draft.clips);
    }
  }, [draftId, draftProjects]);

  // ── Text overlays ────────────────────────────────────────────────────────
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>(() => {
    if (draftId) {
      const draft = draftProjects.find((d) => d.id === draftId);
      if (draft?.textOverlays?.length) {
        return draft.textOverlays.map((ov) => ({
          ...ov,
          backgroundStyle: ov.backgroundStyle ?? "none-white",
        }));
      }
    }
    return [];
  });

  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [textEditorVisible, setTextEditorVisible] = useState(false);
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // ── Drag-to-trash tracking ───────────────────────────────────────────────
  const [dragOverlayInfo, setDragOverlayInfo] = useState<{
    id: string;
    isDragging: boolean;
    centerX: number;
    centerY: number;
  } | null>(null);

  // ── Undo / Redo ─────────────────────────────────────────────────────────
  const { canUndo, canRedo, undo, redo, pushSnapshot, pushRedo } = useUndoRedo();
  const trimNeedsSnapshotRef = useRef(false);
  const textEditSnapshotTakenRef = useRef(false);

  useEffect(() => {
    textEditSnapshotTakenRef.current = false;
  }, [selectedOverlayId]);

  // ── Playback ──────────────────────────────────────────────────────────────
  const videoRef = useRef<Video>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [positionMs, setPositionMs] = useState<number>(0);
  const pendingSeekRef = useRef<number | null>(null);
  const segmentOffsetRef = useRef<number>(0);
  const activeIndexRef = useRef<number>(0);
  const durationSetRef = useRef<boolean>(false);
  const lastPositionUpdate = useRef<number>(0);
  const clipsRef = useRef(clips);
  const safeSeekActiveRef = useRef<boolean>(false);

  // Stable refs for cover-picker execution functions
  const executeSaveDraftRef = useRef<(uri: string | null, ms: number) => Promise<void>>(async () => {});
  const executePostRef = useRef<(uri: string | null) => Promise<void>>(async () => {});

  // Stable refs for undo/redo handlers
  const clipsForUndoRef = useRef(clips);
  useEffect(() => { clipsForUndoRef.current = clips; }, [clips]);
  const textOverlaysForUndoRef = useRef(textOverlays);
  useEffect(() => { textOverlaysForUndoRef.current = textOverlays; }, [textOverlays]);

  // ── Trim tracking ───────────────────────────────────────────────────────
  const trimStartRef = useRef<number>(0);
  const trimEndRef = useRef<number>(0);
  const trimSeekDoneRef = useRef<boolean>(false);
  const trimEndHandledRef = useRef<boolean>(false);
  const trimGenerationRef = useRef<number>(0);
  const prevTrimStartRef = useRef<number>(0);
  const prevTrimEndRef = useRef<number>(0);
  useEffect(() => {
    const clip = clips[activeIndex];
    const newTrimStart = clip?.trimStartMs ?? 0;
    const newTrimEnd = clip?.trimEndMs ?? (clip?.durationMs ?? 0);
    const oldTrimStart = prevTrimStartRef.current;
    const oldTrimEnd = prevTrimEndRef.current;
    const trimStartChanged = newTrimStart !== oldTrimStart;
    const trimEndChanged = newTrimEnd !== oldTrimEnd;
    if (trimStartChanged || trimEndChanged) {
      trimGenerationRef.current += 1;
    }
    trimStartRef.current = newTrimStart;
    trimEndRef.current = newTrimEnd;
    prevTrimStartRef.current = newTrimStart;
    prevTrimEndRef.current = newTrimEnd;
    if (!clip || clip.type !== "video" || !durationSetRef.current) return;
    if (trimStartChanged && newTrimStart > 0) {
      trimSeekDoneRef.current = false;
      trimEndHandledRef.current = false;
    } else if (trimStartChanged && oldTrimStart > 0 && newTrimStart === 0) {
      trimSeekDoneRef.current = false;
      trimEndHandledRef.current = false;
      segmentOffsetRef.current = 0;
      lastPositionUpdate.current = 0;
    } else if (trimEndChanged) {
      trimEndHandledRef.current = false;
    }
  }, [activeIndex, clips]);

  useEffect(() => {
    if (!isPlaying) {
      trimEndHandledRef.current = false;
      trimGenerationRef.current += 1;
    }
  }, [isPlaying]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const currentPlayingClipUriRef = useRef<string | null>(null);
  useEffect(() => {
    const clip = clips[activeIndex];
    if (!clip || clip.type !== "video") return;
    if (currentPlayingClipUriRef.current === clip.uri) return;
    currentPlayingClipUriRef.current = clip.uri;
    pendingSeekRef.current = clip.trimStartMs ?? 0;
    durationSetRef.current = false;
    lastPositionUpdate.current = 0;
  }, [activeIndex, clips]);

  const selectedClipIdxRef = useRef<number>(-1);
  useEffect(() => {
    selectedClipIdxRef.current = clips.findIndex((c) => c.id === selectedClipId);
  }, [clips, selectedClipId]);

  useEffect(() => {
    if (!selectedClipId) return;
    const idx = clips.findIndex((c) => c.id === selectedClipId);
    if (idx < 0 || idx === activeIndexRef.current) return;
    let cumulative = 0;
    for (let i = 0; i < idx; i++) {
      const c = clips[i]!;
      cumulative += effectiveDurationMs(c);
    }
    segmentOffsetRef.current = cumulative;
    durationSetRef.current = false;
    lastPositionUpdate.current = 0;
    pendingSeekRef.current = clips[idx]?.trimStartMs ?? 0;
    setActiveIndex(idx);
    setIsPlaying(true);
  }, [selectedClipId, clips]);

  const totalDurationMs = useMemo(() => {
    let total = 0;
    for (const c of clips) {
      total += effectiveDurationMs(c);
    }
    return total;
  }, [clips]);

  const activeClip: DraftClip | undefined = clips[activeIndex];
  const isVideo = activeClip?.type === "video";
  const displayPosition = isVideo ? Math.min(positionMs, totalDurationMs) : 0;

  const videoSource = useMemo(
    () => (activeClip?.uri ? { uri: activeClip.uri } : undefined),
    [activeClip?.uri],
  );

  const canSplit = useMemo(() => {
    if (!selectedClipId) return false;
    const idx = clips.findIndex((c) => c.id === selectedClipId);
    if (idx < 0) return false;
    const clip = clips[idx]!;
    if (clip.type !== "video") return false;
    let clipTimelineStart = 0;
    for (let i = 0; i < idx; i++) {
      clipTimelineStart += effectiveDurationMs(clips[i]!);
    }
    const effDur = effectiveDurationMs(clip);
    const clipTimelineEnd = clipTimelineStart + effDur;
    if (positionMs <= clipTimelineStart + 1 || positionMs >= clipTimelineEnd - 1) {
      return false;
    }
    const effectiveOffset = positionMs - clipTimelineStart;
    const trimStart = clip.trimStartMs ?? 0;
    const trimEnd = clip.trimEndMs ?? clip.durationMs ?? 0;
    const sourceSplit = trimStart + effectiveOffset;
    return (
      sourceSplit - trimStart >= MIN_SPLIT_EDGE_MS &&
      trimEnd - sourceSplit >= MIN_SPLIT_EDGE_MS
    );
  }, [selectedClipId, clips, positionMs]);

  const isTrimmed =
    (activeClip?.trimStartMs ?? 0) > 0 ||
    (activeClip?.trimEndMs ?? 0) < (activeClip?.durationMs ?? Infinity);

  const isIsolatedRef = useRef(false);
  useEffect(() => {
    isIsolatedRef.current = selectedClipId !== null;
  }, [selectedClipId]);

  // ── Playback status handler ───────────────────────────────────────────────
  const onVideoStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    const sourceDur =
      typeof status.durationMillis === "number" ? status.durationMillis : 0;
    const posMillis = status.positionMillis ?? 0;

    // Persist the real video duration to the clip so the timeline
    // shows correct widths instead of the minimum fallback (~450 ms).
    if (sourceDur > 0) {
      const idx = activeIndexRef.current;
      const currentClips = clipsRef.current;
      const clip = currentClips[idx];
      if (
        clip &&
        clip.type === "video" &&
        (clip.durationMs === undefined ||
          clip.durationMs === 0 ||
          Math.abs(clip.durationMs - sourceDur) > 100)
      ) {
        const updated = [...currentClips];
        updated[idx] = {
          ...clip,
          durationMs: sourceDur,
          trimEndMs: clip.trimEndMs !== undefined && clip.trimEndMs > 0
            ? clip.trimEndMs
            : sourceDur,
        };
        setClips(updated);
      }
    }

    if (!durationSetRef.current && sourceDur > 0) {
      durationSetRef.current = true;
      if (pendingSeekRef.current !== null) {
        const sp = pendingSeekRef.current;
        pendingSeekRef.current = null;
        trimSeekDoneRef.current = true;
        videoRef.current?.setPositionAsync(sp).catch(() => {});
        return;
      }
    }

    if (sourceDur > 0) {
      const tStart = trimStartRef.current;
      const tEnd = trimEndRef.current;
      if (!trimSeekDoneRef.current && tStart > 0) {
        trimSeekDoneRef.current = true;
        if (!safeSeekActiveRef.current) {
          safeSeekActiveRef.current = true;
          videoRef.current
            ?.setPositionAsync(tStart)
            .then(() => { safeSeekActiveRef.current = false; })
            .catch(() => { safeSeekActiveRef.current = false; });
        }
        return;
      }
      if (!safeSeekActiveRef.current && trimSeekDoneRef.current && tStart > 0 && posMillis < tStart - 100) {
        safeSeekActiveRef.current = true;
        videoRef.current
          ?.setPositionAsync(tStart)
          .then(() => { safeSeekActiveRef.current = false; })
          .catch(() => { safeSeekActiveRef.current = false; });
        return;
      }
      if (!safeSeekActiveRef.current && trimSeekDoneRef.current && tEnd > 0 && tEnd < sourceDur && posMillis > tEnd + 150) {
        safeSeekActiveRef.current = true;
        trimEndHandledRef.current = true;
        const gen = trimGenerationRef.current;
        videoRef.current?.setIsMutedAsync(true);
        videoRef.current
          ?.setPositionAsync(tStart)
          .then(() => {
            safeSeekActiveRef.current = false;
            trimEndHandledRef.current = false;
            if (trimGenerationRef.current !== gen) {
              videoRef.current?.setIsMutedAsync(false).catch(() => {});
              return;
            }
            videoRef.current?.setIsMutedAsync(false);
          })
          .catch(() => {
            safeSeekActiveRef.current = false;
            trimEndHandledRef.current = false;
            videoRef.current?.setIsMutedAsync(false);
          });
        return;
      }
    }

    const clipPos = posMillis - trimStartRef.current;
    const pos = segmentOffsetRef.current + Math.max(0, clipPos);
    const now = Date.now();
    if (now - lastPositionUpdate.current >= 200) {
      lastPositionUpdate.current = now;
      setPositionMs(pos);
    }

    const trimEnd = trimEndRef.current;
    if (
      !status.didJustFinish &&
      !trimEndHandledRef.current &&
      sourceDur > 0 &&
      trimEnd > 0 &&
      trimEnd < sourceDur &&
      status.positionMillis >= trimEnd
    ) {
      trimEndHandledRef.current = true;
      if (isIsolatedRef.current) {
        const gen = trimGenerationRef.current;
        videoRef.current?.setIsMutedAsync(true);
        videoRef.current
          ?.setPositionAsync(trimStartRef.current)
          .then(() => {
            trimEndHandledRef.current = false;
            if (trimGenerationRef.current !== gen) {
              videoRef.current?.setIsMutedAsync(false).catch(() => {});
              return;
            }
            videoRef.current?.setIsMutedAsync(false);
          })
          .catch(() => {
            trimEndHandledRef.current = false;
            videoRef.current?.setIsMutedAsync(false);
          });
      } else if (clipsRef.current.length === 1) {
        const gen = trimGenerationRef.current;
        videoRef.current?.setIsMutedAsync(true);
        videoRef.current
          ?.setPositionAsync(trimStartRef.current)
          .then(() => {
            trimEndHandledRef.current = false;
            if (trimGenerationRef.current !== gen) {
              videoRef.current?.setIsMutedAsync(false).catch(() => {});
              return;
            }
            videoRef.current?.setIsMutedAsync(false);
          })
          .catch(() => {
            trimEndHandledRef.current = false;
            videoRef.current?.setIsMutedAsync(false);
          });
      } else {
        advanceToNextClip();
      }
      return;
    }

    if (
      sourceDur > 0 &&
      posMillis >= sourceDur - 60 &&
      trimEndRef.current >= sourceDur - 50
    ) {
      advanceToNextClip();
      return;
    }

    // Auto-loop: when the player fires didJustFinish (end of file reached),
    // restart playback instead of letting the video stop at the last frame.
    if (status.didJustFinish) {
      const tStart = trimStartRef.current;
      if (isIsolatedRef.current) {
        // Isolated mode: loop the selected clip
        videoRef.current
          ?.setPositionAsync(tStart)
          .then(() => {
            videoRef.current?.playAsync().catch(() => {});
          })
          .catch(() => {});
      } else {
        // Multi-clip or single: advance loops automatically
        advanceToNextClip();
      }
      return;
    }
  }, []);

  const advanceToNextClip = useCallback(() => {
    const selIdx = selectedClipIdxRef.current;
    if (isIsolatedRef.current && selIdx >= 0 && selIdx < clipsRef.current.length && selIdx === activeIndexRef.current) {
      // Auto-loop: restart the selected clip instead of stopping
      setIsPlaying(true);
      const clip = clipsRef.current[selIdx];
      const tStart = clip?.trimStartMs ?? 0;
      videoRef.current
        ?.setPositionAsync(tStart)
        .then(() => {
          videoRef.current?.playAsync().catch(() => {});
        })
        .catch(() => {});
      setPositionMs(segmentOffsetRef.current);
      return;
    }

    const currentClips = clipsRef.current;
    const currentIdx = activeIndexRef.current;
    const c = currentClips[currentIdx];
    const dur = c ? effectiveDurationMs(c) : 0;
    segmentOffsetRef.current += Math.max(0, dur);

    if (currentIdx < currentClips.length - 1) {
      const nextIdx = currentIdx + 1;
      const nextClip = currentClips[nextIdx];
      const sameUri =
        currentPlayingClipUriRef.current === (nextClip?.uri ?? null);

      trimStartRef.current = nextClip?.trimStartMs ?? 0;
      trimEndRef.current = nextClip?.trimEndMs ?? (nextClip?.durationMs ?? 0);
      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      trimEndHandledRef.current = false;
      trimGenerationRef.current += 1;

      if (sameUri) {
        currentPlayingClipUriRef.current = nextClip?.uri ?? null;
        pendingSeekRef.current = null;
        lastPositionUpdate.current = 0;
        const leavingTrimEnd = c?.trimEndMs ?? (c?.durationMs ?? 0);
        const arrivingTrimStart = nextClip?.trimStartMs ?? 0;
        if (arrivingTrimStart > leavingTrimEnd) {
          trimSeekDoneRef.current = true;
          safeSeekActiveRef.current = true;
          videoRef.current
            ?.setPositionAsync(arrivingTrimStart)
            .then(() => { safeSeekActiveRef.current = false; })
            .catch(() => { safeSeekActiveRef.current = false; });
        } else {
          trimSeekDoneRef.current = true;
        }
      } else {
        trimSeekDoneRef.current = false;
      }

      activeIndexRef.current = nextIdx;
      setActiveIndex(nextIdx);
      setPositionMs(segmentOffsetRef.current);
      setIsPlaying(true);
    } else {
      const firstClip = currentClips[0];
      const sameUri =
        currentPlayingClipUriRef.current === (firstClip?.uri ?? null);
      const seekTarget = firstClip?.trimStartMs ?? 0;

      trimStartRef.current = firstClip?.trimStartMs ?? 0;
      trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      segmentOffsetRef.current = 0;
      trimEndHandledRef.current = false;
      trimGenerationRef.current += 1;

      if (sameUri) {
        currentPlayingClipUriRef.current = firstClip?.uri ?? null;
        pendingSeekRef.current = null;
        lastPositionUpdate.current = 0;
        trimSeekDoneRef.current = true;
        videoRef.current
          ?.setPositionAsync(seekTarget)
          .then(() => {
            videoRef.current?.playAsync().catch(() => {});
          })
          .catch(() => {});
      } else {
        trimSeekDoneRef.current = false;
      }

      activeIndexRef.current = 0;
      setActiveIndex(0);
      setPositionMs(0);
      setIsPlaying(true);
    }
  }, []);

  // ── Seek ──────────────────────────────────────────────────────────────────
  const handleSeek = useCallback((targetMs: number) => {
    const currentClips = clipsRef.current;
    let cumulative = 0;
    let targetIdx = 0;
    let clipStart = 0;

    for (let i = 0; i < currentClips.length; i++) {
      const dur = effectiveDurationMs(currentClips[i]!);
      if (targetMs >= cumulative - 0.5 && targetMs < cumulative + dur + 0.5) {
        targetIdx = i;
        clipStart = cumulative;
        break;
      }
      if (i === currentClips.length - 1 && targetMs >= cumulative) {
        targetIdx = i;
        clipStart = cumulative;
      }
      cumulative += dur;
    }

    if (selectedClipId !== null) {
      const selIdx = currentClips.findIndex((c) => c.id === selectedClipId);
      if (selIdx !== targetIdx) {
        selectedClipIdxRef.current = -1;
        isIsolatedRef.current = false;
        setSelectedClipId(null);
      }
    }

    const posInEffectiveClip = targetMs - clipStart;
    const trimStart = currentClips[targetIdx]?.trimStartMs ?? 0;
    const sourcePos = posInEffectiveClip + trimStart;

    segmentOffsetRef.current = clipStart;
    durationSetRef.current = false;
    lastPositionUpdate.current = 0;
    trimEndHandledRef.current = false;

    if (targetIdx !== activeIndexRef.current) {
      currentPlayingClipUriRef.current = currentClips[targetIdx]!.uri;
      pendingSeekRef.current = sourcePos;
      activeIndexRef.current = targetIdx;
      trimStartRef.current = trimStart;
      trimEndRef.current = currentClips[targetIdx]?.trimEndMs ?? (currentClips[targetIdx]?.durationMs ?? 0);
      prevTrimStartRef.current = trimStart;
      prevTrimEndRef.current = trimEndRef.current;
      trimEndHandledRef.current = false;
      trimSeekDoneRef.current = false;
      trimGenerationRef.current += 1;
      setActiveIndex(targetIdx);
      setIsPlaying(false);
      setPositionMs(targetMs);
    } else {
      videoRef.current?.setPositionAsync(sourcePos).catch(() => {});
      setIsPlaying(false);
      setPositionMs(targetMs);
    }
  }, []);

  const togglePlay = useCallback(() => {
    if (!activeClip) return;
    if (!isPlaying) {
      if (selectedClipId !== null && selectedClipId === activeClip.id && isTrimmed) {
        handleSeek(segmentOffsetRef.current);
        setTimeout(() => setIsPlaying(true), 60);
        return;
      }
      if (displayPosition >= totalDurationMs - 120) {
        handleSeek(0);
        setTimeout(() => setIsPlaying(true), 60);
        return;
      }
    }
    setIsPlaying((p) => !p);
  }, [activeClip, isPlaying, selectedClipId, isTrimmed, displayPosition, totalDurationMs, handleSeek]);

  // ── Clip operations ───────────────────────────────────────────────────────
  const handleClipUpdate = useCallback(
    (clipId: string, updates: Partial<DraftClip>) => {
      if (selectedClipId && trimNeedsSnapshotRef.current) {
        trimNeedsSnapshotRef.current = false;
        pushSnapshot(clips, textOverlays);
      }
      setClips((prev) => {
        const next = prev.map((c) =>
          c.id === clipId ? { ...c, ...updates } : c,
        );
        clipsRef.current = next;
        return next;
      });
    },
    [selectedClipId, clips, textOverlays, pushSnapshot],
  );

  const handleSelectClip = useCallback((clipId: string) => {
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    const nextId = clipId === selectedClipId ? null : clipId;
    const idx = nextId ? clips.findIndex((c) => c.id === nextId) : -1;
    selectedClipIdxRef.current = idx;
    isIsolatedRef.current = nextId !== null;
    setSelectedClipId(nextId);
    setSelectedOverlayId(null);
    if (clipId !== selectedClipId) {
      trimNeedsSnapshotRef.current = true;
    }
  }, [selectedClipId, clips]);

  const handleTrim = useCallback(() => {
    if (!selectedClipId) {
      const target = clips[activeIndex];
      if (target) {
        setSelectedClipId(target.id);
        trimNeedsSnapshotRef.current = true;
      }
      triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
      return;
    }
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
  }, [selectedClipId, clips, activeIndex]);

  const handleDeselectAndPreview = useCallback(
    (positionMs?: number) => {
      selectedClipIdxRef.current = -1;
      isIsolatedRef.current = false;
      setSelectedClipId(null);
      trimEndHandledRef.current = false;
      if (positionMs !== undefined) {
        handleSeek(positionMs);
        setTimeout(() => setIsPlaying(true), 66);
      } else if (!isPlaying) {
        setIsPlaying(true);
      }
    },
    [isPlaying, handleSeek],
  );

  const handleTrimRelease = useCallback(() => {
    if (!selectedClipId) return;
    const idx = clips.findIndex((c) => c.id === selectedClipId);
    if (idx < 0) return;
    trimNeedsSnapshotRef.current = true;
    if (!isPlaying) {
      handleSeek(segmentOffsetRef.current);
      setTimeout(() => setIsPlaying(true), 66);
    }
  }, [selectedClipId, clips, handleSeek, isPlaying]);

  const handleSplitClip = useCallback(() => {
    if (!canSplit || !selectedClipId) return;
    pushSnapshot(clips, textOverlays);
    const idx = clips.findIndex((c) => c.id === selectedClipId);
    if (idx < 0) return;
    const clip = clips[idx]!;
    if (clip.type !== "video") return;

    let clipTimelineStart = 0;
    for (let i = 0; i < idx; i++) {
      clipTimelineStart += effectiveDurationMs(clips[i]!);
    }

    const effectiveOffset = positionMs - clipTimelineStart;
    const trimStart = clip.trimStartMs ?? 0;
    const trimEnd = clip.trimEndMs ?? clip.durationMs ?? 0;
    const sourceSplit = trimStart + effectiveOffset;

    triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);

    const clipA: DraftClip = {
      ...clip,
      id: newClipId(),
      trimStartMs: trimStart,
      trimEndMs: sourceSplit,
    };
    const clipB: DraftClip = {
      ...clip,
      id: newClipId(),
      trimStartMs: sourceSplit,
      trimEndMs: trimEnd,
    };

    const newClips = [
      ...clips.slice(0, idx),
      clipA,
      clipB,
      ...clips.slice(idx + 1),
    ];

    setClips(newClips);
    setSelectedClipId(null);
    clipsRef.current = newClips;
    selectedClipIdxRef.current = -1;
    isIsolatedRef.current = false;
    safeSeekActiveRef.current = false;

    const oldActive = activeIndexRef.current;

    if (oldActive === idx) {
      const playheadInClip = positionMs - clipTimelineStart;
      const clipAEff = effectiveDurationMs(clipA);
      const inClipA = playheadInClip < clipAEff;

      if (inClipA) {
        trimStartRef.current = clipA.trimStartMs ?? 0;
        trimEndRef.current = clipA.trimEndMs ?? (clipA.durationMs ?? 0);
        segmentOffsetRef.current = clipTimelineStart;
        activeIndexRef.current = idx;
        setActiveIndex(idx);
      } else {
        trimStartRef.current = clipB.trimStartMs ?? 0;
        trimEndRef.current = clipB.trimEndMs ?? (clipB.durationMs ?? 0);
        segmentOffsetRef.current = clipTimelineStart + clipAEff;
        activeIndexRef.current = idx + 1;
        setActiveIndex(idx + 1);
      }

      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      trimEndHandledRef.current = inClipA;
      trimSeekDoneRef.current = true;
      durationSetRef.current = true;
      pendingSeekRef.current = null;
      lastPositionUpdate.current = 0;
      trimGenerationRef.current += 1;
      setPositionMs(positionMs);
    } else if (oldActive > idx) {
      activeIndexRef.current = oldActive + 1;
      setActiveIndex(oldActive + 1);
    }
  }, [canSplit, selectedClipId, clips, textOverlays, positionMs, pushSnapshot]);

  const handleReorderClips = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      pushSnapshot(clips, textOverlays);
      triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);

      const next = [...clips];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return;
      next.splice(toIndex, 0, moved);

      clipsRef.current = next;

      const oldActive = activeIndexRef.current;
      if (oldActive === fromIndex) {
        activeIndexRef.current = toIndex;
      } else if (fromIndex < oldActive && toIndex >= oldActive) {
        activeIndexRef.current = oldActive - 1;
      } else if (fromIndex > oldActive && toIndex <= oldActive) {
        activeIndexRef.current = oldActive + 1;
      }

      const selIdx = selectedClipIdxRef.current;
      if (selIdx === fromIndex) {
        selectedClipIdxRef.current = toIndex;
      } else if (fromIndex < selIdx && toIndex >= selIdx) {
        selectedClipIdxRef.current = selIdx - 1;
      } else if (fromIndex > selIdx && toIndex <= selIdx) {
        selectedClipIdxRef.current = selIdx + 1;
      }

      let cumulative = 0;
      const newActiveIdx = activeIndexRef.current;
      for (let i = 0; i < newActiveIdx; i++) {
        cumulative += effectiveDurationMs(next[i]!);
      }
      segmentOffsetRef.current = cumulative;

      const newActiveClip = next[newActiveIdx];
      trimStartRef.current = newActiveClip?.trimStartMs ?? 0;
      trimEndRef.current = newActiveClip?.trimEndMs ?? (newActiveClip?.durationMs ?? 0);
      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      trimEndHandledRef.current = false;
      trimGenerationRef.current += 1;

      if (newActiveClip) {
        currentPlayingClipUriRef.current = newActiveClip.uri;
      }

      safeSeekActiveRef.current = false;
      setActiveIndex(newActiveIdx);
      setClips(next);
    },
    [clips, textOverlays, pushSnapshot],
  );

  const handleDeleteClip = useCallback(() => {
    if (!selectedClipId) return;
    pushSnapshot(clips, textOverlays);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
    const next = clips.filter((c) => c.id !== selectedClipId);
    if (next.length === 0) {
      router.back();
      return;
    }

    clipsRef.current = next;
    activeIndexRef.current = 0;
    selectedClipIdxRef.current = -1;
    isIsolatedRef.current = false;
    const firstClip = next[0];
    trimStartRef.current = firstClip?.trimStartMs ?? 0;
    trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
    prevTrimStartRef.current = trimStartRef.current;
    prevTrimEndRef.current = trimEndRef.current;
    trimEndHandledRef.current = false;
    trimGenerationRef.current += 1;
    trimSeekDoneRef.current = false;
    segmentOffsetRef.current = 0;
    lastPositionUpdate.current = 0;
    durationSetRef.current = false;
    pendingSeekRef.current = firstClip?.trimStartMs ?? 0;
    currentPlayingClipUriRef.current = firstClip?.uri ?? null;
    safeSeekActiveRef.current = false;

    setClips(next);
    setSelectedClipId(null);
    setActiveIndex(0);
    setIsPlaying(true);
  }, [selectedClipId, clips, textOverlays, router, pushSnapshot]);

  // ── Text overlay operations ───────────────────────────────────────────────

  const handleTapTextTool = useCallback(() => {
    if (selectedOverlayId) {
      setEditingOverlayId(selectedOverlayId);
    } else {
      setEditingOverlayId(null);
    }
    setTextEditorVisible(true);
  }, [selectedOverlayId]);

  const handleTextEditorDone = useCallback(
    (text: string, backgroundStyle: TextBackgroundStyle) => {
      setTextEditorVisible(false);
      pushSnapshot(clips, textOverlays);

      if (editingOverlayId) {
        setTextOverlays((prev) =>
          prev.map((ov) =>
            ov.id === editingOverlayId
              ? { ...ov, text, backgroundStyle }
              : ov,
          ),
        );
        setEditingOverlayId(null);
      } else {
        const newOv: TextOverlay = {
          id: newOverlayId(),
          text,
          x: 0.5,
          y: 0.5,
          fontSize: 26,
          rotation: 0,
          color: "#FFFFFF",
          backgroundStyle,
        };
        setTextOverlays((prev) => [...prev, newOv]);
        setSelectedOverlayId(newOv.id);
        setEditingOverlayId(null);
      }
      triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    },
    [editingOverlayId, clips, textOverlays, pushSnapshot],
  );

  const handleTextEditorCancel = useCallback(() => {
    setTextEditorVisible(false);
    setEditingOverlayId(null);
  }, []);

  const handleSelectOverlay = useCallback(
    (overlayId: string) => {
      triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
      if (selectedOverlayId === overlayId) {
        setEditingOverlayId(overlayId);
        setTextEditorVisible(true);
      } else {
        setSelectedOverlayId(overlayId);
        setSelectedClipId(null);
      }
    },
    [selectedOverlayId],
  );

  const handleOverlayUpdate = useCallback(
    (id: string, patch: Partial<TextOverlay>) => {
      setTextOverlays((prev) =>
        prev.map((ov) => (ov.id === id ? { ...ov, ...patch } : ov)),
      );
    },
    [],
  );

  const handleDeleteOverlay = useCallback((overlayId?: string) => {
    const id = overlayId ?? selectedOverlayId;
    if (!id) return;
    pushSnapshot(clips, textOverlays);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
    setTextOverlays((prev) =>
      prev.filter((ov) => ov.id !== id),
    );
    if (id === selectedOverlayId) setSelectedOverlayId(null);
    setDragOverlayInfo(null);
  }, [selectedOverlayId, clips, textOverlays, pushSnapshot]);

  const handleCycleBackgroundStyle = useCallback(
    (id: string) => {
      pushSnapshot(clips, textOverlays);
      triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
      setTextOverlays((prev) =>
        prev.map((ov) => {
          if (ov.id !== id) return ov;
          const idx = BG_STYLES.indexOf(
            ov.backgroundStyle ?? "none-white",
          );
          const next = BG_STYLES[(idx + 1) % BG_STYLES.length]!;
          return { ...ov, backgroundStyle: next };
        }),
      );
    },
    [clips, textOverlays, pushSnapshot],
  );

  const handleDuplicateOverlay = useCallback(() => {
    if (!selectedOverlayId) return;
    const ov = textOverlays.find((o) => o.id === selectedOverlayId);
    if (!ov) return;
    pushSnapshot(clips, textOverlays);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    const newOv: TextOverlay = {
      ...ov,
      id: newOverlayId(),
      x: clampNormalised(ov.x + 0.04, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN),
      y: clampNormalised(ov.y + 0.04, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN),
    };
    setTextOverlays((prev) => [...prev, newOv]);
    setSelectedOverlayId(newOv.id);
  }, [selectedOverlayId, clips, textOverlays, pushSnapshot]);

  const handleDragState = useCallback(
    (id: string, isDragging: boolean, centerX: number, centerY: number) => {
      if (isDragging) {
        setDragOverlayInfo({ id, isDragging, centerX, centerY });
      } else {
        if (dragOverlayInfo && dragOverlayInfo.centerY > 0.88) {
          handleDeleteOverlay(id);
        } else {
          setDragOverlayInfo(null);
        }
      }
    },
    [dragOverlayInfo, handleDeleteOverlay],
  );

  const handleTextOverlayEditStart = useCallback(
    (_id: string) => {
      if (textEditSnapshotTakenRef.current) return;
      textEditSnapshotTakenRef.current = true;
      pushSnapshot(clips, textOverlays);
    },
    [clips, textOverlays, pushSnapshot],
  );

  // ── Undo / Redo handlers ─────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    const snapshot = undo();
    if (!snapshot) return;
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    pushRedo(clipsForUndoRef.current, textOverlaysForUndoRef.current);

    clipsRef.current = snapshot.clips;
    activeIndexRef.current = 0;
    selectedClipIdxRef.current = -1;
    isIsolatedRef.current = false;
    const firstClip = snapshot.clips[0];
    trimStartRef.current = firstClip?.trimStartMs ?? 0;
    trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
    prevTrimStartRef.current = trimStartRef.current;
    prevTrimEndRef.current = trimEndRef.current;
    trimEndHandledRef.current = false;
    trimGenerationRef.current += 1;
    trimSeekDoneRef.current = false;
    segmentOffsetRef.current = 0;
    lastPositionUpdate.current = 0;
    durationSetRef.current = false;
    pendingSeekRef.current = firstClip?.trimStartMs ?? 0;
    currentPlayingClipUriRef.current = firstClip?.uri ?? null;
    safeSeekActiveRef.current = false;

    setClips(snapshot.clips);
    setTextOverlays(snapshot.textOverlays);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setActiveIndex(0);
    setPositionMs(0);
    setIsPlaying(true);
    trimNeedsSnapshotRef.current = false;
    textEditSnapshotTakenRef.current = false;
  }, [undo, pushRedo]);

  const handleRedo = useCallback(() => {
    const snapshot = redo();
    if (!snapshot) return;
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    pushSnapshot(clipsForUndoRef.current, textOverlaysForUndoRef.current);

    clipsRef.current = snapshot.clips;
    activeIndexRef.current = 0;
    selectedClipIdxRef.current = -1;
    isIsolatedRef.current = false;
    const firstClip = snapshot.clips[0];
    trimStartRef.current = firstClip?.trimStartMs ?? 0;
    trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
    prevTrimStartRef.current = trimStartRef.current;
    prevTrimEndRef.current = trimEndRef.current;
    trimEndHandledRef.current = false;
    trimGenerationRef.current += 1;
    trimSeekDoneRef.current = false;
    segmentOffsetRef.current = 0;
    lastPositionUpdate.current = 0;
    durationSetRef.current = false;
    pendingSeekRef.current = firstClip?.trimStartMs ?? 0;
    currentPlayingClipUriRef.current = firstClip?.uri ?? null;
    safeSeekActiveRef.current = false;

    setClips(snapshot.clips);
    setTextOverlays(snapshot.textOverlays);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setActiveIndex(0);
    setPositionMs(0);
    setIsPlaying(true);
    trimNeedsSnapshotRef.current = false;
    textEditSnapshotTakenRef.current = false;
  }, [redo, pushSnapshot]);

  // ── Cover thumbnail flow ──────────────────────────────────────────────────

  const primaryVideoUri = useMemo(() => {
    if (clips.length === 0) return null;
    if (selectedClipId) {
      const clip = clips.find((c) => c.id === selectedClipId);
      if (clip && clip.type === "video") return clip.uri;
    }
    return clips[0]?.type === "video" ? clips[0].uri : (clips.find((c) => c.type === "video")?.uri ?? null);
  }, [clips, selectedClipId]);

  const handleSaveDraftPress = useCallback(() => {
    if (clips.length === 0) return;
    if (primaryVideoUri) {
      coverState.pendingAction = "save-draft";
      coverState.resultThumbnailUri = null;
      coverState.resultThumbnailMs = 0;
      router.push({
        pathname: "/cover-picker",
        params: {
          videoUri: primaryVideoUri,
          totalDurationMs: String(totalDurationMs),
          mode: "save-draft",
        },
      });
    } else {
      setError(null);
      setSuccess(null);
      executeSaveDraftRef.current(null, 0).catch((e: any) => {
        setError(e instanceof Error ? e.message : "Could not save draft.");
      });
    }
  }, [clips, primaryVideoUri, totalDurationMs, router]);

  const handlePostPress = useCallback(() => {
    if (clips.length === 0) return;

    if (primaryVideoUri) {
      coverState.pendingAction = "publish";
      coverState.resultThumbnailUri = null;
      coverState.resultThumbnailMs = 0;
      router.push({
        pathname: "/cover-picker",
        params: {
          videoUri: primaryVideoUri,
          totalDurationMs: String(totalDurationMs),
          mode: "publish",
        },
      });
    } else {
      setError(null);
      setSuccess(null);
      executePostRef.current(null).catch((e: any) => {
        setError(e instanceof Error ? e.message : "Could not post your drop.");
      });
    }
  }, [clips, primaryVideoUri, totalDurationMs, router]);

  useFocusEffect(
    useCallback(() => {
      const action = coverState.pendingAction;
      const uri = coverState.resultThumbnailUri;
      const ms = coverState.resultThumbnailMs;
      if (action && uri) {
        coverState.pendingAction = null;
        coverState.resultThumbnailUri = null;
        coverState.resultThumbnailMs = 0;
        if (action === "save-draft") {
          executeSaveDraftRef.current(uri, ms).catch(() => {});
        } else {
          executePostRef.current(uri).catch(() => {});
        }
      }
    }, []),
  );

  const executeSaveDraft = useCallback(async (thumbnailUri: string | null, thumbnailMs: number) => {
    if (clips.length === 0) return;
    setError(null);
    try {
      const draftIdFinal: string =
        draftId ??
        `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const draftDir = `${FileSystem.documentDirectory}drafts/${draftIdFinal}/`;
      await FileSystem.makeDirectoryAsync(draftDir, { intermediates: true });

      const permanentClips = await Promise.all(
        clips.map(async (c) => {
          const ext = c.uri.match(/\.(\w+)(?:\?|$)/)?.[1] ?? (c.type === "video" ? "mp4" : "jpg");
          const destUri = `${draftDir}${c.id}.${ext}`;
          if (c.uri !== destUri) {
            try {
              await FileSystem.copyAsync({ from: c.uri, to: destUri });
            } catch {
              return c;
            }
          }
          return { ...c, uri: destUri };
        }),
      );

      const project: DraftProject = {
        id: draftIdFinal,
        clips: permanentClips,
        caption: "",
        textOverlays,
        coverThumbnailUri: thumbnailUri ?? undefined,
        coverThumbnailMs: thumbnailUri ? thumbnailMs : undefined,
        createdAt: draftId
          ? (draftProjects.find((d) => d.id === draftId)?.createdAt ??
            Date.now())
          : Date.now(),
        updatedAt: Date.now(),
      };
      await saveDraftProject(project);
      setSuccess("Draft saved");
      setTimeout(() => {
        router.back();
        if (!draftId) {
          router.back();
        }
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save draft.");
    }
  }, [clips, draftId, draftProjects, textOverlays, saveDraftProject, router]);

  const executePost = useCallback(async (thumbnailUri: string | null) => {
    if (clips.length === 0) return;
    setError(null);
    setSuccess(null);
    try {
      const primary = clips[0]!;

      const segmentUris =
        clips.length > 1 ? clips.map((c) => c.uri) : undefined;

      const hasAnyTrim = clips.some(
        (c) =>
          (c.trimStartMs ?? 0) > 0 ||
          (c.trimEndMs ?? 0) < (c.durationMs ?? Infinity),
      );
      const trimData: Array<{ trimStartMs: number; trimEndMs: number }> | undefined =
        hasAnyTrim
          ? clips.map((c) => ({
              trimStartMs: c.trimStartMs ?? 0,
              trimEndMs: c.trimEndMs ?? (c.durationMs ?? 0),
            }))
          : undefined;
      const overlaysForPost = textOverlays.length > 0 ? textOverlays : undefined;
      await createPost.mutateAsync({
        uri: primary.uri,
        mediaType: primary.type,
        draftId: draftId ?? undefined,
        segmentUris,
        trimData,
        textOverlays: overlaysForPost,
        thumbnailUri: thumbnailUri ?? undefined,
      });
      if (draftId) {
        await deleteDraftProject(draftId);
      }
      setSuccess("Posted to tonight's drop");
      setTimeout(() => {
        router.back();
        router.back();
      }, 1200);
    } catch (e: any) {
      setError(e instanceof Error ? e.message : "Could not post your drop.");
    }
  }, [clips, draftId, textOverlays, createPost, deleteDraftProject, router]);

  useEffect(() => { executeSaveDraftRef.current = executeSaveDraft; }, [executeSaveDraft]);
  useEffect(() => { executePostRef.current = executePost; }, [executePost]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (draftId && !draftsLoaded) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={[styles.emptyText, { marginTop: 16 }]}>
          Loading draft…
        </Text>
      </View>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (clips.length === 0) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <Text style={styles.emptyText}>Nothing to preview</Text>
        <Pressable onPress={() => router.back()} style={styles.emptyBtn}>
          <Text style={styles.emptyBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isIsolated = selectedClipId !== null;
  const editingOverlay = editingOverlayId
    ? textOverlays.find((ov) => ov.id === editingOverlayId)
    : null;

  // ── RENDER — Full Production Editor ─────────────────────────────────────

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.screen}>
        <StatusBar style="light" />

        {/* ── Top bar ────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.topBtn}
          >
            <ArrowLeft size={20} color="#fff" strokeWidth={2.5} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>
            {draftId ? "Edit Draft" : "Edit Drop"}
          </Text>
          <View style={styles.topBtnRow}>
            <TouchableOpacity
              onPress={handleUndo}
              disabled={!canUndo}
              style={[styles.topBtn, !canUndo && styles.topBtnOff]}
            >
              <Undo2 size={16} color="#fff" strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleRedo}
              disabled={!canRedo}
              style={[styles.topBtn, !canRedo && styles.topBtnOff]}
            >
              <Redo2 size={16} color="#fff" strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Preview area ───────────────────────────────────────────── */}
        <Pressable
          style={styles.previewArea}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setPreviewAreaSize({ w: width, h: height });
          }}
          onPress={() => {
            if (selectedClipId) {
              handleDeselectAndPreview();
            }
          }}
        >
          <View
            style={[
              styles.previewFrame,
              { width: frameDims.w, height: frameDims.h },
            ]}
          >
            {/* Video or Image */}
            {isVideo && videoSource ? (
              <Video
                ref={videoRef}
                source={videoSource}
                style={{ width: "100%", height: "100%" }}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay={isPlaying}
                isLooping={false}
                isMuted={false}
                onPlaybackStatusUpdate={onVideoStatus}
                progressUpdateIntervalMillis={200}
                pointerEvents="none"
              />
            ) : activeClip?.uri ? (
              <Image
                source={{ uri: activeClip.uri }}
                style={{ width: "100%", height: "100%" }}
                contentFit="contain"
                pointerEvents="none"
              />
            ) : (
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>
                  No preview
                </Text>
              </View>
            )}

            {/* Play overlay */}
            {!isPlaying && (
              <Pressable onPress={togglePlay} style={styles.playOverlay}>
                <View style={styles.playCircle}>
                  <Play
                    size={26}
                    color="#fff"
                    fill="#fff"
                    style={{ left: 2 }}
                  />
                </View>
              </Pressable>
            )}

            {/* Draggable text overlays */}
            {textOverlays.map((ov) => (
              <DraggableTextOverlay
                key={ov.id}
                overlay={ov}
                frameWidth={frameDims.w}
                frameHeight={frameDims.h}
                isSelected={selectedOverlayId === ov.id}
                onSelect={handleSelectOverlay}
                onUpdate={handleOverlayUpdate}
                onDelete={() => handleDeleteOverlay(ov.id)}
                onDuplicate={handleDuplicateOverlay}
                onCycleBackgroundStyle={handleCycleBackgroundStyle}
                onEditStart={handleTextOverlayEditStart}
                onDragState={handleDragState}
              />
            ))}
          </View>
        </Pressable>

        {/* ── Timeline editor ────────────────────────────────────────── */}
        <TimelineEditor
          clips={clips}
          totalDurationMs={totalDurationMs}
          positionMs={displayPosition}
          activeClipIndex={activeIndex}
          selectedClipId={selectedClipId}
          onSeek={handleSeek}
          onSelectClip={handleSelectClip}
          onClipUpdate={handleClipUpdate}
          onTrimRelease={handleTrimRelease}
          onDeselectAndPreview={() => handleDeselectAndPreview()}
          onReorderClips={handleReorderClips}
        />

        {/* ── Toolbar ────────────────────────────────────────────────── */}
        <View style={styles.toolbar}>
          {/* Trim */}
          <Pressable
            onPress={handleTrim}
            style={[
              styles.toolBtn,
              selectedClipId && styles.toolBtnActive,
            ]}
          >
            <Scissors
              size={18}
              color={selectedClipId ? theme.accent : "rgba(255,255,255,0.85)"}
            />
            <Text
              style={[
                styles.toolLabel,
                selectedClipId && { color: theme.accent },
              ]}
            >
              Trim
            </Text>
          </Pressable>

          {/* Split */}
          <Pressable
            onPress={handleSplitClip}
            disabled={!canSplit}
            style={[styles.toolBtn, !canSplit && styles.toolBtnOff]}
          >
            <Split
              size={18}
              color={
                !canSplit ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.85)"
              }
            />
            <Text
              style={[
                styles.toolLabel,
                !canSplit && styles.toolLabelOff,
              ]}
            >
              Split
            </Text>
          </Pressable>

          {/* Text */}
          <Pressable
            onPress={handleTapTextTool}
            style={[
              styles.toolBtn,
              (selectedOverlayId || textEditorVisible) && styles.toolBtnActive,
            ]}
          >
            <Type
              size={18}
              color={
                selectedOverlayId || textEditorVisible
                  ? theme.accent
                  : "rgba(255,255,255,0.85)"
              }
            />
            <Text
              style={[
                styles.toolLabel,
                (selectedOverlayId || textEditorVisible) && {
                  color: theme.accent,
                },
              ]}
            >
              Text
            </Text>
          </Pressable>

          {/* Delete */}
          <Pressable
            onPress={handleDeleteClip}
            disabled={!selectedClipId}
            style={[styles.toolBtn, !selectedClipId && styles.toolBtnOff]}
          >
            <Trash2
              size={18}
              color={
                !selectedClipId
                  ? "rgba(255,255,255,0.25)"
                  : "rgba(255,255,255,0.85)"
              }
            />
            <Text
              style={[
                styles.toolLabel,
                !selectedClipId && styles.toolLabelOff,
              ]}
            >
              Delete
            </Text>
          </Pressable>
        </View>

        {/* ── Text overlay editing toolbar ──────────────────────────── */}
        {selectedOverlayId && (
          <View style={styles.textToolbarWrap}>
            <View style={styles.textActionRow}>
              <Pressable
                onPress={() => handleCycleBackgroundStyle(selectedOverlayId!)}
                style={styles.textActionBtn}
              >
                <RectangleEllipsis size={14} color="rgba(255,255,255,0.8)" />
                <Text style={styles.textActionLabel}>Style</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const ov = textOverlays.find(
                    (o) => o.id === selectedOverlayId,
                  );
                  setEditingOverlayId(selectedOverlayId);
                  setTextEditorVisible(true);
                }}
                style={styles.textActionBtn}
              >
                <Pencil size={14} color="rgba(255,255,255,0.8)" />
                <Text style={styles.textActionLabel}>Edit</Text>
              </Pressable>
              <Pressable
                onPress={handleDuplicateOverlay}
                style={styles.textActionBtn}
              >
                <Type size={14} color="rgba(255,255,255,0.8)" />
                <Text style={styles.textActionLabel}>Duplicate</Text>
              </Pressable>
              <Pressable
                onPress={() => handleDeleteOverlay()}
                style={[styles.textActionBtn, styles.textActionBtnDanger]}
              >
                <Trash2 size={14} color="#FF453A" />
                <Text
                  style={[
                    styles.textActionLabel,
                    styles.textActionLabelDanger,
                  ]}
                >
                  Delete
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ── Bottom section: Actions ─────────────────────────────── */}
        <View
          style={[
            styles.bottomSection,
            { paddingBottom: insets.bottom + 8 },
          ]}
        >
          {error && (
            <View style={styles.bannerError}>
              <Text style={styles.bannerErrorText}>{error}</Text>
            </View>
          )}
          {success && (
            <View style={styles.bannerSuccess}>
              <Text style={styles.bannerSuccessText}>{success}</Text>
            </View>
          )}
          <View style={styles.actionRow}>
            <Pressable
              onPress={handleSaveDraftPress}
              disabled={clips.length === 0}
              style={({ pressed }) => [
                styles.draftBtn,
                clips.length === 0 && { opacity: 0.35 },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.draftBtnText}>Save Draft</Text>
            </Pressable>
            <Pressable
              onPress={handlePostPress}
              disabled={clips.length === 0}
              style={({ pressed }) => [
                styles.postBtn,
                clips.length === 0 && { opacity: 0.35 },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={styles.postBtnText}>Post Drop</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Drag-to-trash zone ────────────────────────────────────── */}
        {dragOverlayInfo?.isDragging && (
          <View
            style={[
              styles.trashZone,
              dragOverlayInfo.centerY > 0.88 && styles.trashZoneActive,
            ]}
            pointerEvents="none"
          >
            <Trash2
              size={20}
              color={
                dragOverlayInfo.centerY > 0.88
                  ? "#FF453A"
                  : "rgba(255,255,255,0.4)"
              }
            />
            <Text
              style={[
                styles.trashLabel,
                dragOverlayInfo.centerY > 0.88 && styles.trashLabelActive,
              ]}
            >
              Drop to delete
            </Text>
          </View>
        )}
      </View>

      {/* ── Text overlay editor modal ─────────────────────────────── */}
      <TextOverlayEditor
        visible={textEditorVisible}
        initialText={
          editingOverlay
            ? editingOverlay.text
            : ""
        }
        initialBackgroundStyle={
          editingOverlay
            ? (editingOverlay.backgroundStyle ?? "none-white")
            : "none-white"
        }
        onDone={handleTextEditorDone}
        onCancel={handleTextEditorCancel}
      />
    </GestureHandlerRootView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#08080B" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: 32,
    backgroundColor: theme.bg,
  },
  emptyText: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: "600" as const,
  },
  emptyBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
  emptyBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" as const },

  // ── Top bar ──
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 6,
    backgroundColor: "#08080B",
  },
  topBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  topTitle: {
    flex: 1,
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textAlign: "center",
  },
  topBtnRow: {
    flexDirection: "row",
    gap: 8,
  },
  topBtnOff: {
    opacity: 0.25,
  },

  // ── Preview area ──
  previewArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  previewFrame: {
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0D0D12",
  },

  // ── Play overlay ──
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },

  // ── Toolbar ──
  toolbar: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 24,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  toolBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    minWidth: 60,
  },
  toolBtnActive: {
    backgroundColor: "rgba(10,132,255,0.1)",
  },
  toolBtnOff: {
    opacity: 0.3,
  },
  toolLabel: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
  },
  toolLabelOff: {
    color: "rgba(255,255,255,0.2)",
  },

  // ── Bottom section ──
  bottomSection: {
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.04)",
    backgroundColor: "#08080B",
  },
  bannerError: {
    backgroundColor: "rgba(255,69,58,0.12)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,69,58,0.25)",
  },
  bannerErrorText: {
    color: theme.danger,
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center",
  },
  bannerSuccess: {
    backgroundColor: "rgba(48,209,88,0.12)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(48,209,88,0.25)",
  },
  bannerSuccessText: {
    color: theme.success,
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center",
  },
  postBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  postBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  draftBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  draftBtnText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },

  // ── Text editing toolbar ──
  textToolbarWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  textActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  textActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)",
    justifyContent: "center",
  },
  textActionBtnDanger: {
    backgroundColor: "rgba(255,69,58,0.08)",
  },
  textActionLabel: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },
  textActionLabelDanger: {
    color: "#FF453A",
  },

  // ── Drag-to-trash zone ──
  trashZone: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
    zIndex: 300,
  },
  trashZoneActive: {
    backgroundColor: "rgba(255,69,58,0.15)",
    borderTopColor: "rgba(255,69,58,0.35)",
  },
  trashLabel: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 13,
    fontWeight: "700" as const,
  },
  trashLabelActive: {
    color: "#FF453A",
  },
});
