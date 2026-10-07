import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Share,
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
import { useRouter, useLocalSearchParams, useNavigation } from "expo-router";
import { VideoView, useVideoPlayer, createVideoPlayer, type VideoPlayer } from "expo-video";
import { useVideoStatusFeed, type VideoPlaybackStatus } from "@/hooks/useVideoStatusFeed";
import { documentDirectory, getInfoAsync, makeDirectoryAsync, copyAsync, deleteAsync } from "@/lib/fileSystemCompat";
import { waitForFileReady } from "@/lib/waitForFileReady";
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
  Sparkles,
} from "lucide-react-native";

import { getThumbnailAsync } from "expo-video-thumbnails";
import { showAlert } from "@/lib/showAlert";
import { supabase } from "@/lib/supabase";
import { OWNER_USER_ID, isDebugOwner, isInternalTester } from "@/constants/debug";
import CaptionsExplainer from "@/components/CaptionsExplainer";
import CaptionPreview from "@/components/CaptionPreview";
import { useCaptions } from "@/lib/transcription/useCaptions";
import { buildRenderEdit, renderForPost, renderSkipReason, renderTimeoutMs, type RenderedEdit } from "@/lib/renderAtPost";
import { formatRenderStats, recordRenderStats, reportRender } from "@/lib/renderReport";
import type { CaptionStyle } from "@/lib/editModel";
import { RenderAhead, type AheadState } from "@/lib/renderAhead";
import { cancelRender } from "@/modules/video-render";
import { getMediaLibrary, saveToLibraryAsync } from "@/lib/mediaLibraryCompat";
import { autoEdit, mergeKeepRanges, planSilenceTrim } from "@/lib/ai/autoEdit";
import { analysis } from "@/lib/autoEdit/analysis";
import {
  mergePlan,
  newEditState,
  renderClipsOf,
  setCaptionStyle,
  setCategoryEnabled,
  appliedCutRanges,
  mapNonCutDecisions,
  protectionReport,
  setStates,
  type Decision,
  type EditState,
} from "@/lib/autoEdit/decisions";
import AiEditsSheet from "@/components/AiEditsSheet";
import MarkerSheet from "@/components/MarkerSheet";
import { MANUAL_EDIT_CONFIRM_MESSAGE, guardManualEdits, timelineMatchesState } from "@/lib/autoEdit/confirm";
import { allCategoriesOff, categoryRows, type CategoryRow } from "@/lib/autoEdit/editPanel";
import { formatAiDebug } from "@/lib/autoEdit/debugText";
import { canRedo as canRedoDecisions, canUndo as canUndoDecisions, emptyHistory, mapHistory, pushEdit, redoEdit, undoEdit, type EditHistory } from "@/lib/autoEdit/history";
import {
  buildCutMarkers,
  buildDebugMarkers,
  mapOutputPosition,
  reapplyMarker,
  restoreMarker,
  type TimelineMarker,
} from "@/lib/autoEdit/markers";
import { planSelectionSeek, previewModeFor } from "@/lib/previewSelection";
import { buildAiEditState } from "@/lib/autoEdit/plan";
import { checkAlignment, type Alignment } from "@/lib/autoEdit/alignment";
import { planLaughProtection } from "@/lib/autoEdit/laughProtection";
import { addUserSoundCut, planUmCuts, type UmCutReport } from "@/lib/autoEdit/umCuts";
import { planStretchedUms, type StretchedReport } from "@/lib/autoEdit/stretchedUms";
import { analyzeAdjacent, type AdjacentFinding } from "@/lib/autoEdit/adjacentSounds";
import { analyzeUnexplained, blockUmsOverlapping, nonWordStretchReport, silenceThresholdDb, speechMedianDb, type ClassifiedSound, type NonWordStretch } from "@/lib/autoEdit/classifySound";
import { planFillerCuts } from "@/lib/autoEdit/fillerCuts";
import { emphasisLogEntries, planEmphasis } from "@/lib/autoEdit/emphasisMoments";
import { planHookTrim } from "@/lib/autoEdit/hookTrim";
import { silenceCutsFromDetection } from "@/lib/autoEdit/silenceCuts";
import { keepRangesToClips } from "@/lib/editModel";
import { SENSITIVITY_PRESETS, detectSilences, type Sensitivity } from "@/lib/silenceDetection";
import { getAutoEditEnabled, getAutoEditSensitivity, getSaveEditedToRoll, setAutoEditSensitivity } from "@/lib/autoEditSettings";
import AutoEditReviewSheet from "@/components/AutoEditReviewSheet";
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

/** Auto-edit (silence trimming) switches. */
const AUTO_TRIM_OWNER_ONLY = false;
const AUTO_EDIT_ENABLED = true;

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

/** What the timeline plays: source + trim range per clip (ids and durations ignored). */
function clipsSignature(list: DraftClip[]): string {
  return JSON.stringify(
    list.map((c) => [c.uri, c.trimStartMs ?? 0, c.trimEndMs ?? c.durationMs ?? 0]),
  );
}

/** True when the clips play the same source ranges as `expected` (within tolMs on each edge). */
function sameRanges(
  list: DraftClip[],
  expected: Array<{ trimStartMs: number; trimEndMs: number }>,
  fallbackEndMs: number,
  tolMs = 60,
): boolean {
  if (list.length !== expected.length) return false;
  return list.every((c, i) => {
    const start = c.trimStartMs ?? 0;
    const end = c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? fallbackEndMs);
    return (
      Math.abs(start - expected[i]!.trimStartMs) <= tolMs && Math.abs(end - expected[i]!.trimEndMs) <= tolMs
    );
  });
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
  const navigation = useNavigation();
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

  const _editMountT0 = useRef<number>(Date.now());

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
        return draft.clips;
      }
    }
    if (nativeVideoUrl && !clipsJson) {
      return [{ id: newClipId(), uri: nativeVideoUrl, type: "video" as const }];
    }
    try {
      const parsed = JSON.parse(clipsJson ?? "[]") as DraftClip[];
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
  // The auto-edit decisions behind the clips (see lib/autoEdit/decisions.ts).
  const editStateRef = useRef<{ state: EditState; durationMs: number } | null>(null);
  const [editModel, setEditModelView] = useState<{ state: EditState; durationMs: number } | null>(null);
  const setEditModel = useCallback((m: { state: EditState; durationMs: number } | null) => {
    editStateRef.current = m;
    setEditModelView(m);
  }, []);
  // Undo/redo of the creator's own AI-edit actions (see lib/autoEdit/history.ts).
  const historyRef = useRef<EditHistory>(emptyHistory());
  const [, setHistoryTick] = useState(0);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [markerSheet, setMarkerSheet] = useState<TimelineMarker | null>(null);
  // Owner debug: emphasis proposals and method-2 filler candidates (never applied).
  const [aiDebug, setAiDebug] = useState<{
    proposals: Decision[];
    candidates: ClassifiedSound[];
    alignment: Alignment | null;
    speechBaselineDb: number;
    umReport: UmCutReport;
    stretched?: StretchedReport;
    adjacent?: AdjacentFinding[];
    stretches?: NonWordStretch[];
  } | null>(null);

  useEffect(() => {
    if (draftId) {
      const draft = draftProjects.find((d) => d.id === draftId);
      if (draft?.clips.length) setClips(draft.clips);
      if (draft?.editState && clipsSignature(draft.clips) === draft.editState.clipsSig) {
        setEditModel({ state: draft.editState.state, durationMs: draft.editState.durationMs });
      }
    }
  }, [draftId, draftProjects, setEditModel]);

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
  // No follower system: new posts are always created with follower_visibility false.
  const followerVisibility = false;

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
  // expo-video players: slot A holds the active clip, slot B preloads the
  // next one. Sources are swapped via replace() — useVideoPlayer only reads
  // its initial argument.
  const playerA = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.2;
  });
  const playerB = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.2;
  });
  // Clips cut from one source file (auto-edit, split) share a uri and play on one
  // player with a seek at each seam. Overshooting trimEnd plays cut-out footage,
  // so report position more often and trigger the seam closer to trimEnd.
  const hasSharedClipUris = useMemo(
    () => new Set(clips.map((c) => c.uri)).size < clips.length,
    [clips],
  );
  const hasSharedClipUrisRef = useRef(hasSharedClipUris);
  useEffect(() => {
    hasSharedClipUrisRef.current = hasSharedClipUris;
    const interval = hasSharedClipUris ? 0.05 : 0.2;
    playerA.timeUpdateEventInterval = interval;
    playerB.timeUpdateEventInterval = interval;
  }, [hasSharedClipUris, playerA, playerB]);
  const videoRefA = useRef<VideoPlayer | null>(null);
  const videoRefB = useRef<VideoPlayer | null>(null);
  const videoRef = useRef<VideoPlayer | null>(null);
  // URIs the players were last asked to load (replace() dedupe)
  const loadedAUriRef = useRef<string | null>(null);
  const loadedBUriRef = useRef<string | null>(null);
  // Keep imperative player refs in sync with the player instances
  useEffect(() => {
    videoRefA.current = playerA;
    videoRefB.current = playerB;
  }, [playerA, playerB]);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const hotSwapRef = useRef<boolean>(false);
  useEffect(() => {
    activeSlotRef.current = activeSlot;
    videoRef.current = activeSlot === 0 ? videoRefA.current : videoRefB.current;
  }, [activeSlot]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // ── Render-ahead (internal accounts): render the timeline in the background and
  // play that ONE finished file in the preview while it matches the timeline.
  const aheadRef = useRef<RenderAhead | null>(null);
  const [aheadState, setAheadState] = useState<AheadState>({ kind: "idle" });
  // Auto-captions (owner only): after silence detection finishes, transcribe on-device,
  // then render-ahead starts with the captions in it.
  const [autoEditRunning, setAutoEditRunning] = useState(false);
  const [autoEditFinished, setAutoEditFinished] = useState(false);
  const firstClip0 = clips[0];
  const autoEditPossible =
    AUTO_EDIT_ENABLED &&
    !reactingTo &&
    !rootDropId &&
    !draftId &&
    clips.length === 1 &&
    firstClip0?.type === "video" &&
    (firstClip0.durationMs ?? 0) > 0 &&
    (firstClip0.trimStartMs ?? 0) === 0 &&
    !((firstClip0.trimEndMs ?? 0) > 0 && (firstClip0.trimEndMs ?? 0) < (firstClip0.durationMs ?? 0) - 50);
  // Hook trim and filler cuts are planned from the transcript; render-ahead waits for them.
  const [planDone, setPlanDone] = useState(false);
  const captions = useCaptions(
    isDebugOwner(user?.id),
    clips,
    !autoEditRunning && (autoEditFinished || !autoEditPossible),
    editModel?.state.captionStyle,
  );
  const captionOverlaysRef = useRef(captions.overlays);
  captionOverlaysRef.current = captions.overlays;
  useEffect(() => {
    const ahead = new RenderAhead();
    aheadRef.current = ahead;
    const off = ahead.subscribe(setAheadState);
    return () => {
      off();
      ahead.dispose();
      if (aheadRef.current === ahead) aheadRef.current = null;
    };
  }, []);
  useEffect(() => {
    aheadRef.current?.update({
      clips,
      isRoot: !reactingTo && !rootDropId,
      userId: user?.id,
      captions: captions.overlays,
      hold: captions.pending || (isDebugOwner(user?.id) && !!captions.words && !planDone),
    });
  }, [clips, reactingTo, rootDropId, user?.id, captions.overlays, captions.pending, captions.words, planDone]);
  const aheadReady = aheadState.kind === "ready" ? aheadState : null;
  const aheadSignature = aheadRef.current?.signatureOf(clips, captions.overlays) ?? null;
  const aheadMatches = !!aheadReady && aheadReady.signature === aheadSignature;
  // The rendered file plays while it matches the timeline. Selecting a clip is not an edit and does not
  // leave it (see lib/previewSelection.ts); a trim or cut changes the clips, so the render stops matching.
  const previewMode = previewModeFor({ aheadMatches, selectedClipId });
  const previewModeRef = useRef(false);
  previewModeRef.current = previewMode;
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  // Play while the render-ahead is waiting or rendering: do not start the glitchy
  // live playback; wait for the rendered file (or "Play rough preview").
  const [pendingPlay, setPendingPlay] = useState(false);
  const [roughPlay, setRoughPlay] = useState(false);
  const aheadBusy = aheadState.kind === "waiting" || aheadState.kind === "rendering";
  const waitForPreview = aheadBusy && !aheadMatches && selectedClipId === null && !roughPlay;
  const waitForPreviewRef = useRef(false);
  waitForPreviewRef.current = waitForPreview;
  const renderStartedAtRef = useRef(0);
  useEffect(() => {
    if (aheadState.kind === "rendering" && aheadState.progress === 0) renderStartedAtRef.current = Date.now();
  }, [aheadState]);
  useEffect(() => {
    if (waitForPreview && isPlaying) {
      setIsPlaying(false);
      setPendingPlay(true);
    }
  }, [waitForPreview, isPlaying]);
  useEffect(() => {
    if (pendingPlay && !waitForPreview) {
      setPendingPlay(false);
      setIsPlaying(true);
    }
  }, [pendingPlay, waitForPreview]);
  useEffect(() => {
    if (!isPlaying) setRoughPlay(false);
  }, [isPlaying]);
  const playerR = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.timeUpdateEventInterval = 0.05;
  });
  const [positionMs, setPositionMs] = useState<number>(0);
  const pendingSeekRef = useRef<number | null>(null);
  const segmentOffsetRef = useRef<number>(0);
  const activeIndexRef = useRef<number>(0);
  const durationSetRef = useRef<boolean>(false);
  const lastPositionUpdate = useRef<number>(0);
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

    // Use detached expo-video players to load video metadata without
    // rendering a view. Each waits for readyToPlay, reads the duration,
    // then releases the player.
    (async () => {
      try {
        const results = await Promise.all(
          clipsToProbe.map(async (clip) => {
            let player: VideoPlayer | null = null;
            try {
              player = createVideoPlayer({ uri: clip.uri });
              const status = await new Promise<"readyToPlay" | "error" | "timeout">((resolve) => {
                const timeout = setTimeout(() => {
                  sub.remove();
                  resolve("timeout");
                }, 8000);
                const sub = player!.addListener("statusChange", ({ status: s }) => {
                  if (s === "readyToPlay" || s === "error") {
                    clearTimeout(timeout);
                    sub.remove();
                    resolve(s);
                  }
                });
              });
              const dur =
                status === "readyToPlay" && player.status === "readyToPlay"
                  ? Math.round((player.duration || 0) * 1000)
                  : 0;
              return { id: clip.id, durationMs: dur };
            } catch (e) {
              console.warn(`[edit] Duration probe failed for clip ${clip.id.slice(-8)}:`, (e as Error)?.message);
              return { id: clip.id, durationMs: 0 };
            } finally {
              player?.release();
            }
          }),
        );
        if (cancelled) return;
        const valid = results.filter((r) => r.durationMs > 0);
        if (valid.length === 0) return;
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

  const lastSelectionSeekRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedClipId) {
      lastSelectionSeekRef.current = null;
      return;
    }
    const seek = planSelectionSeek({
      clips,
      clipId: selectedClipId,
      activeIndex: activeIndexRef.current,
      previewMode: previewModeRef.current,
      durationOf: effectiveDurationMs,
    });
    if (!seek) return;
    if (seek.kind === "rendered") {
      // Rendered preview: only move the rendered file to the clip's start (output time); no live
      // player, no play-state change, and the render stays valid.
      if (lastSelectionSeekRef.current === selectedClipId) return;
      lastSelectionSeekRef.current = selectedClipId;
      playerR.currentTime = seek.outputMs / 1000;
      setPositionMs(seek.outputMs);
      return;
    }
    segmentOffsetRef.current = seek.outputMs;
    durationSetRef.current = false;
    lastPositionUpdate.current = 0;
    pendingSeekRef.current = seek.sourceMs;
    setActiveIndex(seek.index);
    setIsPlaying(true);
  }, [selectedClipId, clips, playerR]);

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

  // Validate file on disk — skip data: URIs (inline base64, always valid on web)
  useEffect(() => {
    const uri = activeClip?.uri;
    if (!uri) return;

    // Data URIs (data:image/png;base64,...) contain inline data — they're always valid,
    // and expo-file-system can't stat them on web. Skip the disk check entirely.
    // Blob URIs (blob:https://...) are the web picker's output — in-memory data,
    // also unstat-able. Skip them too.
    if (uri.startsWith("data:") || uri.startsWith("blob:")) {
      return;
    }

    getInfoAsync(uri).then((info) => {
      if (!info.exists) {
        console.error(`[edit] videoSource — FILE DOES NOT EXIST: ${uri.slice(0, 80)}`);
      } else if ((info.size ?? 0) === 0) {
        console.error(`[edit] videoSource — FILE IS EMPTY (0 bytes): ${uri.slice(0, 80)}`);
      }
    }).catch((e) => {
      console.error(`[edit] videoSource — could not stat file: ${uri.slice(0, 60)}`, (e as Error)?.message ?? e);
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
  // Bumped on retry so the replace() effects re-fire — see handleVideoLoadError.
  const [videoLoadNonce, setVideoLoadNonce] = useState<number>(0);
  const [videoReady, setVideoReady] = useState<boolean>(false);

  // Preload slot state — the inactive Video loads the upcoming clip so the
  // swap at segment end is instant instead of a cold load.
  const [preloadSource, setPreloadSource] = useState<{ uri: string } | undefined>(undefined);
  const preloadArmedRef = useRef<boolean>(false);
  const preloadReadyRef = useRef<boolean>(false);
  const preloadExpectedUriRef = useRef<string | null>(null);

  // Replace player sources when the active/preload clip changes
  useEffect(() => {
    const target = activeSlot === 0 ? videoSource : preloadSource;
    const targetUri = target?.uri ?? null;
    if (loadedAUriRef.current !== targetUri) {
      loadedAUriRef.current = targetUri;
      let cancelled = false;
      // Wait for the file to be fully written before handing it to the player —
      // recordAsync/picker URIs can still be finalizing at navigation time.
      void (async () => {
        const ready = targetUri ? await waitForFileReady(targetUri) : true;
        if (cancelled) return;
        playerA.replace(ready && target ? { uri: target.uri } : null);
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [activeSlot, videoSource, preloadSource, playerA, videoLoadNonce]);

  useEffect(() => {
    const target = activeSlot === 1 ? videoSource : preloadSource;
    const targetUri = target?.uri ?? null;
    if (loadedBUriRef.current !== targetUri) {
      loadedBUriRef.current = targetUri;
      let cancelled = false;
      void (async () => {
        const ready = targetUri ? await waitForFileReady(targetUri) : true;
        if (cancelled) return;
        playerB.replace(ready && target ? { uri: target.uri } : null);
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [activeSlot, videoSource, preloadSource, playerB, videoLoadNonce]);

  // Playback control (mirrors the old shouldPlay/isMuted props)
  useEffect(() => {
    playerA.muted = activeSlot !== 0;
    if (activeSlot === 0 && isPlaying && videoReady && !previewMode) {
      playerA.play();
    } else {
      playerA.pause();
    }
    playerB.muted = activeSlot !== 1;
    if (activeSlot === 1 && isPlaying && videoReady && !previewMode) {
      playerB.play();
    } else {
      playerB.pause();
    }
  }, [playerA, playerB, activeSlot, isPlaying, videoReady, previewMode]);

  // Rendered-file preview: load/unload the file, play or pause it with the editor's
  // play state, and report its position (= output time) as the playhead.
  const previewUriRef = useRef<string | null>(null);
  const positionMsRef = useRef(0);
  positionMsRef.current = positionMs;
  const previewUri = previewMode ? aheadReady!.uri : null;
  useEffect(() => {
    if (previewUri) {
      if (previewUriRef.current !== previewUri) {
        previewUriRef.current = previewUri;
        playerR.replace({ uri: previewUri });
      }
      playerR.loop = true;
      playerR.currentTime = Math.max(0, positionMsRef.current) / 1000;
    } else if (previewUriRef.current) {
      previewUriRef.current = null;
      playerR.pause();
      playerR.replace(null);
    }
  }, [previewUri, playerR]);
  useEffect(() => {
    if (!previewMode) return;
    if (playerR.muted) playerR.muted = false;
    if (isPlaying) {
      if (!playerR.playing) playerR.play();
    } else {
      playerR.pause();
    }
  }, [previewMode, isPlaying, playerR]);
  const lastPreviewPosRef = useRef(0);
  useVideoStatusFeed(playerR, {
    onStatus: (s) => {
      if (!previewModeRef.current || !s.isLoaded) return;
      const now = Date.now();
      if (now - lastPreviewPosRef.current < 100) return;
      lastPreviewPosRef.current = now;
      setPositionMs(s.positionMillis);
    },
  });

  // Reset playback state whenever the Video component remounts due to an edit
  // (videoKey bump or activeClip.uri change) — prevents auto-play stutter on load.
  const activeClipUri = activeClip?.uri ?? null;
  useEffect(() => {
    if (hotSwapRef.current) {
      return; // hot swap: keep playing, next clip is ready
    }
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
      errorMsg.includes("not supported") ||
      // expo-video's native loader error — the old expo-av classifier didn't
      // match this string, so every player-open failure skipped the retry.
      errorMsg.includes("Cannot Open") ||
      errorMsg.includes("Failed to load the player item");
    if (isAssetError && videoRetryCountRef.current < maxVideoRetries) {
      videoRetryCountRef.current += 1;
      console.warn(
        `[edit] Video load error (attempt ${videoRetryCountRef.current}/${maxVideoRetries}): ${errorMsg} — retrying...`,
      );
      setVideoReady(false);
      setTimeout(() => {
        // Reset the replace() dedupe refs so the swap effects re-fire — under
        // expo-video the persistent player owns the media item, so remounting
        // the Video view (videoKey) alone never re-attempts the load.
        loadedAUriRef.current = null;
        loadedBUriRef.current = null;
        setVideoKey((k) => k + 1);
        setVideoLoadNonce((n) => n + 1);
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
  const onVideoStatus = useCallback((status: VideoPlaybackStatus) => {
    // Error variant has isLoaded=false and an optional error field.
    // Check this BEFORE the isLoaded guard so errors aren't silently swallowed.
    if (!status.isLoaded && status.error) {
      console.error("[edit] Video playback error:", status.error);
      handleVideoLoadError(status.error);
      return;
    }

    if (!status.isLoaded) return;

    const sourceDur =
      typeof status.durationMillis === "number" ? status.durationMillis : 0;
    const posMillis = status.positionMillis ?? 0;

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
        if (videoRef.current) videoRef.current.currentTime = sp / 1000;
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
          if (videoRef.current) {
            videoRef.current.currentTime = tStart / 1000;
          }
          safeSeekActiveRef.current = false;
        }
        return;
      }
      if (!safeSeekActiveRef.current && trimSeekDoneRef.current && tStart > 0 && posMillis < tStart - 100) {
        safeSeekActiveRef.current = true;
        if (videoRef.current) {
          videoRef.current.currentTime = tStart / 1000;
        }
        safeSeekActiveRef.current = false;
        return;
      }
      const tEndClamped = tEnd > 0 ? Math.min(tEnd, sourceDur > 0 ? sourceDur : tEnd) : (sourceDur > 0 ? sourceDur : 0);
      if (!safeSeekActiveRef.current && trimSeekDoneRef.current && tEndClamped > 0 && posMillis > tEndClamped + 150) {
        safeSeekActiveRef.current = true;
        trimEndHandledRef.current = true;
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.currentTime = tStart / 1000;
          videoRef.current.muted = false;
        }
        safeSeekActiveRef.current = false;
        trimEndHandledRef.current = false;
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
      status.positionMillis >= effectiveTrimEnd - (hasSharedClipUrisRef.current ? 60 : 120)
    ) {
      trimEndHandledRef.current = true;
      if (isIsolatedRef.current) {
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.currentTime = trimStartRef.current / 1000;
          videoRef.current.muted = false;
        }
        trimEndHandledRef.current = false;
      } else if (clipsRef.current.length === 1) {
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.currentTime = trimStartRef.current / 1000;
          videoRef.current.muted = false;
        }
        trimEndHandledRef.current = false;
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
        if (videoRef.current) {
          videoRef.current.currentTime = tStart / 1000;
          videoRef.current.play();
        }
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
  const onPreloadLoad = useCallback((slot: 0 | 1, loaded: boolean, hadError: boolean) => {
    if (loaded) {
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
        vRef.currentTime = trimStart / 1000;
        preloadReadyRef.current = true;
      } else {
        preloadReadyRef.current = true;
      }
    } else if (hadError) {
      preloadReadyRef.current = false;
    }
  }, []);

  // Per-slot dispatch: only the active slot runs the full playback logic; the
  // inactive slot just updates preload readiness.
  const onStatusSlot0 = useCallback(
    (s: VideoPlaybackStatus) => { if (activeSlotRef.current === 0) onVideoStatus(s); },
    [onVideoStatus],
  );
  const onStatusSlot1 = useCallback(
    (s: VideoPlaybackStatus) => { if (activeSlotRef.current === 1) onVideoStatus(s); },
    [onVideoStatus],
  );

  // onReadyForDisplay only drives the active slot's readiness; the inactive
  // slot's readiness is managed solely by onPreloadLoad (+ seek completion)
  // so preloadReadyRef never flips true before the trimStart seek finishes.
  const onReadySlot0 = useCallback(() => {
    if (activeSlotRef.current === 0) setVideoReady(true);
  }, []);
  const onReadySlot1 = useCallback(() => {
    if (activeSlotRef.current === 1) setVideoReady(true);
  }, []);

  const onLoadSlot0 = useCallback((_info: { durationMillis: number }) => {
    if (activeSlotRef.current === 0) {
      videoRetryCountRef.current = 0;
      setVideoLoadError(null);
      setVideoReady(true);
    } else {
      onPreloadLoad(0, true, false);
    }
  }, [onPreloadLoad]);
  const onLoadSlot1 = useCallback((_info: { durationMillis: number }) => {
    if (activeSlotRef.current === 1) {
      videoRetryCountRef.current = 0;
      setVideoLoadError(null);
      setVideoReady(true);
    } else {
      onPreloadLoad(1, true, false);
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

  // expo-video player event feeds → per-slot status handlers
  useVideoStatusFeed(playerA, {
    onStatus: onStatusSlot0,
    onLoad: onLoadSlot0,
    onError: onErrorSlot0,
  });
  useVideoStatusFeed(playerB, {
    onStatus: onStatusSlot1,
    onLoad: onLoadSlot1,
    onError: onErrorSlot1,
  });

  // Re-entrancy guard: prevents advanceToNextClip from being called again
  // before the new clip has started playing. The old player can fire stale
  // didJustFinish/status events after the source changes, causing cascading
  // advances that skip clips.
  const isAdvancingRef = useRef<boolean>(false);

  /**
   * Guard time after a clip change: `maxMs`, but never longer than half of the
   * shortest kept piece (minimum 60 ms), so pieces of 350 ms or more are
   * handled on time.
   */
  const seamGuardMs = (maxMs: number): number => {
    let shortest = Infinity;
    for (const c of clipsRef.current) shortest = Math.min(shortest, effectiveDurationMs(c));
    return Math.max(60, Math.min(maxMs, shortest / 2));
  };

  const advanceToNextClip = useCallback(() => {
    if (isAdvancingRef.current) {
      return;
    }
    isAdvancingRef.current = true;
    // Safety-net: release the guard after 500ms so a legitimate future advance
    // is never permanently blocked. All stale events from the old player fire
    // within this window.
    setTimeout(() => {
      if (isAdvancingRef.current) {
        isAdvancingRef.current = false;
      }
    }, seamGuardMs(500));

    const selIdx = selectedClipIdxRef.current;
    if (isIsolatedRef.current && selIdx >= 0 && selIdx < clipsRef.current.length && selIdx === activeIndexRef.current) {
      // Auto-loop: restart the selected clip instead of stopping
      isAdvancingRef.current = false;
      setIsPlaying(true);
      const clip = clipsRef.current[selIdx];
      const tStart = clip?.trimStartMs ?? 0;
      if (videoRef.current) {
        videoRef.current.currentTime = tStart / 1000;
        videoRef.current.play();
      }
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

      if (
        !sameUri &&
        nextClip?.type === "video" &&
        preloadReadyRef.current &&
        preloadExpectedUriRef.current === nextClip?.uri
      ) {
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

        if (incomingVideo) incomingVideo.muted = false;
        // ALWAYS seek to trimStart (or 0) before playing — the preload slot may
        // have inherited a stale position from a previous clip. Without this
        // seek, the new clip can start near its end and freeze.
        const seekTarget = trimStartRef.current;
        if (incomingVideo) {
          incomingVideo.currentTime = seekTarget / 1000;
          incomingVideo.play();
        }
        // Reset trimEndHandledRef after the seek so the
        // end-of-segment check can fire for the new clip. It was set to
        // true above to block stale didJustFinish from the old player.
        trimEndHandledRef.current = false;
        return;
      }

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
          if (videoRef.current) {
            videoRef.current.currentTime = arrivingTrimStart / 1000;
          }
          safeSeekActiveRef.current = false;
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
      }

      // Reset trimEndHandledRef after a short delay so the end-of-segment
      // check can fire for the new clip. It was set to true above to block
      // stale didJustFinish from the old player.
      setTimeout(() => {
        trimEndHandledRef.current = false;
      }, seamGuardMs(300));

      activeIndexRef.current = nextIdx;
      setActiveIndex(nextIdx);
      setPositionMs(segmentOffsetRef.current);
      setIsPlaying(true);
    } else {
      const firstClip = currentClips[0];
      const sameUri =
        currentPlayingClipUriRef.current === (firstClip?.uri ?? null);

      // Hot swap for the wrap-around (last clip → first clip).
      if (
        !sameUri &&
        firstClip?.type === "video" &&
        preloadReadyRef.current &&
        preloadExpectedUriRef.current === firstClip?.uri
      ) {
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

        if (incomingVideo) incomingVideo.muted = false;
        // ALWAYS seek to trimStart (or 0) before playing — same reason as
        // forward hot-swap: preload slot may have a stale position.
        const wrapSeekTarget = trimStartRef.current;
        if (incomingVideo) {
          incomingVideo.currentTime = wrapSeekTarget / 1000;
          incomingVideo.play();
        }
        trimEndHandledRef.current = false;
        return;
      }

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
        if (videoRef.current) {
          videoRef.current.currentTime = seekTarget / 1000;
          videoRef.current.play();
        }
      } else {
        // Different URI: set a pending seek so onVideoStatus seeks to
        // trimStart (or 0) once the new source loads.
        currentPlayingClipUriRef.current = firstClip?.uri ?? null;
        pendingSeekRef.current = seekTarget;
        lastPositionUpdate.current = 0;
        trimSeekDoneRef.current = false;
        durationSetRef.current = false;
      }

      // Reset trimEndHandledRef after a short delay so the end-of-segment
      // check can fire for the new clip.
      setTimeout(() => {
        trimEndHandledRef.current = false;
      }, seamGuardMs(300));

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
      if (videoRef.current) videoRef.current.currentTime = sourcePos / 1000;
      setIsPlaying(false);
      setPositionMs(targetMs);
    }
  }, []);

  // In rendered-file preview a seek moves that one player; otherwise the live seek.
  const handleSeekAny = useCallback(
    (targetMs: number) => {
      if (previewModeRef.current) {
        playerR.currentTime = Math.max(0, targetMs) / 1000;
        setPositionMs(targetMs);
        setIsPlaying(false);
      } else {
        handleSeek(targetMs);
      }
    },
    [handleSeek, playerR],
  );

  // Leaving rendered-file preview (an edit, or a clip selected): put the live
  // players at the same output time and keep the play state.
  const wasPreviewRef = useRef(false);
  useEffect(() => {
    if (!previewMode && wasPreviewRef.current) {
      const pos = positionMsRef.current;
      const was = isPlayingRef.current;
      handleSeek(pos);
      setTimeout(() => setIsPlaying(was), 60);
    }
    wasPreviewRef.current = previewMode;
  }, [previewMode, handleSeek]);

  const togglePlay = useCallback(() => {
    if (pendingPlay) {
      setPendingPlay(false);
      return;
    }
    if (!isPlaying && waitForPreviewRef.current) {
      setPendingPlay(true);
      return;
    }
    if (previewModeRef.current) {
      setIsPlaying((p) => !p);
      return;
    }
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
  }, [activeClip, isPlaying, pendingPlay, selectedClipId, isTrimmed, displayPosition, totalDurationMs, handleSeek]);

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
          // Figure out which slot is inactive right now.
          const inactiveSlot: 0 | 1 =
            activeSlotRef.current === 0 ? 1 : 0;
          const vRef =
            inactiveSlot === 0 ? videoRefA.current : videoRefB.current;
          if (vRef) {
            preloadReadyRef.current = false; // block hot-swap until seek done
            vRef.currentTime = newTrimStart / 1000;
            preloadReadyRef.current = true;
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
      if (navigation.canGoBack()) {
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

  // ── Auto-edit: background silence analysis ───────────────────────────
  // Root posts only, one untrimmed video clip, once per editor session. Never
  // blocks the editor or Post; every failure is log-only.
  // 0-1 while the post is being rendered; null otherwise.
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [autoEditNote, setAutoEditNote] = useState<string | null>(null);
  // Set once auto-edit changed the timeline. The bar's mode is derived from the
  // live clips, so undo/redo and manual edits need no extra bookkeeping.
  const [autoEditSession, setAutoEditSession] = useState<{
    original: DraftClip;
    originalSig: string;
    producedSig: string;
    savedMs: number;
    /** What produced the current clips, so Review can reopen exactly there. */
    sensitivity: Sensitivity;
    cutEnabled: boolean[];
    analysisDurationMs: number;
  } | null>(null);
  const autoEditWindowsRef = useRef<number[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewSens, setReviewSens] = useState<Sensitivity>("normal");
  const [reviewEnabled, setReviewEnabled] = useState<boolean[]>([]);
  const uploadingRef = useRef(false);
  useEffect(() => { uploadingRef.current = uploading; }, [uploading]);

  // Swap the whole clip list (same playback reset as undo/redo, text untouched).
  const replaceClips = useCallback((next: DraftClip[]) => {
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
    setPositionMs(0);
    setIsPlaying(true);
    trimNeedsSnapshotRef.current = false;
  }, []);

  // Back to the original clip (one undoable step); text overlays are kept.
  const handleUseOriginal = useCallback(() => {
    if (!autoEditSession) return;
    pushSnapshot(clips, textOverlays);
    replaceClips([autoEditSession.original]);
  }, [autoEditSession, clips, textOverlays, pushSnapshot, replaceClips]);

  // Review: re-runs detectSilences on the windows kept in memory (no file read).
  const reviewPlan = useMemo(() => {
    if (!reviewOpen || !autoEditSession) return null;
    return planSilenceTrim(
      { uri: autoEditSession.original.uri, durationMs: autoEditSession.analysisDurationMs },
      autoEditWindowsRef.current,
      SENSITIVITY_PRESETS[reviewSens],
    );
  }, [reviewOpen, autoEditSession, reviewSens]);

  // The Review sheet's switches from the decision model: a cut the user reverted
  // earlier stays off, even when the sensitivity moves its edges.
  const reviewEnabledFor = useCallback(
    (sens: Sensitivity, session: NonNullable<typeof autoEditSession>): boolean[] => {
      const plan = planSilenceTrim(
        { uri: session.original.uri, durationMs: session.analysisDurationMs },
        autoEditWindowsRef.current,
        SENSITIVITY_PRESETS[sens],
      );
      const model = editStateRef.current;
      if (!model) return plan.detection.cuts.map(() => true);
      const { resolved } = mergePlan(model.state, silenceCutsFromDetection(plan.detection), ["silenceCut"]);
      return resolved.map((d) => d.state === "applied");
    },
    [],
  );

  const handleOpenReview = useCallback(() => {
    if (!autoEditSession) return;
    setReviewSens(autoEditSession.sensitivity);
    setReviewEnabled(
      editStateRef.current ? reviewEnabledFor(autoEditSession.sensitivity, autoEditSession) : autoEditSession.cutEnabled,
    );
    setReviewOpen(true);
  }, [autoEditSession, reviewEnabledFor]);

  const handleReviewSensitivity = useCallback(
    (value: Sensitivity) => {
      if (!autoEditSession) return;
      setAutoEditSensitivity(value);
      const plan = planSilenceTrim(
        { uri: autoEditSession.original.uri, durationMs: autoEditSession.analysisDurationMs },
        autoEditWindowsRef.current,
        SENSITIVITY_PRESETS[value],
      );
      setReviewSens(value);
      setReviewEnabled(
        editStateRef.current ? reviewEnabledFor(value, autoEditSession) : plan.detection.cuts.map(() => true),
      );
    },
    [autoEditSession, reviewEnabledFor],
  );

  const handleReviewToggle = useCallback((index: number, value: boolean) => {
    setReviewEnabled((prev) => prev.map((v, i) => (i === index ? value : v)));
  }, []);

  const handleReviewDone = useCallback(() => {
    setReviewOpen(false);
    if (!autoEditSession || !reviewPlan) return;
    const { original } = autoEditSession;
    // Each switch is one decision; the render is derived from the model. Without a
    // model (should not happen) the detector's ranges are used as before.
    const model = editStateRef.current;
    let keepClips = keepRangesToClips(
      original.uri,
      mergeKeepRanges(reviewPlan.detection.keepRanges, reviewEnabled, reviewPlan.detection.cuts),
    );
    if (model) {
      const merged = mergePlan(model.state, silenceCutsFromDetection(reviewPlan.detection), ["silenceCut"]);
      const states: Record<string, "applied" | "reverted"> = {};
      merged.resolved.forEach((d, i) => {
        states[d.id] = reviewEnabled[i] ? "applied" : "reverted";
      });
      const next = setStates(merged.state, states);
      if (JSON.stringify(next) !== JSON.stringify(model.state)) {
        historyRef.current = pushEdit(historyRef.current, model.state);
        setHistoryTick((n) => n + 1);
      }
      setEditModel({ state: next, durationMs: model.durationMs });
      keepClips = renderClipsOf(next, model.durationMs);
    }
    const produced = keepClips.map((c) => ({
      ...original,
      id: newClipId(),
      trimStartMs: c.trimStartMs,
      trimEndMs: c.trimEndMs,
    }));
    const producedSig = clipsSignature(produced);
    if (producedSig !== clipsSignature(clips)) {
      pushSnapshot(clips, textOverlays);
      aheadRef.current?.startNextImmediately();
      replaceClips(produced);
    }
    setAutoEditSession({
      ...autoEditSession,
      producedSig,
      savedMs: reviewPlan.detection.cuts.reduce(
        (sum, c, i) => sum + (reviewEnabled[i] ? c.lengthMs : 0),
        0,
      ),
      sensitivity: reviewSens,
      cutEnabled: reviewEnabled,
    });
  }, [autoEditSession, reviewPlan, reviewEnabled, reviewSens, clips, textOverlays, pushSnapshot, replaceClips]);

  const autoBarMode = useMemo<"auto" | "manual" | null>(() => {
    if (!autoEditSession) return null;
    const sig = clipsSignature(clips);
    if (sig === autoEditSession.producedSig) return "auto";
    return sig === autoEditSession.originalSig ? null : "manual";
  }, [autoEditSession, clips]);
  const autoEditStartedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!AUTO_EDIT_ENABLED || autoEditStartedRef.current) return;
    if (reactingTo || rootDropId || draftId) return;
    if (AUTO_TRIM_OWNER_ONLY && (!user?.id || user.id !== OWNER_USER_ID)) return;
    const clip = clips.length === 1 ? clips[0] : undefined;
    if (!clip || clip.type !== "video" || !(clip.durationMs && clip.durationMs > 0)) return;
    const trimEnd = clip.trimEndMs ?? 0;
    if ((clip.trimStartMs ?? 0) > 0 || (trimEnd > 0 && trimEnd < clip.durationMs - 50)) return;

    autoEditStartedRef.current = true;
    (async () => {
      if (!(await getAutoEditEnabled())) return;
      if (mountedRef.current) setAutoEditRunning(true);
      const sensitivity = await getAutoEditSensitivity();
      const result = await autoEdit(
        { uri: clip.uri, durationMs: clip.durationMs! },
        SENSITIVITY_PRESETS[sensitivity],
        (uri) => analysis.loudness(uri),
      );
      console.log("[edit] autoEdit result:", result.changed ? "changed" : result.reason);
      if (
        mountedRef.current &&
        !result.changed &&
        (result.reason === "nothing_found" || result.reason === "no_audio")
      ) {
        setAutoEditNote("No long pauses found");
        setTimeout(() => {
          if (mountedRef.current) setAutoEditNote(null);
        }, 3000);
      }
      if (!mountedRef.current || !result.changed || uploadingRef.current) return;
      // Only apply if the user hasn't touched the clip meanwhile.
      const current = clipsForUndoRef.current;
      if (current.length !== 1 || clipsSignature(current) !== clipsSignature([clip])) return;
      const original = { ...current[0]!, trimStartMs: 0, trimEndMs: current[0]!.trimEndMs || clip.durationMs };
      // The render comes from the decision model: every silence cut is one decision.
      const modelState = newEditState(clip.uri, silenceCutsFromDetection(result.detection));
      setEditModel({ state: modelState, durationMs: result.durationMs });
      const derived = renderClipsOf(modelState, result.durationMs);
      if (__DEV__ && JSON.stringify(derived) !== JSON.stringify(result.clips)) {
        console.warn("[edit] decision model and silence detector disagree");
      }
      const produced = derived.map((c) => ({
        ...original,
        id: newClipId(),
        trimStartMs: c.trimStartMs,
        trimEndMs: c.trimEndMs,
      }));
      pushSnapshot(current, textOverlaysForUndoRef.current);
      aheadRef.current?.startNextImmediately();
      replaceClips(produced);
      autoEditWindowsRef.current = result.windows;
      setAutoEditSession({
        original,
        originalSig: clipsSignature(current),
        producedSig: clipsSignature(produced),
        savedMs: result.detection.savedMs,
        sensitivity,
        cutEnabled: result.detection.cuts.map(() => true),
        analysisDurationMs: result.durationMs,
      });
    })()
      .catch((e) => console.warn("[edit] autoEdit failed", (e as Error)?.message ?? e))
      .finally(() => {
        if (mountedRef.current) {
          setAutoEditRunning(false);
          setAutoEditFinished(true);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, user?.id, reactingTo, rootDropId, draftId]);

  // ── AI edits panel, timeline markers, undo/redo (lib/autoEdit/) ───────────────
  const isOwnerAccount = isDebugOwner(user?.id);
  // Markers and the panel's counts describe the model; they are drawn only while the
  // timeline still is what the model renders (no hand edits since).
  const modelInSync = useMemo(
    () =>
      !!editModel &&
      clips.length > 0 &&
      sameRanges(clips, renderClipsOf(editModel.state, editModel.durationMs), editModel.durationMs, 60),
    [editModel, clips],
  );
  // Temporary: the AI edits button, panel and cut markers are for internal testers only.
  const aiEditsEnabled = isInternalTester(user?.id);
  const timelineMarkers = useMemo<TimelineMarker[]>(() => {
    if (!aiEditsEnabled || !editModel || !modelInSync) return [];
    const cuts = buildCutMarkers(editModel.state, editModel.durationMs);
    if (!isOwnerAccount || !aiDebug) return cuts;
    const rendered = renderClipsOf(editModel.state, editModel.durationMs);
    return [
      ...cuts,
      ...buildDebugMarkers(
        aiDebug.proposals,
        aiDebug.candidates,
        rendered,
        editModel.state.sourceUri,
        editModel.state.decisions.filter((d) => d.type === "umCut"),
      ),
    ];
  }, [aiEditsEnabled, editModel, modelInSync, isOwnerAccount, aiDebug]);
  const protectionBands = useMemo(() => {
    if (!aiEditsEnabled || !editModel || !modelInSync) return [];
    const rendered = renderClipsOf(editModel.state, editModel.durationMs);
    return mapNonCutDecisions(editModel.state, rendered)
      .filter((m) => m.decision.type === "laughProtect")
      .flatMap((m) => m.pieces);
  }, [aiEditsEnabled, editModel, modelInSync]);
  const panelRows = useMemo<CategoryRow[]>(
    () =>
      editModel
        ? categoryRows(editModel.state, {
            owner: isOwnerAccount,
            captionLines: captions.lines.length,
            captionsOn: captions.captionsOn,
          })
        : [],
    [editModel, isOwnerAccount, captions.lines.length, captions.captionsOn],
  );

  // Show a new decision state: render again from the model and keep the playhead on
  // the same footage (output time -> source time -> new output time), never back at 0.
  const commitDecisions = useCallback(
    (next: EditState) => {
      const model = editStateRef.current;
      if (!model) return;
      setEditModel({ state: next, durationMs: model.durationMs });
      const derived = renderClipsOf(next, model.durationMs);
      const current = clipsForUndoRef.current;
      if (derived.length === 0 || current.length === 0) return;
      if (sameRanges(current, derived, model.durationMs, 0)) return;
      const before = current.map((c) => ({
        uri: c.uri,
        trimStartMs: c.trimStartMs ?? 0,
        trimEndMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? model.durationMs),
      }));
      const newPosition = mapOutputPosition(before, derived, positionMsRef.current, next.sourceUri);
      const wasPlaying = isPlayingRef.current;
      const base = current[0]!;
      replaceClips(
        derived.map((c) => ({ ...base, id: newClipId(), trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs })),
      );
      setPositionMs(newPosition);
      setIsPlaying(false);
      setTimeout(() => {
        handleSeek(newPosition);
        if (wasPlaying) setTimeout(() => setIsPlaying(true), 60);
      }, 50);
    },
    [setEditModel, replaceClips, handleSeek],
  );

  // With manual edits the model does not contain, an AI-edit action asks first.
  const guardAction = useCallback((apply: () => void) => {
    const model = editStateRef.current;
    if (!model) return;
    guardManualEdits(
      timelineMatchesState(clipsForUndoRef.current, model.state, model.durationMs),
      (onContinue) =>
        Alert.alert("AI edit", MANUAL_EDIT_CONFIRM_MESSAGE, [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: onContinue },
        ]),
      apply,
    );
  }, []);

  // A creator action: one undo step, then show it.
  const userEdit = useCallback(
    (produce: (s: EditState) => EditState) => {
      guardAction(() => {
        const model = editStateRef.current;
        if (!model) return;
        const next = produce(model.state);
        if (next === model.state) return;
        historyRef.current = pushEdit(historyRef.current, model.state);
        setHistoryTick((n) => n + 1);
        commitDecisions(next);
      });
    },
    [commitDecisions, guardAction],
  );

  // The creator dragged or pinched the caption: one undo step, every caption follows. Not an AI edit,
  // so no confirmation; the render picks it up after the usual caption debounce.
  const handleCaptionStyleCommit = useCallback(
    (style: CaptionStyle) => {
      const model = editStateRef.current;
      if (!model) return;
      const next = setCaptionStyle(model.state, style);
      if (next === model.state) return;
      historyRef.current = pushEdit(historyRef.current, model.state);
      setHistoryTick((n) => n + 1);
      setEditModel({ state: next, durationMs: model.durationMs });
    },
    [setEditModel],
  );

  const handleUndoDecisions = useCallback(() => {
    guardAction(() => {
      const model = editStateRef.current;
      if (!model) return;
      const r = undoEdit(historyRef.current, model.state);
      if (!r) return;
      historyRef.current = r.history;
      setHistoryTick((n) => n + 1);
      commitDecisions(r.state);
    });
  }, [commitDecisions, guardAction]);

  const handleRedoDecisions = useCallback(() => {
    guardAction(() => {
      const model = editStateRef.current;
      if (!model) return;
      const r = redoEdit(historyRef.current, model.state);
      if (!r) return;
      historyRef.current = r.history;
      setHistoryTick((n) => n + 1);
      commitDecisions(r.state);
    });
  }, [commitDecisions, guardAction]);

  const handleToggleCategory = useCallback(
    (row: CategoryRow, value: boolean) => {
      if (row.id === "captions") captions.setCaptionsOn(value);
      else userEdit((s) => setCategoryEnabled(s, row.type, value));
    },
    [userEdit, captions],
  );

  // Reset to AI edit: plan again from the cached analysis (no file read, no recognizer).
  const handleResetAi = useCallback(async () => {
    const model = editStateRef.current;
    if (!model) return;
    const loud = await analysis.loudness(model.state.sourceUri);
    if (!loud) return;
    const sensitivity = await getAutoEditSensitivity();
    const fresh = buildAiEditState({
      uri: model.state.sourceUri,
      durationMs: loud.durationMs,
      windows: loud.windows,
      silenceOptions: SENSITIVITY_PRESETS[sensitivity],
      words: isOwnerAccount ? captions.words : null,
      removedWords: captions.removedWords,
    });
    userEdit(() => fresh);
    if (isOwnerAccount) captions.setCaptionsOn(true);
  }, [userEdit, isOwnerAccount, captions]);

  const handleOriginalVideo = useCallback(() => {
    userEdit(allCategoriesOff);
    if (isOwnerAccount) captions.setCaptionsOn(false);
  }, [userEdit, isOwnerAccount, captions]);

  const handleMarkerPress = useCallback(
    (marker: TimelineMarker) => {
      if (marker.kind === "proposal" || marker.kind === "filler2" || marker.kind === "laugh" || marker.kind === "um") {
        handleSeekAny(Math.max(0, marker.outputMs - 1000));
      }
      setMarkerSheet(marker);
    },
    [handleSeekAny],
  );

  // Owner: forget everything cached for this clip and analyse it again (transcript, loudness).
  const handleClearAnalysisCache = useCallback(async () => {
    const model = editStateRef.current;
    const uri = model?.state.sourceUri ?? captions.transcribedUri;
    if (!uri) return;
    const key = await analysis.clear(uri);
    console.log("[analysis] cleared", key);
    setAiDebug(null);
    setPlanDone(false);
    captions.restart();
    setAiPanelOpen(false);
  }, [captions]);

  // "Cut this sound": the creator decides about one method-2 candidate.
  const handleCutSound = useCallback(
    (marker: TimelineMarker) => {
      const sound = aiDebug?.candidates.find((c) => c.startMs === marker.srcStartMs);
      if (!sound) return;
      userEdit((s) => addUserSoundCut(s, sound, editStateRef.current?.durationMs ?? 0));
      setMarkerSheet(null);
    },
    [aiDebug, userEdit],
  );

  const handleShareAiDebug = useCallback(async () => {
    const model = editStateRef.current;
    if (!model) return;
    // The transcript alignment summary: from the planning run, or worked out now from the cached analysis.
    let alignment = aiDebug?.alignment ?? null;
    let speechBaselineDb = aiDebug?.speechBaselineDb;
    const words = captions.words;
    const uri = captions.transcribedUri;
    if ((!alignment || speechBaselineDb === undefined) && words && uri) {
      const loud = await analysis.loudness(uri);
      if (loud) {
        const thresholdDb = silenceThresholdDb(loud.windows, 20, loud.durationMs);
        alignment = alignment ?? checkAlignment(loud.windows, 20, words, thresholdDb);
        speechBaselineDb =
          speechBaselineDb ?? speechMedianDb({ windows: loud.windows, windowMs: 20, words, thresholdDb });
      }
    }
    const text = formatAiDebug({
      sourceDurationMs: model.durationMs,
      clips: renderClipsOf(model.state, model.durationMs),
      sourceUri: model.state.sourceUri,
      proposals: aiDebug?.proposals ?? [],
      candidates: aiDebug?.candidates ?? [],
      alignment,
      umReport: aiDebug?.umReport,
      stretched: aiDebug?.stretched,
      adjacent: aiDebug?.adjacent,
      stretches: aiDebug?.stretches,
      protection: protectionReport(model.state),
      userCuts: model.state.decisions.filter((d) => d.type === "umCut" && d.origin === "user"),
      transcription: captions.transcriptionInfo,
      transcriptWords: captions.words,
      speechBaselineDb,
      hookTrims: model.state.decisions.filter((d) => d.type === "hookTrim" && d.state === "applied"),
      fillers: model.state.decisions.filter((d) => d.type === "fillerCut" && d.state === "applied"),
    });
    Share.share({ message: text }).catch(() => {});
  }, [aiDebug, captions.words, captions.transcribedUri, captions.transcriptionInfo]);

  // ── Auto-edit v2 (owner): decisions planned from the transcript ──────────────
  // Hook trim and filler cuts join the decision model (applied, each reversible) and
  // the render is derived again. Unexplained sounds and emphasis moments are only
  // logged. Skipped when the user already edited the timeline by hand.
  useEffect(() => {
    const words = captions.words;
    const uri = captions.transcribedUri;
    if (!isDebugOwner(user?.id) || !words || !uri || planDone) return;
    (async () => {
      try {
        const loud = await analysis.loudness(uri);
        if (!loud || !mountedRef.current) return;
        const durationMs = loud.durationMs;
        const model = editStateRef.current ?? { state: newEditState(uri), durationMs };
        const current = clipsForUndoRef.current;
        const untouched =
          current.length > 0 &&
          current.every((c) => c.uri === uri) &&
          sameRanges(current, renderClipsOf(model.state, model.durationMs), durationMs);

        // Method 2: the 'um' sounds become reversible cuts (category Ums); laughs and
        // unsure sounds are display only.
        const sounds = analyzeUnexplained(loud.windows, 20, durationMs, words, undefined, captions.removedWords);
        const planned = [...planHookTrim(words, durationMs), ...planFillerCuts(words)];
        const afterMethod1 = mergePlan(model.state, planned, ["hookTrim", "fillerCut"]);
        // Laughs are protected first: no cut may remove time inside one.
        const protectPlan = planLaughProtection(sounds);
        const protectedState = mergePlan(afterMethod1.state, protectPlan, ["laughProtect"]);
        const stretchedPlan = planStretchedUms(loud.windows, 20, durationMs, words);
        const umPlan = planUmCuts(protectedState.state, [...sounds, ...blockUmsOverlapping(stretchedPlan.sounds, captions.removedWords)], durationMs);
        const merged = mergePlan(protectedState.state, umPlan.decisions, ["umCut"]);
        // AI planning is not an undo step: saved snapshots are re-planned, not extended.
        historyRef.current = mapHistory(historyRef.current, (snap) =>
          mergePlan(
            mergePlan(mergePlan(snap, planned, ["hookTrim", "fillerCut"]).state, protectPlan, ["laughProtect"]).state,
            umPlan.decisions,
            ["umCut"],
          ).state,
        );
        setEditModel({ state: merged.state, durationMs });

        const derived = renderClipsOf(merged.state, durationMs);
        if (untouched && !uploadingRef.current && derived.length > 0 && !sameRanges(current, derived, durationMs, 0)) {
          const base = current[0]!;
          const produced = derived.map((c) => ({
            ...base,
            id: newClipId(),
            trimStartMs: c.trimStartMs,
            trimEndMs: c.trimEndMs,
          }));
          pushSnapshot(current, textOverlaysForUndoRef.current);
          aheadRef.current?.startNextImmediately();
          replaceClips(produced);
          const keptMs = derived.reduce((sum, c) => sum + (c.trimEndMs - c.trimStartMs), 0);
          setAutoEditSession((prev) =>
            prev
              ? { ...prev, producedSig: clipsSignature(produced), savedMs: Math.max(0, prev.analysisDurationMs - keptMs) }
              : prev,
          );
        }

        // After classification: confirmed laughs join the emphasis signals. The loudness
        // baseline skips silence and the footage the edit removes.
        const thresholdDb = silenceThresholdDb(loud.windows, 20, durationMs);
        const candidates = sounds;
        const proposals = planEmphasis({
          windows: loud.windows,
          windowMs: 20,
          words,
          durationMs,
          laughs: sounds.filter((s) => s.cls === "laugh"),
          silenceThresholdDb: thresholdDb,
          cuts: appliedCutRanges(merged.state),
        });
        const adjacent = analyzeAdjacent(loud.windows, 20, words, thresholdDb, speechMedianDb({ windows: loud.windows, windowMs: 20, words, thresholdDb })).findings;
        const alignment = checkAlignment(loud.windows, 20, words, thresholdDb);
        const speechBaselineDb = speechMedianDb({ windows: loud.windows, windowMs: 20, words, thresholdDb });
        console.log("[timeline]", JSON.stringify({ alignment, speechBaselineDb, thresholdDb }));
        console.log("[fillers] method2:", JSON.stringify(candidates));
        console.log(
          "[emphasis]",
          JSON.stringify(emphasisLogEntries(proposals, renderClipsOf(merged.state, durationMs), uri)),
        );
        console.log("[ums]", JSON.stringify(umPlan.report));
        console.log("[stretched]", JSON.stringify(stretchedPlan.report.words.map((s) => [s.text, s.durationMs, Math.round(s.expectedMs), s.dipFound, s.cut ?? null])));
        setAiDebug({ proposals, candidates, alignment, speechBaselineDb, umReport: umPlan.report, stretched: stretchedPlan.report, adjacent, stretches: nonWordStretchReport(loud.windows, 20, durationMs, words) });
      } catch (e) {
        console.warn("[edit] hook/filler planning failed", (e as Error)?.message ?? e);
      } finally {
        if (mountedRef.current) setPlanDone(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captions.words, captions.transcribedUri, planDone, user?.id]);

  // ── Thumbnail generation helper ────────────────────────────────────────────

  const generateThumbnail = useCallback(async (videoUri: string, timeMs = 0): Promise<string | null> => {
    try {
      const result = await getThumbnailAsync(videoUri, { time: timeMs });
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
      const thumbnailUri = firstVideo ? await generateThumbnail(firstVideo.uri, firstVideo.trimStartMs ?? 0) : null;
      if (firstVideo) {
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
              // clip copied & verified
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

      // The decisions behind the clips, only while they still match (no hand edits since).
      const model = editStateRef.current;
      const sourceUri = permanentClips[0]?.uri;
      const savedEditState =
        model &&
        sourceUri &&
        permanentClips.every((c) => c.uri === sourceUri) &&
        sameRanges(permanentClips, renderClipsOf(model.state, model.durationMs), model.durationMs)
          ? {
              state: { ...model.state, sourceUri },
              durationMs: model.durationMs,
              clipsSig: clipsSignature(permanentClips),
            }
          : undefined;
      const project: DraftProject = {
        id: draftIdFinal,
        clips: permanentClips,
        editState: savedEditState,
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
        } else if (navigation.canGoBack()) {
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
      setError(null);
      setSuccess(null);
      setUploading(true);

      // ── Pause the video IMMEDIATELY before any upload work begins ───
      setIsPlaying(false);
      try {
        videoRef.current?.pause();
      } catch {
        // Best-effort — continue with upload regardless
      }

      const primary = clips[0]!;

      // ── 1. Copy all clip files to a stable permanent location ────────
      const stableDir = `${documentDirectory}post_uploads/`;
      await makeDirectoryAsync(stableDir, { intermediates: true });

      const isWeb = Platform.OS === "web";

      // Render-at-post: ROOT posts only (never reactions), and only when the
      // timeline has cuts. Any problem (or Cancel) leaves `rendered` null and the
      // post goes out the old way. A blocking "Preparing your video..." overlay
      // with progress and Cancel is shown while it runs.
      const skipReason = renderSkipReason({
        isRoot: !reactingTo && !rootDropId,
        userId: user?.id,
        clips,
      });
      if (__DEV__) console.log("[edit] render at post:", skipReason ?? "yes");
      let rendered: RenderedEdit | null = null;
      // What the internal-tester message says about the render path.
      let renderNote: string = skipReason ? `Not rendered: ${skipReason}` : "";
      if (!skipReason) {
        const ahead = aheadRef.current;
        const signature = ahead?.signatureOf(clips, captionOverlaysRef.current) ?? null;
        const { editMs } = buildRenderEdit(clips);
        let handled = false;

        if (ahead && signature) {
          // 1. A finished render-ahead file for exactly this timeline: use it, no wait.
          const taken = ahead.takeReady(signature);
          if (taken) {
            const info = await getInfoAsync(taken.uri).catch(() => null);
            if (info?.exists && (info.size ?? 0) > 0 && taken.durationMs >= editMs - 300) {
              rendered = { uri: taken.uri, durationMs: taken.durationMs, sizeBytes: taken.sizeBytes };
              renderNote = formatRenderStats({ kind: "ahead", renderMs: taken.renderMs, durationMs: taken.durationMs, sizeBytes: taken.sizeBytes });
            } else {
              await deleteAsync(taken.uri, { idempotent: true }).catch(() => {});
              renderNote = "Not rendered: output too short";
            }
            handled = true;
          } else if (ahead.isRenderingFor(signature)) {
            // 2. One for this timeline is running: wait for it (same overlay, progress,
            //    timeout and Cancel as a render at post time).
            setRenderProgress(0);
            const off = ahead.subscribe((st) => {
              if (st.kind === "rendering") setRenderProgress(st.progress);
            });
            let timedOutWaiting = false;
            const timeout = setTimeout(() => {
              timedOutWaiting = true;
              cancelRender();
            }, renderTimeoutMs(editMs));
            try {
              const outcome = await ahead.waitFor(signature);
              if (outcome.ok) {
                const r = outcome.ready;
                rendered = { uri: r.uri, durationMs: r.durationMs, sizeBytes: r.sizeBytes };
                renderNote = formatRenderStats({ kind: "ahead", renderMs: r.renderMs, durationMs: r.durationMs, sizeBytes: r.sizeBytes });
              } else {
                renderNote = timedOutWaiting
                  ? `Not rendered: timeout after ${Math.round(renderTimeoutMs(editMs) / 1000)} s`
                  : `Not rendered: ${outcome.reason}`;
              }
            } finally {
              clearTimeout(timeout);
              off();
              setRenderProgress(null);
            }
            handled = true;
          }
        }

        if (!handled) {
          // 3. Otherwise exactly as before: stop any render-ahead (one native render
          //    at a time) and render now.
          await ahead?.cancelAndSuspend();
          setRenderProgress(0);
          try {
            const outcome = await renderForPost(clips, setRenderProgress, captionOverlaysRef.current);
            if (outcome.ok) {
              rendered = outcome.edit;
              const stats = { kind: "post" as const, renderMs: outcome.renderMs, durationMs: outcome.edit.durationMs, sizeBytes: outcome.edit.sizeBytes };
              recordRenderStats(stats);
              renderNote = formatRenderStats(stats);
            } else {
              renderNote = `Not rendered: ${outcome.reason}`;
            }
          } finally {
            setRenderProgress(null);
          }
        }
      }
      if (rendered) {
        // Move the render out of the cache into the stable upload folder (the
        // upload runs in the background). If that fails, post the old way.
        const tempRender = rendered.uri;
        try {
          const stableRender = `${stableDir}render_${Date.now()}.mp4`;
          await copyAsync({ from: tempRender, to: stableRender });
          const copied = await getInfoAsync(stableRender);
          if (!copied.exists || (copied.size ?? 0) !== rendered.sizeBytes) {
            throw new Error("copy of the rendered file failed");
          }
          rendered = { ...rendered, uri: stableRender };
          // Save the edited video to the camera roll once, in the background, only
          // if the setting is on and photo permission is ALREADY granted (never
          // prompts here). Raw recordings are saved elsewhere, unchanged.
          void (async () => {
            try {
              if (!(await getSaveEditedToRoll())) return;
              const permission = await getMediaLibrary()?.getPermissionsAsync();
              if (permission?.granted) await saveToLibraryAsync(stableRender);
            } catch (saveErr) {
              if (__DEV__) console.log("[render] camera roll save skipped:", (saveErr as Error)?.message);
            }
          })();
        } catch (copyErr) {
          if (__DEV__) console.log("[render] could not stage the rendered file:", (copyErr as Error)?.message);
          rendered = null;
          renderNote = "Not rendered: render error ERR_STAGE";
        }
        await deleteAsync(tempRender, { idempotent: true }).catch(() => {});
      }

      const copyClip = async (c: (typeof clips)[number], i: number) => {
          // On web there is no real filesystem — data:/blob: URIs hold the
          // bytes in memory and are uploaded directly by createPost.
          if (isWeb && (c.uri.startsWith("data:") || c.uri.startsWith("blob:"))) {
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
          const ext = c.uri.match(/\.(\w+)(?:\?|$)/)?.[1] ?? (c.type === "video" ? "mov" : "jpg");
          const stableUri = `${stableDir}clip_${i}_${Date.now()}.${ext}`;

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
          return { ...c, uri: stableUri };
      };
      // Clips that share a source uri (segments of one recording) are copied
      // once; every such clip then points at the same stable file.
      const copyCache = new Map<string, ReturnType<typeof copyClip>>();
      const copiedClips = rendered ? [] : await Promise.all(
        clips.map(async (c, i) => {
          let pending = copyCache.get(c.uri);
          if (!pending) {
            pending = copyClip(c, i);
            copyCache.set(c.uri, pending);
          }
          return { ...c, uri: (await pending).uri };
        }),
      );

      // A rendered post uploads the rendered file as the ONLY segment (no
      // segments, no trim_data); otherwise the source clips, as before.
      const stablePrimary: DraftClip = rendered
        ? { id: "rendered", uri: rendered.uri, type: "video", trimStartMs: 0 }
        : copiedClips[0]!;

      // ── 2b. Generate cover thumbnail from first video frame ──────────
      let thumbnailUri: string | null = null;
      if (stablePrimary.type === "video") {
        thumbnailUri = await generateThumbnail(stablePrimary.uri, stablePrimary.trimStartMs ?? 0);
      }

      // For multi-clip Drops, upload each segment individually.
      const segmentUris =
        copiedClips.length > 1 ? copiedClips.map((c) => c.uri) : undefined;
      const hasAnyTrim = !rendered && copiedClips.some(
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
        followerVisibility,
        cleanupUri: rendered?.uri,
        // If the rendered file cannot be uploaded: the old way, from the source clips.
        renderedFallback: rendered
          ? {
              uri: clips[0]!.uri,
              segmentUris: clips.length > 1 ? clips.map((c) => c.uri) : undefined,
              trimData: clips.some(
                (c) =>
                  (c.trimStartMs ?? 0) > 0 ||
                  (c.trimEndMs ?? 0) < (c.durationMs ?? Infinity),
              )
                ? clips.map((c) => ({
                    trimStartMs: c.trimStartMs ?? 0,
                    trimEndMs: c.trimEndMs ?? (c.durationMs ?? 0),
                  }))
                : undefined,
            }
          : undefined,
        optimisticTempId: tempId,
        onProgress: (percent: number) => {
          updateOptimisticProgress(tempId, percent);
        },
      });

      // Internal testers: say what the render path did (a fixed-wording message, ~6 s).
      if (renderNote && isInternalTester(user?.id)) reportRender(renderNote);

      // ── 5. Navigate to the right screen (best-effort) ───────────────
      //    Root Drops → feed tab. Reactions & replies → reaction-tree
      //    Wrapped in try/catch so navigation failures are logged but
      //    NEVER prevent the post from being saved.
      const reactionTreeId = rootDropId || reactingTo;
      try {
        try {
          router.dismissAll();
        } catch {
          if (navigation.canGoBack()) router.back();
        }
        if (reactionTreeId) {
          router.replace(`/post/${reactionTreeId}/reaction-tree` as never);
        } else {
          router.replace("/(tabs)");
        }
      } catch (navErr) {
        // Navigation failed but the post IS already saving — log it, don't throw.
        console.warn("[edit] executePost: navigation after post failed (post is still uploading)", (navErr as Error)?.message);
      }

      setSuccess("Posted!");
    } catch (postErr) {
      const errMsg = postErr instanceof Error ? postErr.message : "Could not post. Please try again.";
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
  }, [clips, draftId, textOverlays, isMature, followerVisibility, createPost, addOptimisticPost, updateOptimisticProgress, generateThumbnail, router, reactingTo, rootDropId, user?.id]);

  useEffect(() => { executeSaveDraftRef.current = executeSaveDraft; }, [executeSaveDraft]);

  // handlePostPress calls executePost directly (no ref indirection) so the
  // `clips` closure used at tap time is always the most recent one. Earlier the
  // handler read executePostRef.current, whose sync effect ran after render —
  // so a tap that landed between a trim edit and the effect would invoke a
  // stale executePost closure and silently drop trimmed clips from the upload.
  const handlePostPress = useCallback(() => {
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
      const postPromise = executePost();
      if (!postPromise || typeof postPromise.catch !== "function") {
        console.error("[edit] handlePostPress: executePost did not return a Promise — got", typeof postPromise);
        setError("Something went wrong. Please try again.");
        return;
      }
      postPromise.catch((e: any) => {
        console.error("[edit] handlePostPress: executePost FAILED (fallback)", (e as Error)?.message ?? e);
        // executePost already showed Alert.alert() — just set banner as fallback
        setError(e instanceof Error ? e.message : "Could not post.");
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
        <StatusBar style="dark" />
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
        <StatusBar style="dark" />
        <UiText style={styles.emptyText}>Nothing to preview</UiText>
        <Pressable onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.emptyBtn}>
          <UiText style={styles.emptyBtnText}>Go back</UiText>
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
        <StatusBar style="dark" />

        {/* ── Top bar ────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
            style={styles.topBtn}
          >
            <ArrowLeft size={20} color={theme.text} strokeWidth={2.5} />
          </TouchableOpacity>
          <UiText style={styles.topTitle}>
            {draftId ? "Edit Draft" : "Edit Post"}
          </UiText>
          <View style={styles.topBtnRow}>
            <TouchableOpacity
              onPress={handleUndo}
              disabled={!canUndo}
              style={[styles.topBtn, !canUndo && styles.topBtnOff]}
            >
              <Undo2 size={16} color={theme.text} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleRedo}
              disabled={!canRedo}
              style={[styles.topBtn, !canRedo && styles.topBtnOff]}
            >
              <Redo2 size={16} color={theme.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Preview area ───────────────────────────────────────────── */}
        {isInternalTester(user?.id) && (aheadState.kind === "ready" || aheadState.kind === "waiting" || aheadState.kind === "rendering") && (
          <View style={[styles.aheadChip, { top: insets.top + 62 }]} pointerEvents="none">
            <UiText style={styles.aheadChipText}>
              {aheadMatches
                ? "Preview ready"
                : aheadState.kind === "rendering"
                  ? `Making preview ${Math.round(aheadState.progress * 100)}%`
                  : "Updating preview..."}
            </UiText>
          </View>
        )}
        {isDebugOwner(user?.id) && (
          <Pressable
            onPress={() => captions.setCaptionsOn(!captions.captionsOn)}
            style={[styles.captionToggle, { top: insets.top + 62 }]}
            hitSlop={8}
          >
            <UiText style={styles.aheadChipText}>
              {captions.captionsOn ? (captions.pending ? "Captions: transcribing..." : "Captions: on") : "Captions: off"}
            </UiText>
          </Pressable>
        )}
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
                  <VideoView
                    player={playerA}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      opacity: activeSlot === 0 ? 1 : 0,
                    }}
                    contentFit="contain"
                    nativeControls={false}
                    onFirstFrameRender={onReadySlot0}
                    pointerEvents="none"
                  />
                )}
                {/* Slot B — active when activeSlot === 1, else preloading next clip */}
                {(activeSlot === 1 || preloadSource !== undefined) && (
                  <VideoView
                    player={playerB}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      opacity: activeSlot === 1 ? 1 : 0,
                    }}
                    contentFit="contain"
                    nativeControls={false}
                    onFirstFrameRender={onReadySlot1}
                    pointerEvents="none"
                  />
                )}
                {previewMode && (
                  <VideoView
                    player={playerR}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      top: 0,
                      left: 0,
                    }}
                    contentFit="contain"
                    nativeControls={false}
                    pointerEvents="none"
                  />
                )}
                {videoLoadError && (
                  <View style={styles.videoErrorOverlay}>
                    <UiText style={styles.videoErrorText}>{videoLoadError}</UiText>
                    <Pressable
                      onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
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
                <UiText style={{ color: theme.textDim, fontSize: 13 }}>
                  No preview
                </UiText>
              </View>
            )}

            {/* Play overlay — video only; photos render as a static image */}
            {isVideo && pendingPlay && waitForPreview && (
              <View style={styles.waitOverlay}>
                <ActivityIndicator color="#fff" />
                <UiText style={styles.waitText}>
                  {(() => {
                    if (aheadState.kind !== "rendering" || aheadState.progress < 0.05) return "Making your preview...";
                    const elapsed = Date.now() - renderStartedAtRef.current;
                    const secs = Math.max(1, Math.round((elapsed * (1 - aheadState.progress)) / aheadState.progress / 1000));
                    return `Preview ready in about ${secs} s`;
                  })()}
                </UiText>
                <Pressable
                  onPress={() => {
                    setPendingPlay(false);
                    setRoughPlay(true);
                    setIsPlaying(true);
                  }}
                  hitSlop={8}
                  style={styles.waitRoughBtn}
                >
                  <UiText style={styles.waitRoughText}>Play rough preview</UiText>
                </Pressable>
              </View>
            )}
            {isVideo && !isPlaying && !pendingPlay && (
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

            {isVideo && isDebugOwner(user?.id) && captions.captionsOn && (
              <CaptionPreview
                lines={captions.lines}
                positionMs={displayPosition}
                frameW={frameDims.w}
                frameH={frameDims.h}
                invisible={previewMode}
                style={editModel?.state.captionStyle}
                isPlaying={isPlaying}
                onEditStart={() => setIsPlaying(false)}
                onEdit={captions.editLine}
                onStyleCommit={handleCaptionStyleCommit}
              />
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
        {autoEditRunning && (
          <View style={styles.autoEditRow}>
            <ActivityIndicator size="small" color={theme.textMuted} />
            <UiText style={styles.autoEditText}>Auto-editing...</UiText>
          </View>
        )}
        {autoEditNote && !autoEditRunning && (
          <View style={styles.autoEditRow}>
            <UiText style={styles.autoEditText}>{autoEditNote}</UiText>
          </View>
        )}
        {autoBarMode && autoEditSession && (
          <View style={styles.autoBar}>
            <UiText style={styles.autoBarText}>
              {autoBarMode === "auto"
                ? `${autoEditSession.cutEnabled.filter(Boolean).length} ${
                    autoEditSession.cutEnabled.filter(Boolean).length === 1 ? "cut" : "cuts"
                  }, saved ${(autoEditSession.savedMs / 1000).toFixed(1)} s`
                : "Edited manually"}
            </UiText>
            {autoBarMode === "auto" && (
              <Pressable onPress={handleOpenReview} hitSlop={8}>
                <UiText style={styles.autoBarAction}>Review</UiText>
              </Pressable>
            )}
            <Pressable onPress={handleUseOriginal} hitSlop={8}>
              <UiText style={styles.autoBarAction}>
                {autoBarMode === "auto" ? "Undo" : "Use original"}
              </UiText>
            </Pressable>
          </View>
        )}
        {isVideo && (
          <TimelineEditor
            clips={clips}
            totalDurationMs={totalDurationMs}
            positionMs={displayPosition}
            activeClipIndex={activeIndex}
            selectedClipId={selectedClipId}
            onSeek={handleSeekAny}
            onSelectClip={handleSelectClip}
            onClipUpdate={handleClipUpdate}
            onTrimRelease={handleTrimRelease}
            onDeselectAndPreview={() => handleDeselectAndPreview()}
            onReorderClips={handleReorderClips}
            markers={timelineMarkers}
            onMarkerPress={handleMarkerPress}
            bands={protectionBands}
          />
        )}

        {/* ── Toolbar ────────────────────────────────────────────────── */}
        <View style={styles.toolbar}>
          {/* Trim — video only */}
          {isVideo && (
          <Pressable
            onPress={handleTrim}
            style={[
              styles.toolBtn,
              selectedClipId && styles.toolBtnActive,
            ]}
          >
            <Scissors
              size={18}
              color={selectedClipId ? theme.accent : theme.text}
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
          )}

          {/* Split */}
          <Pressable
            onPress={handleSplitClip}
            disabled={!canSplit}
            style={[styles.toolBtn, !canSplit && styles.toolBtnOff]}
          >
            <Split
              size={18}
              color={
                !canSplit ? theme.textDim : theme.text
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
                  : theme.text
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

          {/* AI edits: every automatic edit, each reversible */}
          {isVideo && editModel && aiEditsEnabled && (
            <Pressable onPress={() => setAiPanelOpen(true)} style={styles.toolBtn}>
              <Sparkles size={18} color={theme.text} />
              <UiText style={styles.toolLabel}>AI edits</UiText>
            </Pressable>
          )}

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
                  ? theme.textDim
                  : theme.text
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
                <RectangleEllipsis size={14} color={theme.text} />
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
                <Pencil size={14} color={theme.text} />
                <UiText style={styles.textActionLabel}>Edit</UiText>
              </Pressable>
              <Pressable
                onPress={handleDuplicateOverlay}
                style={styles.textActionBtn}
              >
                <Type size={14} color={theme.text} />
                <UiText style={styles.textActionLabel}>Duplicate</UiText>
              </Pressable>
              <Pressable
                onPress={() => handleDeleteOverlay()}
                style={[styles.textActionBtn, styles.textActionBtnDanger]}
              >
                <Trash2 size={14} color="#E8291C" />
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
          {!reactingTo && (
            <UiText style={styles.trialNote}>
              On Trial, people who don't know you test your video. If it survives, it's pushed to more people for 24 hours.
            </UiText>
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
                <UiText style={styles.postBtnText}>{reactingTo ? "Post Reaction" : "Post"}</UiText>
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
                  ? "#E8291C"
                  : theme.textDim
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

      <CaptionsExplainer
        visible={captions.explainerVisible}
        onContinue={captions.onContinue}
        onNotNow={captions.onNotNow}
      />

      {/* ── Text overlay editor modal ─────────────────────────────── */}
      {renderProgress !== null && (
        <View style={styles.renderOverlay}>
          <ActivityIndicator color={theme.accent} />
          <UiText style={styles.renderTitle}>Preparing your video...</UiText>
          <View style={styles.renderTrack}>
            <View style={[styles.renderFill, { width: `${Math.round(Math.min(1, renderProgress) * 100)}%` }]} />
          </View>
          <Pressable onPress={cancelRender} hitSlop={10}>
            <UiText style={styles.renderCancel}>Cancel</UiText>
          </Pressable>
        </View>
      )}
      <AiEditsSheet
        visible={aiPanelOpen && !!editModel && aiEditsEnabled}
        rows={panelRows}
        canUndo={canUndoDecisions(historyRef.current)}
        canRedo={canRedoDecisions(historyRef.current)}
        onToggle={handleToggleCategory}
        onUndo={handleUndoDecisions}
        onRedo={handleRedoDecisions}
        onReset={handleResetAi}
        onOriginal={handleOriginalVideo}
        onShareDebug={isOwnerAccount ? handleShareAiDebug : undefined}
        onClearCache={isOwnerAccount ? handleClearAnalysisCache : undefined}
        onClose={() => setAiPanelOpen(false)}
      />
      <MarkerSheet
        marker={markerSheet}
        onRestore={(m) => {
          userEdit((s) => restoreMarker(s, m));
          setMarkerSheet(null);
        }}
        onReapply={(m) => {
          userEdit((s) => reapplyMarker(s, m));
          setMarkerSheet(null);
        }}
        onCutSound={isOwnerAccount ? handleCutSound : undefined}
        onClose={() => setMarkerSheet(null)}
      />
      <AutoEditReviewSheet
        visible={reviewOpen && !!reviewPlan}
        cuts={reviewPlan?.detection.cuts ?? []}
        enabled={reviewEnabled}
        sensitivity={reviewSens}
        onSensitivity={handleReviewSensitivity}
        onToggle={handleReviewToggle}
        onUseOriginal={() => {
          setReviewOpen(false);
          handleUseOriginal();
        }}
        onDone={handleReviewDone}
      />
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
  screen: { flex: 1, backgroundColor: "#F5F3EE" },
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
    borderRadius: 0,
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
    backgroundColor: "#F5F3EE",
  },
  topBtn: {
    width: 38,
    height: 38,
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.07)",
    alignItems: "center",
    justifyContent: "center",
  },
  topTitle: {
    flex: 1,
    color: theme.textMuted,
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
    borderRadius: 0,
    overflow: "hidden",
    backgroundColor: "#F5F3EE",
  },

  // ── Play overlay ──
  playOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  waitOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  waitText: { color: "#fff", fontSize: 14, fontWeight: "700" as const },
  waitRoughBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  waitRoughText: { color: "#fff", fontSize: 12, fontWeight: "700" as const },
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.12)",
  },

  // ── Video error overlay ──
  videoErrorOverlay: {
    ...StyleSheet.absoluteFill,
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
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.1)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.15)",
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
    borderTopColor: "rgba(10,10,10,0.07)",
  },
  toolBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 0,
    minWidth: 60,
  },
  toolBtnActive: {
    backgroundColor: "rgba(232,41,28,0.1)",
  },
  toolBtnOff: {
    opacity: 0.3,
  },
  toolLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
  },
  toolLabelOff: {
    color: theme.textDim,
  },

  // ── Bottom section ──
  bottomSection: {
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(10,10,10,0.05)",
    backgroundColor: "#F5F3EE",
  },
  autoEditRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 6,
  },
  aheadChip: {
    position: "absolute",
    left: 16,
    zIndex: 5,
    backgroundColor: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  captionToggle: {
    position: "absolute",
    right: 16,
    zIndex: 5,
    backgroundColor: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  aheadChipText: { color: "#fff", fontSize: 11, fontWeight: "700" as const },
  renderOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: "rgba(245,243,238,0.96)",
    paddingHorizontal: 40,
  },
  renderTitle: { color: theme.text, fontSize: 16, fontWeight: "800" as const },
  renderTrack: { width: "100%", height: 4, backgroundColor: theme.border },
  renderFill: { height: 4, backgroundColor: theme.accent },
  renderCancel: { color: theme.textMuted, fontSize: 14, fontWeight: "700" as const },
  autoBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(10,10,10,0.07)",
  },
  autoBarText: {
    flex: 1,
    color: theme.text,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  autoBarAction: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: "800" as const,
  },
  autoEditText: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "600" as const,
  },
  bannerError: {
    backgroundColor: "rgba(232,41,28,0.12)",
    borderRadius: 0,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.25)",
  },
  matureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.card,
    borderRadius: 0,
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
    borderRadius: 0,
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
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.08)",
    overflow: "hidden",
  },
  uploadProgressFill: {
    height: "100%" as unknown as number,
    borderRadius: 0,
    backgroundColor: theme.accent,
  },
  uploadProgressText: {
    color: theme.textMuted,
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
    borderRadius: 0,
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
    fontWeight: "900" as const,
    letterSpacing: 0.3,
  },
  trialNote: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
    marginBottom: 8,
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
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.07)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.1)",
  },
  draftBtnText: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },

  // ── Text editing toolbar ──
  textToolbarWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(10,10,10,0.07)",
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
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.07)",
    justifyContent: "center",
  },
  textActionBtnDanger: {
    backgroundColor: "rgba(232,41,28,0.08)",
  },
  textActionLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },
  textActionLabelDanger: {
    color: "#E8291C",
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
    borderTopColor: "rgba(10,10,10,0.08)",
    zIndex: 300,
  },
  trashZoneActive: {
    backgroundColor: "rgba(232,41,28,0.15)",
    borderTopColor: "rgba(232,41,28,0.35)",
  },
  trashLabel: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "700" as const,
  },
  trashLabelActive: {
    color: "#E8291C",
  },
});
