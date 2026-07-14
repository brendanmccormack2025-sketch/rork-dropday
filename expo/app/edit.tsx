import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  TouchableOpacity,
  View,
  Dimensions,
} from "react-native";
import UiText from "@/components/UiText";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Video, Audio, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { documentDirectory, getInfoAsync, makeDirectoryAsync, copyAsync } from "@/lib/fileSystemCompat";
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

import { getThumbnailAsync } from "expo-video-thumbnails";
import { showAlert } from "@/lib/showAlert";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import {
  usePosts,
  type Post,
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
/** Lead time (ms) before a clip's expected end to start preloading the next clip. */
const PRELOAD_LEAD_MS = 500;
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
  const { user, session } = useAuth();
  const { createPost, saveDraftProject, deleteDraftProject, draftProjects, draftsLoaded, addOptimisticPost, updateOptimisticProgress } =
    usePosts();
  const {
    clips: clipsJson,
    videoUrl: nativeVideoUrl,
    draftId,
    reactingTo,
    rootDropId,
  } = useLocalSearchParams<{
    clips: string;
    videoUrl?: string;
    draftId?: string;
    reactingTo?: string;
    rootDropId?: string;
  }>();

  // ── Debug: log what params the edit screen received ─────────────────────
  const _editMountT0 = useRef<number>(Date.now());
  useEffect(() => {
    _editMountT0.current = Date.now();
    console.log(`[edit] Screen mounted — t=${_editMountT0.current}`);
    console.log("  clipsJson length:", clipsJson?.length ?? 0);
    console.log("  clipsJson first 200 chars:", clipsJson?.slice(0, 200));
    console.log("  nativeVideoUrl:", nativeVideoUrl?.slice(0, 80));
    console.log("  draftId:", draftId);
    console.log("  reactingTo:", reactingTo?.slice(0, 12) ?? "(none)");
    console.log("  rootDropId:", rootDropId?.slice(0, 12) ?? "(none)");
    const _parseStart = Date.now();
    try {
      const _parsed = JSON.parse(clipsJson ?? "[]");
      console.log(`[edit] mount — JSON.parse took ${Date.now() - _parseStart}ms, ${_parsed.length} clips`);
    } catch {}
  }, []);

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
      if (draft) {
        console.log("[edit] Loading clips from draft:", draft.id, "—", draft.clips.length, "clip(s)");
        return draft.clips;
      }
    }
    if (nativeVideoUrl && !clipsJson) {
      console.log("[edit] Using nativeVideoUrl:", nativeVideoUrl.slice(0, 80));
      return [{ id: newClipId(), uri: nativeVideoUrl, type: "video" as const }];
    }
    try {
      const parsed = JSON.parse(clipsJson ?? "[]") as DraftClip[];
      console.log("[edit] Parsed", parsed.length, "clip(s) from clipsJson");
      parsed.forEach((c, i) => {
        console.log(`  clip[${i}]: id=${c.id}, uri=${c.uri?.slice(0, 60)}, type=${c.type}, durationMs=${c.durationMs}`);
      });
      return parsed.map((c) => ({
        ...c,
        trimStartMs: c.trimStartMs ?? 0,
        trimEndMs: c.trimEndMs ?? c.durationMs,
      }));
    } catch (e) {
      console.error("[edit] Failed to parse clipsJson:", e);
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
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [isMature, setIsMature] = useState<boolean>(false);

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
  // Dual-player preload: two Video instances swap roles so the next clip is
  // already loaded when the current one ends, avoiding a cold-load stall.
  const videoRefA = useRef<Video>(null);
  const videoRefB = useRef<Video>(null);
  const videoRef = useRef<Video | null>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const hotSwapRef = useRef<boolean>(false);
  useEffect(() => {
    activeSlotRef.current = activeSlot;
    videoRef.current = activeSlot === 0 ? videoRefA.current : videoRefB.current;
  }, [activeSlot]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [positionMs, setPositionMs] = useState<number>(0);
  const pendingSeekRef = useRef<number | null>(null);
  const segmentOffsetRef = useRef<number>(0);
  const activeIndexRef = useRef<number>(0);
  const durationSetRef = useRef<boolean>(false);
  const lastPositionUpdate = useRef<number>(0);
  const lastLoggedPosRef = useRef<number>(-9999);
  const clipsRef = useRef(clips);
  const safeSeekActiveRef = useRef<boolean>(false);

  // Stable ref for save-draft only (Post calls executePost directly — see
  // handlePostPress — to avoid the stale-ref race where executePostRef.current
  // lagged one render behind the latest `clips` closure after a trim edit.)
  const executeSaveDraftRef = useRef<() => Promise<void>>(async () => {});

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

  // ── Probe all clip durations on mount ─────────────────────────────────────
  // The timeline renders clip widths from effectiveDurationMs, which depends
  // on clip.durationMs. Camera clips arrive with durationMs=undefined, so the
  // timeline shows minimum-width placeholders until each clip plays and
  // onVideoStatus populates the duration. This probe loads metadata for every
  // clip up front so the timeline renders at correct width immediately.
  useEffect(() => {
    let cancelled = false;
    const clipsToProbe = clipsRef.current.filter(
      (c) => c.type === "video" && (c.durationMs === undefined || c.durationMs === 0),
    );
    if (clipsToProbe.length === 0) return;

    const _probeT0 = Date.now();
    console.log(`[edit] Duration probe START — ${clipsToProbe.length} clip(s) to probe — t=${Date.now() - _editMountT0.current}ms since mount`);

    // Use Audio.Sound.createAsync to load video metadata without rendering a
    // player. It returns AVPlaybackStatus with durationMillis, then we unload.
    // Audio is imported statically from expo-av (top of file) — a dynamic
    // import("expo-av") here caused a fetchThenEvalJs SyntaxError on Hermes.
    (async () => {
      try {
        const results = await Promise.all(
          clipsToProbe.map(async (clip) => {
            try {
              const _clipProbeStart = Date.now();
              console.log(`[edit] Duration probe — START clip ${clip.id.slice(-8)} — t=${Date.now() - _editMountT0.current}ms since mount`);
              const { sound, status } = await Audio.Sound.createAsync(
                { uri: clip.uri },
                { shouldPlay: false, isMuted: true },
              );
              const _createAsyncMs = Date.now() - _clipProbeStart;
              const dur = status.isLoaded && typeof status.durationMillis === "number"
                ? status.durationMillis
                : 0;
              await sound.unloadAsync();
              console.log(`[edit] Duration probe: clip ${clip.id.slice(-8)} → ${dur}ms — createAsync took ${_createAsyncMs}ms, unload took ${Date.now() - _clipProbeStart - _createAsyncMs}ms`);
              return { id: clip.id, durationMs: dur };
            } catch (e) {
              console.warn(`[edit] Duration probe failed for clip ${clip.id.slice(-8)}:`, (e as Error)?.message, `— took ${Date.now() - _editMountT0.current}ms since mount`);
              return { id: clip.id, durationMs: 0 };
            }
          }),
        );
        if (cancelled) return;
        const valid = results.filter((r) => r.durationMs > 0);
        console.log(`[edit] Duration probe COMPLETE — ${valid.length}/${results.length} clips got valid durations, took ${Date.now() - _probeT0}ms total — t=${Date.now() - _editMountT0.current}ms since mount`, { durations: results.map(r => ({ id: r.id.slice(-8), ms: r.durationMs })) });
        if (valid.length === 0) return;
        const _setClipsStart = Date.now();
        setClips((prev) => {
          let changed = false;
          const next = prev.map((c) => {
            const probed = valid.find((r) => r.id === c.id);
            if (!probed) return c;
            changed = true;
            return {
              ...c,
              durationMs: probed.durationMs,
              trimEndMs: c.trimEndMs !== undefined && c.trimEndMs > 0
                ? c.trimEndMs
                : probed.durationMs,
            };
          });
          console.log(`[edit] Duration probe — setClips took ${Date.now() - _setClipsStart}ms, changed=${changed}`);
          return changed ? next : prev;
        });
      } catch (e) {
        console.warn("[edit] Duration probe batch failed:", (e as Error)?.message);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount only — probe once for all initial clips

  const currentPlayingClipUriRef = useRef<string | null>(null);
  useEffect(() => {
    const clip = clips[activeIndex];
    if (!clip || clip.type !== "video") return;
    if (currentPlayingClipUriRef.current === clip.uri) return;
    currentPlayingClipUriRef.current = clip.uri;
    console.log("[edit] CLIP CHANGED → activeIndex:", activeIndex, "uri:", clip.uri?.slice(-30), "trimStart:", clip.trimStartMs ?? 0, "trimEnd:", clip.trimEndMs ?? clip.durationMs, "hotSwap:", hotSwapRef.current, "pendingSeek:", pendingSeekRef.current);
    if (hotSwapRef.current) return; // hot swap: next clip already loaded & ready
    pendingSeekRef.current = clip.trimStartMs ?? 0;
    durationSetRef.current = false;
    lastPositionUpdate.current = 0;
    setVideoReady(false);
    videoRetryCountRef.current = 0;
    preloadArmedRef.current = false;
    preloadReadyRef.current = false;
    setPreloadSource(undefined);
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

  const videoSource = useMemo(() => {
    const uri = activeClip?.uri;
    return uri ? { uri } : undefined;
  }, [activeClip?.uri, activeClip?.type]);

  // Log file size for debugging — but skip data: URIs (inline base64, always valid on web)
  useEffect(() => {
    const uri = activeClip?.uri;
    if (!uri) return;
    const slice = uri.slice(0, 60);
    console.log("[edit] videoSource — uri:", uri.slice(0, 80), "type:", activeClip?.type);

    // Data URIs (data:image/png;base64,...) contain inline data — they're always valid,
    // and expo-file-system can't stat them on web. Skip the disk check entirely.
    if (uri.startsWith("data:")) {
      console.log(`[edit] videoSource — inline data URI (skipping disk check): ${slice}`);
      return;
    }

    const _vSrcCheckStart = Date.now();
    getInfoAsync(uri).then((info) => {
      console.log(
        `[edit] videoSource — file on disk: exists=${info.exists}, size=${info.exists ? (info.size ?? 0) : 0} bytes, uri=${slice} — getInfoAsync took ${Date.now() - _vSrcCheckStart}ms`,
      );
      if (!info.exists) {
        console.error(`[edit] videoSource — FILE DOES NOT EXIST: ${uri.slice(0, 80)}`);
      } else if ((info.size ?? 0) === 0) {
        console.error(`[edit] videoSource — FILE IS EMPTY (0 bytes): ${uri.slice(0, 80)}`);
      }
    }).catch((e) => {
      console.error(`[edit] videoSource — could not stat file: ${slice}`, (e as Error)?.message ?? e);
    });
  }, [activeClip?.uri, activeClip?.type]);

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

  // ── Video error state ────────────────────────────────────────────────────
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);

  const maxVideoRetries = 2;
  const videoRetryCountRef = useRef<number>(0);
  const [videoKey, setVideoKey] = useState<number>(0);
  const [videoReady, setVideoReady] = useState<boolean>(false);

  // Preload slot state — the inactive Video loads the upcoming clip so the
  // swap at segment end is instant instead of a cold load.
  const [preloadSource, setPreloadSource] = useState<{ uri: string } | undefined>(undefined);
  const preloadArmedRef = useRef<boolean>(false);
  const preloadReadyRef = useRef<boolean>(false);
  const preloadExpectedUriRef = useRef<string | null>(null);

  // Reset playback state whenever the Video component remounts due to an edit
  // (videoKey bump or activeClip.uri change) — prevents auto-play stutter on load.
  const activeClipUri = activeClip?.uri ?? null;
  useEffect(() => {
    if (hotSwapRef.current) {
      console.log("[edit] RESET EFFECT SKIPPED — hotSwapRef=true", { uri: activeClipUri?.slice(-20), idx: activeIndexRef.current, isAdvancing: isAdvancingRef.current });
      return; // hot swap: keep playing, next clip is ready
    }
    console.log("[edit] RESET EFFECT → isPlaying=false, videoReady=false", { uri: activeClipUri?.slice(-20), idx: activeIndexRef.current, isAdvancing: isAdvancingRef.current, hotSwap: hotSwapRef.current });
    setIsPlaying(false);
    setVideoReady(false);
  }, [videoKey, activeClipUri]);

  // Clear the hot-swap guard after the reset effects above have run this commit.
  useEffect(() => {
    hotSwapRef.current = false;
  }, [activeSlot, activeIndex]);

  const handleVideoLoadError = useCallback((errorMsg: string) => {
    const isAssetError =
      errorMsg.includes("isPlayable") ||
      errorMsg.includes("AVAsset") ||
      errorMsg.includes("not supported");
    if (isAssetError && videoRetryCountRef.current < maxVideoRetries) {
      videoRetryCountRef.current += 1;
      console.log(
        `[edit] Video load error (attempt ${videoRetryCountRef.current}/${maxVideoRetries}): ${errorMsg} — retrying...`,
      );
      setVideoReady(false);
      setTimeout(() => {
        setVideoKey((k) => k + 1);
      }, 500);
      return;
    }
    console.error(
      `[edit] Video load failed after ${videoRetryCountRef.current} retries: ${errorMsg}`,
    );
    setVideoLoadError("Video failed to process, please try recording again.");
    setIsPlaying(false);
  }, []);

  // ── Playback status handler ───────────────────────────────────────────────
  const onVideoStatus = useCallback((status: AVPlaybackStatus) => {
    // Error variant has isLoaded=false and an optional error field.
    // Check this BEFORE the isLoaded guard so errors aren't silently swallowed.
    if (!status.isLoaded && "error" in status && status.error) {
      console.error("[edit] Video playback error:", status.error);
      handleVideoLoadError(status.error);
      return;
    }

    if (!status.isLoaded) return;

    const sourceDur =
      typeof status.durationMillis === "number" ? status.durationMillis : 0;
    const posMillis = status.positionMillis ?? 0;

    // Diagnostic: log play state — only when position changes or key events
    // (not every 200ms tick, which floods the buffer).
    const posChanged = Math.abs(posMillis - lastLoggedPosRef.current) > 50;
    const isKeyEvent = status.didJustFinish || !status.isLoaded;
    if (posChanged || isKeyEvent) {
      lastLoggedPosRef.current = posMillis;
      console.log("[edit] onVideoStatus", {
        slot: activeSlotRef.current,
        idx: activeIndexRef.current,
        statusIsPlaying: status.isPlaying,
        isPlayingState: isPlaying,
        videoReadyState: videoReady,
        posMs: posMillis,
        durMs: sourceDur,
        isAdvancing: isAdvancingRef.current,
        trimEndHandled: trimEndHandledRef.current,
        didJustFinish: status.didJustFinish,
        pendingSeek: pendingSeekRef.current,
      });
    }

    // Preload arming: when playback nears the clip's end, source the next clip
    // into the inactive slot so it's ready to swap in without a cold-load stall.
    if (
      status.isPlaying &&
      !preloadArmedRef.current &&
      sourceDur > 0 &&
      !isIsolatedRef.current &&
      clipsRef.current.length > 1
    ) {
      const endMs =
        trimEndRef.current > 0 && trimEndRef.current < sourceDur
          ? trimEndRef.current
          : sourceDur;
      if (posMillis >= endMs - PRELOAD_LEAD_MS) {
        const curIdx = activeIndexRef.current;
        const curClips = clipsRef.current;
        const nextIdx = curIdx < curClips.length - 1 ? curIdx + 1 : 0;
        const nextClip = curClips[nextIdx];
        if (
          nextClip &&
          nextClip.type === "video" &&
          nextClip.uri !== currentPlayingClipUriRef.current
        ) {
          preloadArmedRef.current = true;
          preloadReadyRef.current = false;
          preloadExpectedUriRef.current = nextClip.uri;
          setPreloadSource({ uri: nextClip.uri });
        }
      }
    }

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
      const tEndClamped = tEnd > 0 ? Math.min(tEnd, sourceDur > 0 ? sourceDur : tEnd) : (sourceDur > 0 ? sourceDur : 0);
      if (!safeSeekActiveRef.current && trimSeekDoneRef.current && tEndClamped > 0 && posMillis > tEndClamped + 150) {
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
    const effectiveTrimEnd = trimEnd > 0 && sourceDur > 0
      ? Math.min(trimEnd, sourceDur)
      : trimEnd > 0 ? trimEnd : sourceDur;
    if (
      !status.didJustFinish &&
      !trimEndHandledRef.current &&
      sourceDur > 0 &&
      effectiveTrimEnd > 0 &&
      status.positionMillis >= effectiveTrimEnd - 120
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
        console.log("[edit] END OF SEGMENT → advanceToNextClip (multi-clip, trimEnd reached)", {
          activeIdx: activeIndexRef.current,
          isAdvancing: isAdvancingRef.current,
          posMillis,
          effectiveTrimEnd,
        });
        advanceToNextClip();
      }
      return;
    }

    if (
      sourceDur > 0 &&
      posMillis >= sourceDur - 60 &&
      trimEndRef.current >= sourceDur - 50
    ) {
      console.log("[edit] END OF SEGMENT → advanceToNextClip (sourceDur reached)", {
        activeIdx: activeIndexRef.current,
        isAdvancing: isAdvancingRef.current,
        posMillis,
        sourceDur,
      });
      advanceToNextClip();
      return;
    }

    // Auto-loop: when the player fires didJustFinish (end of file reached),
    // restart playback instead of letting the video stop at the last frame.
    if (status.didJustFinish) {
      console.log("[edit] didJustFinish — isAdvancing:", isAdvancingRef.current, "activeIdx:", activeIndexRef.current, "trimEndHandled:", trimEndHandledRef.current, "isIsolated:", isIsolatedRef.current, "hotSwap:", hotSwapRef.current);
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
  }, [handleVideoLoadError]);

  // ── Preload slot handlers ──────────────────────────────────────────────────
  // The inactive slot tracks readiness AND positions itself at the upcoming
  // clip's trimStart so the hot-swap lands at the correct playback position.
  const onPreloadLoad = useCallback((status: AVPlaybackStatus, slot: 0 | 1) => {
    if (status.isLoaded) {
      const expectedUri = preloadExpectedUriRef.current;
      if (!expectedUri) {
        preloadReadyRef.current = true;
        return;
      }
      const clip = clipsRef.current.find((c) => c.uri === expectedUri);
      const trimStart = clip?.trimStartMs ?? 0;
      const vRef = slot === 0 ? videoRefA.current : videoRefB.current;
      // ALWAYS seek to trimStart (even when 0) so the preload slot is at the
      // correct starting position. Without this, the player can inherit a stale
      // position from a previous clip that used this slot, causing the new clip
      // to start near its end instead of from the beginning.
      if (vRef) {
        preloadReadyRef.current = false;
        console.log("[preload-debug] seeking preload to trimStart:", trimStart, "for clip:", expectedUri.slice(-20));
        vRef
          .setPositionAsync(trimStart)
          .then(() => { preloadReadyRef.current = true; console.log("[preload-debug] preload seek complete, preloadReadyRef:", preloadReadyRef.current); })
          .catch(() => { preloadReadyRef.current = true; console.log("[preload-debug] preload seek FAILED, preloadReadyRef:", preloadReadyRef.current); });
      } else {
        preloadReadyRef.current = true;
        console.log("[preload-debug] preload loaded, no vRef to seek, preloadReadyRef:", preloadReadyRef.current);
      }
    } else if (!status.isLoaded && "error" in status && status.error) {
      preloadReadyRef.current = false;
    }
  }, []);

  // Per-slot dispatch: only the active slot runs the full playback logic; the
  // inactive slot just updates preload readiness.
  const onStatusSlot0 = useCallback(
    (s: AVPlaybackStatus) => { if (activeSlotRef.current === 0) onVideoStatus(s); },
    [onVideoStatus],
  );
  const onStatusSlot1 = useCallback(
    (s: AVPlaybackStatus) => { if (activeSlotRef.current === 1) onVideoStatus(s); },
    [onVideoStatus],
  );

  // onReadyForDisplay only drives the active slot's readiness; the inactive
  // slot's readiness is managed solely by onPreloadLoad (+ seek completion)
  // so preloadReadyRef never flips true before the trimStart seek finishes.
  const onReadySlot0 = useCallback(() => {
    console.log("[edit] onReadyForDisplay SLOT_A", { isActiveSlot: activeSlotRef.current === 0, activeSlot: activeSlotRef.current, activeIndex: activeIndexRef.current });
    if (activeSlotRef.current === 0) setVideoReady(true);
  }, []);
  const onReadySlot1 = useCallback(() => {
    console.log("[edit] onReadyForDisplay SLOT_B", { isActiveSlot: activeSlotRef.current === 1, activeSlot: activeSlotRef.current, activeIndex: activeIndexRef.current });
    if (activeSlotRef.current === 1) setVideoReady(true);
  }, []);

  const onLoadSlot0 = useCallback((status: AVPlaybackStatus) => {
    console.log("[edit] onLoad SLOT_A", { isActiveSlot: activeSlotRef.current === 0, isLoaded: status.isLoaded, activeIndex: activeIndexRef.current, activeSlot: activeSlotRef.current });
    if (activeSlotRef.current === 0) {
      if (status.isLoaded) {
        videoRetryCountRef.current = 0;
        setVideoLoadError(null);
        setVideoReady(true);
        console.log("[edit] onLoad SLOT_A → setVideoReady(true)");
      }
    } else {
      onPreloadLoad(status, 0);
    }
  }, [onPreloadLoad]);
  const onLoadSlot1 = useCallback((status: AVPlaybackStatus) => {
    console.log("[edit] onLoad SLOT_B", { isActiveSlot: activeSlotRef.current === 1, isLoaded: status.isLoaded, activeIndex: activeIndexRef.current, activeSlot: activeSlotRef.current });
    if (activeSlotRef.current === 1) {
      if (status.isLoaded) {
        videoRetryCountRef.current = 0;
        setVideoLoadError(null);
        setVideoReady(true);
        console.log("[edit] onLoad SLOT_B → setVideoReady(true)");
      }
    } else {
      onPreloadLoad(status, 1);
    }
  }, [onPreloadLoad]);

  const onErrorSlot0 = useCallback((err: string) => {
    if (activeSlotRef.current === 0) handleVideoLoadError(err);
    else preloadReadyRef.current = false;
  }, [handleVideoLoadError]);
  const onErrorSlot1 = useCallback((err: string) => {
    if (activeSlotRef.current === 1) handleVideoLoadError(err);
    else preloadReadyRef.current = false;
  }, [handleVideoLoadError]);

  // Re-entrancy guard: prevents advanceToNextClip from being called again
  // before the new clip has started playing. The old player can fire stale
  // didJustFinish/status events after the source changes, causing cascading
  // advances that skip clips.
  const isAdvancingRef = useRef<boolean>(false);

  const advanceToNextClip = useCallback(() => {
    if (isAdvancingRef.current) {
      console.log("[advance] BLOCKED by isAdvancingRef — ignoring re-entrant call");
      return;
    }
    isAdvancingRef.current = true;
    // Safety-net: release the guard after 500ms so a legitimate future advance
    // is never permanently blocked. All stale events from the old player fire
    // within this window.
    setTimeout(() => {
      if (isAdvancingRef.current) {
        console.log("[advance] isAdvancingRef released by timeout");
        isAdvancingRef.current = false;
      }
    }, 500);

    const selIdx = selectedClipIdxRef.current;
    if (isIsolatedRef.current && selIdx >= 0 && selIdx < clipsRef.current.length && selIdx === activeIndexRef.current) {
      // Auto-loop: restart the selected clip instead of stopping
      console.log("[advance] isolated loop — selIdx:", selIdx);
      isAdvancingRef.current = false;
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
    console.log("[advance] advanceToNextClip ENTRY", {
      currentIdx, clipsLen: currentClips.length, isAdvancing: isAdvancingRef.current, isIsolated: isIsolatedRef.current, hotSwap: hotSwapRef.current,
    });

    if (currentIdx < currentClips.length - 1) {
      const nextIdx = currentIdx + 1;
      const nextClip = currentClips[nextIdx];
      const sameUri =
        currentPlayingClipUriRef.current === (nextClip?.uri ?? null);

      console.log("[advance] FORWARD — currentIdx:", currentIdx, "→ nextIdx:", nextIdx, "clipsLen:", currentClips.length, "sameUri:", sameUri, "preloadReady:", preloadReadyRef.current, "expectedUri:", preloadExpectedUriRef.current?.slice(-20), "nextClipUri:", nextClip?.uri.slice(-20));
      if (
        !sameUri &&
        nextClip?.type === "video" &&
        preloadReadyRef.current &&
        preloadExpectedUriRef.current === nextClip?.uri
      ) {
        console.log("[advance] HOT-SWAP forward — slot flip, nextIdx:", nextIdx);
        const newSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        trimStartRef.current = nextClip?.trimStartMs ?? 0;
        trimEndRef.current = nextClip?.trimEndMs ?? (nextClip?.durationMs ?? 0);
        prevTrimStartRef.current = trimStartRef.current;
        prevTrimEndRef.current = trimEndRef.current;
        trimEndHandledRef.current = true; // keep true to block stale didJustFinish
        // Only trust the preloaded player's position if preloadReadyRef is true,
        // which now also guarantees the trimStart seek completed (onPreloadLoad).
        // Otherwise let onVideoStatus's seek path handle it.
        trimSeekDoneRef.current = preloadReadyRef.current;
        trimGenerationRef.current += 1;
        pendingSeekRef.current = null;
        durationSetRef.current = true;
        lastPositionUpdate.current = 0;

        const incomingVideo = newSlot === 0 ? videoRefA.current : videoRefB.current;
        videoRef.current = incomingVideo;
        activeSlotRef.current = newSlot;
        currentPlayingClipUriRef.current = nextClip?.uri ?? null;

        // Arm the next preload (clip after the one we're swapping into) on the
        // slot we're leaving, which becomes the new inactive slot.
        const afterIdx = nextIdx < currentClips.length - 1 ? nextIdx + 1 : 0;
        const afterClip = currentClips[afterIdx];
        if (
          afterClip &&
          afterClip.type === "video" &&
          afterClip.uri !== (nextClip?.uri ?? null)
        ) {
          preloadArmedRef.current = true;
          preloadReadyRef.current = false;
          preloadExpectedUriRef.current = afterClip.uri;
          setPreloadSource({ uri: afterClip.uri });
        } else {
          preloadArmedRef.current = false;
          preloadReadyRef.current = false;
          preloadExpectedUriRef.current = null;
          setPreloadSource(undefined);
        }

        hotSwapRef.current = true; // prevents state-reset effects from stalling
        activeIndexRef.current = nextIdx;
        setActiveSlot(newSlot);
        setActiveIndex(nextIdx);
        setPositionMs(segmentOffsetRef.current);
        setVideoReady(true);
        setIsPlaying(true);

        incomingVideo?.setIsMutedAsync(false).catch(() => {});
        // ALWAYS seek to trimStart (or 0) before playing — the preload slot may
        // have inherited a stale position from a previous clip. Without this
        // seek, the new clip can start near its end and freeze.
        const seekTarget = trimStartRef.current;
        console.log("[advance] HOT-SWAP forward — seeking to:", seekTarget, "then playing");
        incomingVideo
          ?.setPositionAsync(seekTarget)
          .then(() => {
            incomingVideo?.playAsync().catch(() => {});
            // Reset trimEndHandledRef AFTER the seek completes so the
            // end-of-segment check can fire for the new clip. It was set to
            // true above to block stale didJustFinish from the old player.
            trimEndHandledRef.current = false;
            console.log("[advance] HOT-SWAP forward — seek done, trimEndHandledRef reset to false");
          })
          .catch(() => {
            incomingVideo?.playAsync().catch(() => {});
            trimEndHandledRef.current = false;
          });
        return;
      }

      console.log("[advance] COLD-LOAD forward — nextIdx:", nextIdx, "isAdvancing was true, setting hotSwapRef to prevent isPlaying reset");
      trimStartRef.current = nextClip?.trimStartMs ?? 0;
      trimEndRef.current = nextClip?.trimEndMs ?? (nextClip?.durationMs ?? 0);
      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      trimEndHandledRef.current = true; // keep true to block stale didJustFinish
      trimGenerationRef.current += 1;
      // Set hotSwapRef so the [videoKey, activeClipUri] effect doesn't reset
      // isPlaying=false / videoReady=false. The cold-load path IS an auto-
      // advance — the new clip should start playing as soon as it loads.
      hotSwapRef.current = true;

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
        // Different URI: the source will change on the same Video component.
        // Set a pending seek so onVideoStatus seeks to trimStart (or 0) once
        // the new source loads. Without this, the player inherits a stale
        // position from the previous clip and can start near the end.
        currentPlayingClipUriRef.current = nextClip?.uri ?? null;
        pendingSeekRef.current = trimStartRef.current; // seek to 0 if no trim
        lastPositionUpdate.current = 0;
        trimSeekDoneRef.current = false;
        durationSetRef.current = false; // force duration re-load for new clip
        console.log("[advance] COLD-LOAD forward — pendingSeek set to:", pendingSeekRef.current, "for next clip");
      }

      // Reset trimEndHandledRef after a short delay so the end-of-segment
      // check can fire for the new clip. It was set to true above to block
      // stale didJustFinish from the old player.
      setTimeout(() => {
        trimEndHandledRef.current = false;
        console.log("[advance] COLD-LOAD forward — trimEndHandledRef reset to false by timeout");
      }, 300);

      activeIndexRef.current = nextIdx;
      setActiveIndex(nextIdx);
      setPositionMs(segmentOffsetRef.current);
      setIsPlaying(true);
    } else {
      const firstClip = currentClips[0];
      const sameUri =
        currentPlayingClipUriRef.current === (firstClip?.uri ?? null);

      console.log("[advance] WRAP-AROUND — currentIdx:", currentIdx, "→ 0, preloadReady:", preloadReadyRef.current, "expectedUri:", preloadExpectedUriRef.current?.slice(-20), "firstClipUri:", firstClip?.uri.slice(-20));

      // Hot swap for the wrap-around (last clip → first clip).
      if (
        !sameUri &&
        firstClip?.type === "video" &&
        preloadReadyRef.current &&
        preloadExpectedUriRef.current === firstClip?.uri
      ) {
        console.log("[advance] HOT-SWAP wrap-around — slot flip to clip 0");
        const newSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        trimStartRef.current = firstClip?.trimStartMs ?? 0;
        trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
        prevTrimStartRef.current = trimStartRef.current;
        prevTrimEndRef.current = trimEndRef.current;
        segmentOffsetRef.current = 0;
        trimEndHandledRef.current = true; // keep true to block stale didJustFinish
        // Same conditional as the forward hot-swap: trust the preload's position
        // only when preloadReadyRef confirms the seek completed.
        trimSeekDoneRef.current = preloadReadyRef.current;
        trimGenerationRef.current += 1;
        pendingSeekRef.current = null;
        durationSetRef.current = true;
        lastPositionUpdate.current = 0;

        const incomingVideo = newSlot === 0 ? videoRefA.current : videoRefB.current;
        videoRef.current = incomingVideo;
        activeSlotRef.current = newSlot;
        currentPlayingClipUriRef.current = firstClip?.uri ?? null;

        const afterClip = currentClips.length > 1 ? currentClips[1] : undefined;
        if (
          currentClips.length > 1 &&
          afterClip &&
          afterClip.type === "video" &&
          afterClip.uri !== (firstClip?.uri ?? null)
        ) {
          preloadArmedRef.current = true;
          preloadReadyRef.current = false;
          preloadExpectedUriRef.current = afterClip.uri;
          setPreloadSource({ uri: afterClip.uri });
        } else {
          preloadArmedRef.current = false;
          preloadReadyRef.current = false;
          preloadExpectedUriRef.current = null;
          setPreloadSource(undefined);
        }

        hotSwapRef.current = true;
        activeIndexRef.current = 0;
        setActiveSlot(newSlot);
        setActiveIndex(0);
        setPositionMs(0);
        setVideoReady(true);
        setIsPlaying(true);

        incomingVideo?.setIsMutedAsync(false).catch(() => {});
        // ALWAYS seek to trimStart (or 0) before playing — same reason as
        // forward hot-swap: preload slot may have a stale position.
        const wrapSeekTarget = trimStartRef.current;
        console.log("[advance] HOT-SWAP wrap — seeking to:", wrapSeekTarget, "then playing");
        incomingVideo
          ?.setPositionAsync(wrapSeekTarget)
          .then(() => {
            incomingVideo?.playAsync().catch(() => {});
            trimEndHandledRef.current = false;
            console.log("[advance] HOT-SWAP wrap — seek done, trimEndHandledRef reset to false");
          })
          .catch(() => {
            incomingVideo?.playAsync().catch(() => {});
            trimEndHandledRef.current = false;
          });
        return;
      }

      console.log("[advance] COLD-LOAD wrap-around — to clip 0, setting hotSwapRef");
      const seekTarget = firstClip?.trimStartMs ?? 0;

      trimStartRef.current = firstClip?.trimStartMs ?? 0;
      trimEndRef.current = firstClip?.trimEndMs ?? (firstClip?.durationMs ?? 0);
      prevTrimStartRef.current = trimStartRef.current;
      prevTrimEndRef.current = trimEndRef.current;
      segmentOffsetRef.current = 0;
      trimEndHandledRef.current = true; // keep true to block stale didJustFinish
      trimGenerationRef.current += 1;
      // Same as cold-load forward: prevent the [activeClipUri] effect from
      // resetting isPlaying=false on the wrap-around auto-advance.
      hotSwapRef.current = true;

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
        // Different URI: set a pending seek so onVideoStatus seeks to
        // trimStart (or 0) once the new source loads.
        currentPlayingClipUriRef.current = firstClip?.uri ?? null;
        pendingSeekRef.current = seekTarget;
        lastPositionUpdate.current = 0;
        trimSeekDoneRef.current = false;
        durationSetRef.current = false;
        console.log("[advance] COLD-LOAD wrap — pendingSeek set to:", seekTarget, "for first clip");
      }

      // Reset trimEndHandledRef after a short delay so the end-of-segment
      // check can fire for the new clip.
      setTimeout(() => {
        trimEndHandledRef.current = false;
        console.log("[advance] COLD-LOAD wrap — trimEndHandledRef reset to false by timeout");
      }, 300);

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

        // If the updated clip is currently preloading in the inactive slot
        // (i.e. it's the upcoming clip), the preloaded player may be parked at
        // the OLD trimStart. Re-seek it to the new trimStart so the hot-swap
        // lands at the right position. We re-derive the trimStart from `next`
        // because `updates` may only contain one of trimStartMs/trimEndMs.
        const updatedClip = next.find((c) => c.id === clipId);
        const isActiveClip = updatedClip
          ? activeIndexRef.current >= 0 &&
            next[activeIndexRef.current]?.id === updatedClip.id
          : false;
        if (
          updatedClip &&
          !isActiveClip &&
          updatedClip.uri === preloadExpectedUriRef.current &&
          updatedClip.type === "video"
        ) {
          const newTrimStart = updatedClip.trimStartMs ?? 0;
          console.log("[preload-debug] trim changed on preloading clip, re-seeking to:", newTrimStart);
          // Figure out which slot is inactive right now.
          const inactiveSlot: 0 | 1 =
            activeSlotRef.current === 0 ? 1 : 0;
          const vRef =
            inactiveSlot === 0 ? videoRefA.current : videoRefB.current;
          if (vRef) {
            preloadReadyRef.current = false; // block hot-swap until seek done
            vRef
              .setPositionAsync(newTrimStart)
              .then(() => { preloadReadyRef.current = true; console.log("[preload-debug] handleClipUpdate re-seek complete, preloadReadyRef:", preloadReadyRef.current); })
              .catch(() => { preloadReadyRef.current = true; console.log("[preload-debug] handleClipUpdate re-seek FAILED, preloadReadyRef:", preloadReadyRef.current); });
          } else {
            console.log("[preload-debug] handleClipUpdate re-seek skipped — no inactive vRef");
          }
        }

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
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/(tabs)");
      }
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

  // ── Thumbnail generation helper ────────────────────────────────────────────

  const generateThumbnail = useCallback(async (videoUri: string): Promise<string | null> => {
    try {
      const result = await getThumbnailAsync(videoUri, { time: 0 });
      if (!result?.uri) return null;
      const permanentDir = `${documentDirectory}thumbnails/`;
      await makeDirectoryAsync(permanentDir, { intermediates: true });
      const permanentUri = `${permanentDir}cover_${Date.now()}.jpg`;
      await copyAsync({ from: result.uri, to: permanentUri });
      return permanentUri;
    } catch {
      return null;
    }
  }, []);

  const handleSaveDraftPress = useCallback(() => {
    if (clips.length === 0) return;
    setError(null);
    setSuccess(null);
    executeSaveDraftRef.current().catch((e: any) => {
      setError(e instanceof Error ? e.message : "Could not save draft.");
    });
  }, [clips]);

  const executeSaveDraft = useCallback(async () => {
    if (clips.length === 0) return;
    setError(null);
    try {
      // Auto-generate cover thumbnail from first video frame
      const firstVideo = clips.find((c) => c.type === "video");
      const thumbnailUri = firstVideo ? await generateThumbnail(firstVideo.uri) : null;
      if (firstVideo) {
        console.log("[edit] executeSaveDraft: thumbnail generated", thumbnailUri ? thumbnailUri.slice(-40) : "FAILED");
      }

      const draftIdFinal: string =
        draftId ??
        `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const draftDir = `${documentDirectory}drafts/${draftIdFinal}/`;
      await makeDirectoryAsync(draftDir, { intermediates: true });

      const permanentClips = await Promise.all(
        clips.map(async (c, i) => {
          // Verify the source file exists and is non-zero BEFORE attempting copy.
          const srcInfo = await getInfoAsync(c.uri);
          if (!srcInfo.exists || (srcInfo.size ?? 0) === 0) {
            console.warn(
              `[edit] executeSaveDraft: source clip[${i}] missing or empty — keeping original URI`,
            );
            return c;
          }
          const srcSize = srcInfo.size ?? 0;

          const ext = c.uri.match(/\.(\w+)(?:\?|$)/)?.[1] ?? (c.type === "video" ? "mp4" : "jpg");
          const destUri = `${draftDir}${c.id}.${ext}`;
          if (c.uri !== destUri) {
            try {
              await copyAsync({ from: c.uri, to: destUri });
              // Verify destination size matches source size
              const destInfo = await getInfoAsync(destUri);
              if (!destInfo.exists) {
                console.warn(
                  `[edit] executeSaveDraft: copy failed for clip[${i}] — destination missing, keeping original URI`,
                );
                return c;
              }
              const destSize = destInfo.size;
              if (destSize === 0) {
                console.warn(
                  `[edit] executeSaveDraft: copy produced empty file for clip[${i}] — keeping original URI`,
                );
                return c;
              }
              if (destSize !== srcSize) {
                console.error(
                  `[edit] executeSaveDraft: SIZE MISMATCH clip[${i}] — source: ${srcSize}, dest: ${destSize}. Keeping original URI.`,
                );
                return c;
              }
              console.log(
                `[edit] executeSaveDraft: clip[${i}] copied & verified — ${destSize} bytes (matches source)`,
              );
            } catch {
              console.warn(
                `[edit] executeSaveDraft: copy threw for clip[${i}] — keeping original URI`,
              );
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
        coverThumbnailMs: thumbnailUri ? 0 : undefined,
        createdAt: draftId
          ? (draftProjects.find((d) => d.id === draftId)?.createdAt ??
            Date.now())
          : Date.now(),
        updatedAt: Date.now(),
      };
      await saveDraftProject(project);
      setSuccess("Draft saved");
      setTimeout(() => {
        if (!draftId) {
          // New draft: dismiss all modals to return to the feed
          router.dismissAll();
        } else if (router.canGoBack()) {
          router.back();
        } else {
          router.replace("/(tabs)");
        }
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save draft.");
    }
  }, [clips, draftId, draftProjects, textOverlays, saveDraftProject, generateThumbnail, router]);

  const executePost = useCallback(async () => {
    try {
      if (clips.length === 0) {
        console.error("[edit] executePost: clips array is empty — cannot post");
        setError("Nothing to post. Please record or select media first.");
        return;
      }
      console.log("[edit] executePost: starting optimistic post with", clips.length, "clip(s)");
      setError(null);
      setSuccess(null);
      setUploading(true);

      // ── Pause the video IMMEDIATELY before any upload work begins ───
      setIsPlaying(false);
      try {
        videoRef.current?.pauseAsync();
      } catch {
        // Best-effort — continue with upload regardless
      }

      const primary = clips[0]!;

      // ── 1. Copy all clip files to a stable permanent location ────────
      const stableDir = `${documentDirectory}post_uploads/`;
      await makeDirectoryAsync(stableDir, { intermediates: true });

      const isWeb = Platform.OS === "web";

      const copiedClips = await Promise.all(
        clips.map(async (c, i) => {
          if (isWeb && c.uri.startsWith("data:")) {
            const estimatedKB = Math.round(c.uri.length * 0.75 / 1024);
            console.log(
              `[edit] executePost: clip[${i}] is a data: URI (~${estimatedKB} KB) — skipping copy`,
            );
            return c;
          }

          const srcInfo = await getInfoAsync(c.uri);
          if (!srcInfo.exists) {
            throw new Error(
              `Source file missing before copy — clip[${i}]: ${c.uri.slice(0, 60)}`,
            );
          }
          const srcSize = srcInfo.size ?? 0;
          if (srcSize === 0) {
            throw new Error(
              `Source file is empty (0 bytes) before copy — clip[${i}]: ${c.uri.slice(0, 60)}`,
            );
          }
          console.log(
            `[edit] executePost: source verified — clip[${i}] ${c.uri.slice(0, 50)} — ${srcSize} bytes`,
          );

          const ext = c.uri.match(/\.(\w+)(?:\?|$)/)?.[1] ?? (c.type === "video" ? "mov" : "jpg");
          const stableUri = `${stableDir}clip_${i}_${Date.now()}.${ext}`;
          console.log(
            `[edit] executePost: copying clip[${i}] — ${srcSize} bytes → ${stableUri.slice(-50)}`,
          );

          await copyAsync({ from: c.uri, to: stableUri });

          const destInfo = await getInfoAsync(stableUri);
          if (!destInfo.exists) {
            throw new Error(
              `Copy failed — destination missing clip[${i}]: ${stableUri.slice(0, 60)}`,
            );
          }
          const destSize = destInfo.size;
          if (destSize === 0) {
            throw new Error(
              `Copy failed — destination is empty (0 bytes) clip[${i}]: ${stableUri.slice(0, 60)}`,
            );
          }
          if (destSize !== srcSize) {
            throw new Error(
              `Copy failed — size mismatch clip[${i}]: source ${srcSize} bytes, destination ${destSize} bytes. File may be corrupted.`,
            );
          }
          console.log(
            `[edit] executePost: clip[${i}] copied & verified — ${destSize} bytes (matches source)`,
          );
          return { ...c, uri: stableUri };
        }),
      );

      let stablePrimary = copiedClips[0]!;
      console.log("[edit] executePost: all clips copied to stable location — primary:", stablePrimary.uri.slice(-40));

      // ── 2b. Generate cover thumbnail from first video frame ──────────
      let thumbnailUri: string | null = null;
      if (stablePrimary.type === "video") {
        thumbnailUri = await generateThumbnail(stablePrimary.uri);
        console.log("[edit] executePost: thumbnail generated", thumbnailUri ? thumbnailUri.slice(-40) : "FAILED — continuing without thumbnail");
      }

      // For multi-clip Drops, upload each segment individually.
      const segmentUris =
        copiedClips.length > 1 ? copiedClips.map((c) => c.uri) : undefined;
      const hasAnyTrim = copiedClips.some(
        (c) =>
          (c.trimStartMs ?? 0) > 0 ||
          (c.trimEndMs ?? 0) < (c.durationMs ?? Infinity),
      );
      const trimData: Array<{ trimStartMs: number; trimEndMs: number }> | undefined =
        hasAnyTrim
          ? copiedClips.map((c) => ({
              trimStartMs: c.trimStartMs ?? 0,
              trimEndMs: c.trimEndMs ?? (c.durationMs ?? 0),
            }))
          : undefined;
      const overlaysForPost = textOverlays.length > 0 ? textOverlays : undefined;

      // ── 3. Create optimistic post — appears immediately in the feed ──
      //    Pass reactingTo as parentPostId so the optimistic post is only
      //    inserted into the fyp cache for root Drops, not reactions.
      const tempId = addOptimisticPost(
        {
          uri: stablePrimary.uri,
          mediaType: stablePrimary.type,
          caption: undefined,
          draftId: draftId ?? undefined,
          segmentUris,
          trimData,
          textOverlays: overlaysForPost,
          thumbnailUri: thumbnailUri ?? undefined,
        },
        reactingTo || null,
      );

      console.log("[edit] executePost: optimistic post added", {
        tempId: tempId?.slice(0, 8),
        reactingTo: reactingTo?.slice(0, 12) ?? "(none — will be root Drop)",
        rootDropId: rootDropId?.slice(0, 12) ?? "(none)",
        mediaType: stablePrimary.type,
      });

      // ── 4. Fire-and-forget upload in the background ──────────────────
      //    MUST come BEFORE navigation — if navigation throws, the mutation
      //    is already registered with TanStack Query and will still upload.
      //    onSuccess → finalizeOptimisticPost (swap for real post)
      //    onError   → failOptimisticPost (show error + retry on card)
      //    onProgress → updateOptimisticProgress (0–100% bar on the card)
      createPost.mutate({
        uri: stablePrimary.uri,
        mediaType: stablePrimary.type,
        draftId: draftId ?? undefined,
        parentPostId: reactingTo || undefined,
        segmentUris,
        trimData,
        textOverlays: overlaysForPost,
        thumbnailUri: thumbnailUri ?? undefined,
        isMature,
        optimisticTempId: tempId,
        onProgress: (percent: number) => {
          updateOptimisticProgress(tempId, percent);
        },
      });

      console.log("[edit] executePost: createPost.mutate() REGISTERED", {
        tempId: tempId?.slice(0, 8),
        parentPostId: (reactingTo || undefined)?.slice(0, 12) ?? "(none)",
        rootDropId: rootDropId?.slice(0, 12) ?? "(none)",
        mediaType: stablePrimary.type,
        uriStart: stablePrimary.uri.slice(0, 40),
      });

      // ── 5. Navigate to the right screen (best-effort) ───────────────
      //    Root Drops → feed tab. Reactions & replies → reaction-tree
      //    Wrapped in try/catch so navigation failures are logged but
      //    NEVER prevent the post from being saved.
      const reactionTreeId = rootDropId || reactingTo;
      try {
        try {
          router.dismissAll();
        } catch {
          if (router.canGoBack()) router.back();
        }
        if (reactionTreeId) {
          console.log("[edit] executePost: navigating to reaction-tree for", reactionTreeId.slice(0, 8));
          router.replace(`/post/${reactionTreeId}/reaction-tree` as never);
        } else {
          console.log("[edit] executePost: navigating to feed");
          router.replace("/(tabs)");
        }
      } catch (navErr) {
        // Navigation failed but the post IS already saving — log it, don't throw.
        console.warn("[edit] executePost: navigation after post failed (post is still uploading)", (navErr as Error)?.message);
      }

      setSuccess("Posted!");
    } catch (postErr) {
      const errMsg = postErr instanceof Error ? postErr.message : "Could not post your drop. Please try again.";
      const errAny = postErr as unknown as Record<string, unknown> | undefined;
      console.error("[edit] executePost: FAILED —", errMsg);
      console.error("[edit] executePost: FULL ERROR DUMP:", {
        message: (postErr as Error)?.message,
        name: (postErr as Error)?.name,
        stack: (postErr as Error)?.stack?.slice(0, 500),
        code: errAny?.code,
        details: errAny?.details,
        hint: errAny?.hint,
        status: errAny?.status,
        statusCode: errAny?.statusCode,
        raw: JSON.stringify(errAny, null, 2).slice(0, 500),
      });
      showAlert("Post Failed", errMsg);
      setError(errMsg);
      setUploading(false);
      // DO NOT re-throw and DO NOT navigate. Stay on the edit screen
      // so the user can retry or save as draft.
    }
  }, [clips, draftId, textOverlays, isMature, createPost, addOptimisticPost, updateOptimisticProgress, generateThumbnail, router, reactingTo, rootDropId]);

  useEffect(() => { executeSaveDraftRef.current = executeSaveDraft; }, [executeSaveDraft]);

  // handlePostPress calls executePost directly (no ref indirection) so the
  // `clips` closure used at tap time is always the most recent one. Earlier the
  // handler read executePostRef.current, whose sync effect ran after render —
  // so a tap that landed between a trim edit and the effect would invoke a
  // stale executePost closure and silently drop trimmed clips from the upload.
  const handlePostPress = useCallback(() => {
    console.log("[edit] handlePostPress: Post Drop tapped — clips:", clips.length, "user:", !!user?.id);

    try {
      if (!router) {
        console.error("[edit] handlePostPress: router is null/undefined");
        setError("Navigation is not available. Please restart the app.");
        return;
      }
      if (!clips || clips.length === 0) {
        console.warn("[edit] handlePostPress: no clips to post");
        return;
      }
      if (!user?.id || !session) {
        console.error("[edit] handlePostPress: not authenticated", { hasUser: !!user, hasSession: !!session });
        setError("You must be signed in to post. Please sign in and try again.");
        return;
      }

      setError(null);
      setSuccess(null);
      console.log("[edit] handlePostPress: calling executePost...");
      const postPromise = executePost();
      if (!postPromise || typeof postPromise.catch !== "function") {
        console.error("[edit] handlePostPress: executePost did not return a Promise — got", typeof postPromise);
        setError("Something went wrong. Please try again.");
        return;
      }
      postPromise.catch((e: any) => {
        console.error("[edit] handlePostPress: executePost FAILED (fallback)", (e as Error)?.message ?? e);
        // executePost already showed Alert.alert() — just set banner as fallback
        setError(e instanceof Error ? e.message : "Could not post your drop.");
      });
    } catch (err) {
      console.error("[edit] handlePostPress: CRASH in handler", (err as Error)?.message ?? err);
      showAlert(
        "Post Failed",
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    }
  }, [clips, router, user, session, executePost]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (draftId && !draftsLoaded) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <UiText style={[styles.emptyText, { marginTop: 16 }]}>
          Loading draft…
        </UiText>
      </View>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (clips.length === 0) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <UiText style={styles.emptyText}>Nothing to preview</UiText>
        <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.emptyBtn}>
          <UiText style={styles.emptyBtnText}>Go back</UiText>
        </Pressable>
      </View>
    );
  }

  const isIsolated = selectedClipId !== null;
  const editingOverlay = editingOverlayId
    ? textOverlays.find((ov) => ov.id === editingOverlayId)
    : null;

  // ── Periodic play-state diagnostic ─────────────────────────────────────
  // Logs every 3s (NOT 500ms — that flooded the log buffer and pushed out
  // transition events, making debugging impossible).
  useEffect(() => {
    const interval = setInterval(() => {
      const slot = activeSlotRef.current;
      const computedShouldPlay = isPlaying && videoReady;
      console.log("[edit] HEARTBEAT", {
        slot,
        idx: activeIndexRef.current,
        isPlaying,
        videoReady,
        computedShouldPlay,
        posMs: positionMs,
        isAdvancing: isAdvancingRef.current,
        hotSwap: hotSwapRef.current,
        preloadArmed: preloadArmedRef.current,
        clipUri: clips[activeIndexRef.current]?.uri?.slice(-30),
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [isPlaying, videoReady, positionMs, clips, activeIndex]);

  // ── RENDER — Full Production Editor ─────────────────────────────────────

  // Debug: log the actual shouldPlay prop value being passed to the active Video
  if (isVideo && videoSource) {
    const activeShouldPlay = activeSlot === 0 ? isPlaying && videoReady : isPlaying && videoReady;
    console.log("[edit] RENDER shouldPlay", { activeSlot, isPlaying, videoReady, activeShouldPlay, idx: activeIndex, uri: activeClip?.uri?.slice(-30) });
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.screen}>
        <StatusBar style="light" />

        {/* ── Top bar ────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
            style={styles.topBtn}
          >
            <ArrowLeft size={20} color="#fff" strokeWidth={2.5} />
          </TouchableOpacity>
          <UiText style={styles.topTitle}>
            {draftId ? "Edit Draft" : "Edit Drop"}
          </UiText>
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
              <>
                {/* Slot A — active when activeSlot === 0, else preloading next clip */}
                {(activeSlot === 0 || preloadSource !== undefined) && (
                  <Video
                    key={`slotA-${videoKey}`}
                    ref={videoRefA}
                    source={activeSlot === 0 ? videoSource : preloadSource}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      opacity: activeSlot === 0 ? 1 : 0,
                    }}
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay={activeSlot === 0 ? isPlaying && videoReady : false}
                    isLooping={false}
                    isMuted={activeSlot === 0 ? false : true}
                    onReadyForDisplay={onReadySlot0}
                    onPlaybackStatusUpdate={onStatusSlot0}
                    onError={(err: string) => {
                      console.error("[edit] Video slotA onError:", err);
                      onErrorSlot0(err);
                    }}
                    onLoad={onLoadSlot0}
                    progressUpdateIntervalMillis={200}
                    pointerEvents="none"
                  />
                )}
                {/* Slot B — active when activeSlot === 1, else preloading next clip */}
                {(activeSlot === 1 || preloadSource !== undefined) && (
                  <Video
                    key={`slotB-${videoKey}`}
                    ref={videoRefB}
                    source={activeSlot === 1 ? videoSource : preloadSource}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      opacity: activeSlot === 1 ? 1 : 0,
                    }}
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay={activeSlot === 1 ? isPlaying && videoReady : false}
                    isLooping={false}
                    isMuted={activeSlot === 1 ? false : true}
                    onReadyForDisplay={onReadySlot1}
                    onPlaybackStatusUpdate={onStatusSlot1}
                    onError={(err: string) => {
                      console.error("[edit] Video slotB onError:", err);
                      onErrorSlot1(err);
                    }}
                    onLoad={onLoadSlot1}
                    progressUpdateIntervalMillis={200}
                    pointerEvents="none"
                  />
                )}
                {videoLoadError && (
                  <View style={styles.videoErrorOverlay}>
                    <UiText style={styles.videoErrorText}>{videoLoadError}</UiText>
                    <Pressable
                      onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
                      style={styles.videoErrorBackBtn}
                    >
                      <UiText style={styles.videoErrorBackBtnText}>Go Back</UiText>
                    </Pressable>
                  </View>
                )}
              </>
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
                <UiText style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>
                  No preview
                </UiText>
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
            <UiText
              style={[
                styles.toolLabel,
                selectedClipId && { color: theme.accent },
              ]}
            >
              Trim
            </UiText>
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
            <UiText
              style={[
                styles.toolLabel,
                !canSplit && styles.toolLabelOff,
              ]}
            >
              Split
            </UiText>
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
            <UiText
              style={[
                styles.toolLabel,
                (selectedOverlayId || textEditorVisible) && {
                  color: theme.accent,
                },
              ]}
            >
              Text
            </UiText>
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
            <UiText
              style={[
                styles.toolLabel,
                !selectedClipId && styles.toolLabelOff,
              ]}
            >
              Delete
            </UiText>
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
                <UiText style={styles.textActionLabel}>Style</UiText>
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
                <UiText style={styles.textActionLabel}>Edit</UiText>
              </Pressable>
              <Pressable
                onPress={handleDuplicateOverlay}
                style={styles.textActionBtn}
              >
                <Type size={14} color="rgba(255,255,255,0.8)" />
                <UiText style={styles.textActionLabel}>Duplicate</UiText>
              </Pressable>
              <Pressable
                onPress={() => handleDeleteOverlay()}
                style={[styles.textActionBtn, styles.textActionBtnDanger]}
              >
                <Trash2 size={14} color="#FF453A" />
                <UiText
                  style={[
                    styles.textActionLabel,
                    styles.textActionLabelDanger,
                  ]}
                >
                  Delete
                </UiText>
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
              <UiText style={styles.bannerErrorText}>{error}</UiText>
            </View>
          )}
          {success && (
            <View style={styles.bannerSuccess}>
              <UiText style={styles.bannerSuccessText}>{success}</UiText>
            </View>
          )}
          <View style={styles.matureRow}>
            <View style={styles.matureLabelWrap}>
              <UiText style={styles.matureLabel}>Mark as mature content</UiText>
              <UiText style={styles.matureHint}>Hidden from teen viewers.</UiText>
            </View>
            <Switch
              value={isMature}
              onValueChange={setIsMature}
              trackColor={{ false: theme.border, true: theme.danger }}
              thumbColor="#fff"
              ios_backgroundColor={theme.border}
            />
          </View>
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
              <UiText style={styles.draftBtnText}>Save Draft</UiText>
            </Pressable>
            <Pressable
              onPress={handlePostPress}
              disabled={clips.length === 0 || uploading}
              style={({ pressed }) => [
                styles.postBtn,
                (clips.length === 0 || uploading) && { opacity: 0.35 },
                pressed && !uploading && { opacity: 0.8 },
              ]}
            >
              {uploading ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <ActivityIndicator size="small" color="#fff" />
                  <UiText style={styles.postBtnText}>Preparing...</UiText>
                </View>
              ) : (
                <UiText style={styles.postBtnText}>Post Drop</UiText>
              )}
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
            <UiText
              style={[
                styles.trashLabel,
                dragOverlayInfo.centerY > 0.88 && styles.trashLabelActive,
              ]}
            >
              Drop to delete
            </UiText>
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

  // ── Video error overlay ──
  videoErrorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.85)",
    padding: 24,
  },
  videoErrorText: {
    color: theme.danger,
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 20,
  },
  videoErrorBackBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  videoErrorBackBtnText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
    fontWeight: "700" as const,
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
  matureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 8,
  },
  matureLabelWrap: { flex: 1, paddingRight: 12 },
  matureLabel: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  matureHint: {
    color: theme.textMuted,
    fontSize: 12,
    marginTop: 2,
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

  // ── Upload progress ──
  uploadProgressWrap: {
    gap: 8,
  },
  uploadProgressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  uploadProgressFill: {
    height: "100%" as unknown as number,
    borderRadius: 3,
    backgroundColor: theme.accent,
  },
  uploadProgressText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontWeight: "700" as const,
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
