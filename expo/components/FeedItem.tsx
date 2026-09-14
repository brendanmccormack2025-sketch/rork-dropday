import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import {
  Heart,
  Music2,
  Send,
  Sparkles,
  RotateCcw,
  Trash2,
  X,
  AlertCircle,
  Flag,
} from "lucide-react-native";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";

import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { FeedAvatar } from "@/components/Avatar";
import { theme, getDropWindowState } from "@/constants/theme";
import { usePosts, type Post, type TextOverlay, type TextBackgroundStyle } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import { useReportContent } from "@/hooks/useReportContent";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");
const TAB_BAR_HEIGHT = 88;
/** Height reserved for the action buttons + username row at the bottom of each feed item. */
const BOTTOM_OVERLAY_HEIGHT = 130;

/** Assumed aspect ratio (w/h) of video content — matches the editor's ASPECT = 9/16. */
const ASSUMED_VIDEO_ASPECT = 9 / 16;

/**
 * Compute the visible fraction of a video after COVER resize mode crops it
 * to fill a container of different aspect ratio.
 *
 * COVER scales the video so both dimensions >= container, then crops the
 * overflow symmetrically (centered crop).
 *
 * @returns visibleW/visibleH — fraction of the original video that remains
 *          visible; cropLeft/cropTop — fraction cropped off each edge.
 */
function computeCoverCrop(
  containerW: number,
  containerH: number,
  videoAspect: number,
): { visibleW: number; visibleH: number; cropLeft: number; cropTop: number } {
  if (containerW <= 0 || containerH <= 0) {
    return { visibleW: 1, visibleH: 1, cropLeft: 0, cropTop: 0 };
  }
  const containerAspect = containerW / containerH;

  if (videoAspect < containerAspect) {
    // Video is narrower/taller than container → scale to fill width, crop top/bottom
    const scaledVideoH = containerW / videoAspect;
    const visibleH = containerH / scaledVideoH;
    const cropTop = (1 - visibleH) / 2;
    return { visibleW: 1, visibleH, cropLeft: 0, cropTop };
  }
  // Video is wider than container → scale to fill height, crop left/right
  const scaledVideoW = containerH * videoAspect;
  const visibleW = containerW / scaledVideoW;
  const cropLeft = (1 - visibleW) / 2;
  return { visibleW, visibleH: 1, cropLeft, cropTop: 0 };
}

function ActionButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.actionBtn} hitSlop={8}>
      {icon}
      <UiText style={styles.actionLabel}>{label}</UiText>
    </Pressable>
  );
}

/** Resolve background style preset to colors for feed rendering. */
function resolveFeedBg(
  style: TextBackgroundStyle,
  accentColor: string,
): { backgroundColor: string; color: string } {
  switch (style) {
    case "none-white":
      return { backgroundColor: "transparent", color: "#FFFFFF" };
    case "none-black":
      return { backgroundColor: "transparent", color: "#000000" };
    case "white-box":
      return { backgroundColor: "#FFFFFF", color: "#000000" };
    case "black-box":
      return { backgroundColor: "#000000", color: "#FFFFFF" };
    case "accent-box":
      return { backgroundColor: accentColor, color: "#FFFFFF" };
    case "translucent-box":
      return { backgroundColor: "rgba(0,0,0,0.55)", color: "#FFFFFF" };
  }
}

/** Non-interactive text overlay rendered on top of feed media.
 *  Translates editor-space fractions (relative to the full CONTAIN video
 *  frame) into feed-space pixels, accounting for COVER's centered crop. */
const FeedTextOverlay = memo(function FeedTextOverlay({
  overlay,
  containerW,
  containerH,
  videoAspect = ASSUMED_VIDEO_ASPECT,
}: {
  overlay: TextOverlay;
  containerW: number;
  containerH: number;
  videoAspect?: number;
}) {
  const { backgroundColor, color } = resolveFeedBg(
    overlay.backgroundStyle,
    overlay.color,
  );

  // Compute how much of the original video is visible after COVER cropping
  const { visibleW, visibleH, cropLeft, cropTop } = computeCoverCrop(
    containerW,
    containerH,
    videoAspect,
  );

  // Map overlay.x/y (fractions of the full uncropped video) to screen
  // position within the COVER-cropped container.
  const adjustedX = (overlay.x - cropLeft) / visibleW;
  const adjustedY = (overlay.y - cropTop) / visibleH;

  // Clamp to visible bounds so overlays near cropped edges remain on-screen
  const clampedX = Math.max(0, Math.min(1, adjustedX));
  const clampedY = Math.max(0, Math.min(1, adjustedY));

  const left = clampedX * containerW;
  const top = clampedY * containerH;

  // Scale font size: editor's fontSize is relative to its small letterboxed
  // preview frame (~250px wide). Scale up proportionally to the feed's
  // full-screen container so text appears at the correct visual proportion.
  const ASSUMED_EDITOR_FRAME_WIDTH = 250;
  const fontScale = containerW / ASSUMED_EDITOR_FRAME_WIDTH;
  const scaledFontSize = (overlay.fontSize ?? 26) * fontScale;

  // Measure the text box via onLayout so we can center it on the stored
  // x/y point — matching the editor's DraggableTextOverlay which offsets
  // by -textWidth/2, -textHeight/2 (lines 377-378).
  const [textSize, setTextSize] = useState<{ w: number; h: number }>(
    { w: 0, h: 0 },
  );

  return (
    <View
      pointerEvents="none"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) {
          setTextSize((prev) =>
            prev.w === width && prev.h === height ? prev : { w: width, h: height },
          );
        }
      }}
      style={[
        styles.textOverlayWrap,
        {
          left,
          top,
          transform: [
            { translateX: -textSize.w / 2 },
            { translateY: -textSize.h / 2 },
            { rotate: `${overlay.rotation}deg` },
          ],
        },
      ]}
    >
      <UiText
        style={[
          styles.textOverlayText,
          {
            color,
            fontSize: scaledFontSize,
            backgroundColor,
          },
        ]}
        numberOfLines={undefined}
      >
        {overlay.text}
      </UiText>
    </View>
  );
},
(prev, next) =>
  prev.overlay === next.overlay &&
  prev.containerW === next.containerW &&
  prev.containerH === next.containerH);

function timeAgo(d: Date): string {
  const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d`;
}

export const FeedItem = memo(function FeedItem({
  post,
  active,
  live,
  onShare,
  onReactions,
  onRetry,
  onDismiss,
  bottomInset = TAB_BAR_HEIGHT,
}: {
  post: Post;
  active: boolean;
  live: boolean;
  onShare: () => void;
  onReactions: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  /** Bottom offset for action buttons and user info — TAB_BAR_HEIGHT on main feed, safe-area-based on profile view. */
  bottomInset?: number;
}) {
  const [isPaused, setIsPaused] = useState<boolean>(false);
  // Measured container dimensions — used for cover-crop-aware overlay positioning
  const [containerDims, setContainerDims] = useState<{ w: number; h: number }>(
    { w: SCREEN_W, h: SCREEN_H },
  );
  const { reactionsByParent, deletePost, toggleLike, likedPosts } = usePosts();
  const { user } = useAuth();
  const { reportContent } = useReportContent();
  const liked = likedPosts.some((p) => p.id === post.id);
  const [likedOptimistic, setLikedOptimistic] = useState<boolean>(liked);
  // Sync optimistic state when the source-of-truth changes (e.g. query refetch)
  useEffect(() => { setLikedOptimistic(liked); }, [liked]);
  const router = useRouter();
  const isOwner = !!user?.id && post.user_id === user.id;
  const reactionCount = reactionsByParent[post.id]?.length ?? 0;
  // Multi-segment playback: if post.segments exists, cycle through them
  const allSegments = useMemo<string[]>(
    () => (post.segments && post.segments.length > 0 ? post.segments : [post.media_url]),
    [post.segments, post.media_url],
  );
  const [segIdx, setSegIdx] = useState<number>(0);
  const currentUri = allSegments[segIdx] ?? post.media_url;
  const segIdxRef = useRef<number>(0);
  useEffect(() => { segIdxRef.current = segIdx; }, [segIdx]);

  // ── Dual-player preload ────────────────────────────────────────────
  // Two Video instances swap roles so the next segment is already loaded
  // when the current one ends, avoiding a cold-load stall between segments.
  // Matches the editor's videoRefA/videoRefB pattern in edit.tsx.
  const videoRefA = useRef<Video>(null);
  const videoRefB = useRef<Video>(null);
  const activeVideoRef = useRef<Video | null>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const preloadReadyRef = useRef<boolean>(false);
  // Debounce: prevent multiple advanceSegment calls within 500ms
  const lastAdvanceTimeRef = useRef<number>(0);
  // Track which URI each slot has loaded, so we can detect when a slot
  // already has the correct content loaded (wrap-around for 2-segment posts)
  // and skip waiting for onReadyForDisplay (which won't fire if unchanged).
  const slotALoadedUriRef = useRef<string | null>(null);
  const slotBLoadedUriRef = useRef<string | null>(null);

  // Crossfade opacity for smooth segment transitions (~200ms dissolve)
  const slotAOpacity = useRef(new Animated.Value(1)).current;
  const slotBOpacity = useRef(new Animated.Value(0)).current;
  // Pending crossfade: when the incoming slot isn't ready at swap time, we
  // defer the crossfade until onReadyForDisplay fires. This ref holds the
  // slot that needs to fade in once ready, so onReadySlotA/B can trigger it.
  const pendingCrossfadeRef = useRef<{ incomingSlot: 0 | 1 } | null>(null);
  // Timestamp of the last slot swap — used to ignore stale position reports
  // from the outgoing slot that arrive before the incoming slot's seek-to-0
  // completes. Without this, a stale position near trimEnd triggers a
  // premature END OF SEGMENT on the incoming segment.
  const slotSwapTimeRef = useRef<number>(0);

  const preloadUri = useMemo<string>(
    () => allSegments[(segIdx + 1) % allSegments.length] ?? post.media_url,
    [allSegments, segIdx, post.media_url],
  );

  // Only multi-segment posts need the preload player, and only when the
  // item is active/visible — off-screen items must not double up players.
  const shouldMountPreload = active && allSegments.length > 1;

  // Keep activeVideoRef in sync with the active slot
  useEffect(() => {
    activeSlotRef.current = activeSlot;
    activeVideoRef.current = activeSlot === 0 ? videoRefA.current : videoRefB.current;
  }, [activeSlot]);

  // Reset to slot A when the preload player unmounts (item became inactive)
  useEffect(() => {
    if (!shouldMountPreload) {
      if (activeSlotRef.current !== 0) {
        activeSlotRef.current = 0;
        activeVideoRef.current = videoRefA.current;
        setActiveSlot(0);
      }
      preloadReadyRef.current = false;
      lastAdvanceTimeRef.current = 0;
      slotAOpacity.setValue(1);
      slotBOpacity.setValue(0);
    }
  }, [shouldMountPreload, slotAOpacity, slotBOpacity]);

  // Video error state for retry UI
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);

  // ── Pre-buffering: don't start playback until the first frame is ready.
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate & pause state when the post changes
  // (segIdx changes are handled by advanceSegment's hot-swap logic)
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    setPlaybackReady(false);
    playbackReadyRef.current = false;
    readyForDisplayRef.current = false;
    setIsPaused(false);
  }, [post.id]);

  // Auto-unpause and ensure playback when scrolling back to this video.
  // expo-av can miss the shouldPlay transition from false→true when the
  // component re-renders with a new shouldPlay value after mount (e.g.
  // when initialScrollIndex causes a brief inactive→active transition).
  // Explicit playAsync() guarantees playback regardless.
  useEffect(() => {
    if (active) {
      setIsPaused(false);
      if (playbackReady) {
        videoRef.current?.playAsync().catch(() => {});
      }
    }
  }, [active, playbackReady]);

  // Clear prebuffer safety timer on unmount or when post changes
  useEffect(() => {
    return () => {
      if (prebufferTimerRef.current) {
        clearTimeout(prebufferTimerRef.current);
        prebufferTimerRef.current = null;
      }
    };
  }, [post.id]);

  // ── Safety timeout: if onReadyForDisplay never fires (e.g. wrap-around
  // for 2-segment posts where the source URI doesn't change and the event
  // never re-fires). Seek to trimStart so the player resumes from the
  // correct position, not wherever it was left off.
  useEffect(() => {
    if (!active || playbackReady) return;

    prebufferTimerRef.current = setTimeout(() => {
      if (!playbackReadyRef.current) {
        playbackReadyRef.current = true;
        readyForDisplayRef.current = true;
        setPlaybackReady(true);
        // Seek to trimStart — the player may be at the wrong position
        // (e.g. near trimEnd from the previous play-through of this segment).
        const trim =
          post.trim_data && segIdxRef.current < post.trim_data.length
            ? post.trim_data[segIdxRef.current]
            : null;
        const seekTo = trim?.trimStartMs ?? 0;
        const ref = activeSlotRef.current === 0 ? videoRefA.current : videoRefB.current;
        ref?.setPositionAsync(seekTo).catch(() => {});
      }
    }, 3000);

    return () => {
      if (prebufferTimerRef.current) {
        clearTimeout(prebufferTimerRef.current);
        prebufferTimerRef.current = null;
      }
    };
  }, [active, playbackReady, post.id, post.trim_data]);

  // ── Stall detection + recovery ─────────────────────────────────────
  // DIAGNOSTIC: log all video events to console for segment transition debugging
  const videoLog = useCallback((_e: VideoEvent) => {}, []);

  const {
    videoRef,
    stallState,
    handlePlaybackStatus: handleStallDetection,
  } = useVideoStallDetection(post.id, active, currentUri, videoLog, activeVideoRef);

  // Trim tracking for the current segment
  const durationSetRef = useRef<boolean>(false);
  const trimStartRef = useRef<number>(0);
  const trimEndRef = useRef<number>(0);
  const trimEndHandledRef = useRef<boolean>(false);
  useEffect(() => {
    const trim =
      post.trim_data && segIdx < post.trim_data.length
        ? post.trim_data[segIdx]
        : null;
    trimStartRef.current = trim?.trimStartMs ?? 0;
    trimEndRef.current = trim?.trimEndMs ?? 0;
    trimEndHandledRef.current = false;
    durationSetRef.current = false;
    setVideoError(null);
    errorCountRef.current = 0;
    setIsPaused(false);
  }, [segIdx, post.trim_data]);

  const name =
    post.profile?.display_name || post.profile?.username || "dropper";
  const createdAt = useMemo(() => new Date(post.created_at), [post.created_at]);
  const ago = useMemo(() => timeAgo(createdAt), [createdAt]);

  const isLiveDrop = useMemo(() => {
    const win = getDropWindowState(new Date());
    return (
      win.isOpen && createdAt >= win.windowStart && createdAt < win.windowEnd
    );
  }, [createdAt]);

  // Reset segment index and dual-player state when post changes
  useEffect(() => {
    setSegIdx(0);
    segIdxRef.current = 0;
    setActiveSlot(0);
    activeSlotRef.current = 0;
    activeVideoRef.current = videoRefA.current;
    preloadReadyRef.current = false;
    lastAdvanceTimeRef.current = 0;
    setVideoError(null);
    errorCountRef.current = 0;
    setIsPaused(false);
    slotALoadedUriRef.current = null;
    slotBLoadedUriRef.current = null;
    pendingCrossfadeRef.current = null;
    slotAOpacity.setValue(1);
    slotBOpacity.setValue(0);
  }, [post.id]);

  // ── Advance to next segment via dual-player hot-swap ──────────────
  // Flips the active/inactive slots. If the preload was ready, the
  // transition is seamless (playbackReady stays true). If not, the
  // pre-buffer gate resets and a buffering indicator shows until
  // onReadyForDisplay fires on the newly-active player.
  // Wrap-around (last segment → segment 0) is handled identically.
  const advanceSegment = useCallback(() => {
    // Debounce: end-of-segment detection can fire multiple times rapidly
    const now = Date.now();
    if (now - lastAdvanceTimeRef.current < 500) {
      return;
    }
    lastAdvanceTimeRef.current = now;

    const current = segIdxRef.current;
    const next = (current + 1) % allSegments.length;
    const newSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
    const wasPreloadReady = preloadReadyRef.current;

    // Check if the new active slot already has the target URI loaded.
    // This happens on wrap-around for 2-segment posts: slot A was loaded
    // with segment 0's URL on initial mount, and when we wrap from segment 1
    // back to segment 0, the source hasn't changed so onReadyForDisplay
    // won't re-fire. Without this check, we'd wait 3s for a timeout.
    const targetUri = allSegments[next];
    const newSlotLoadedUri = newSlot === 0 ? slotALoadedUriRef.current : slotBLoadedUriRef.current;
    const slotAlreadyLoaded = newSlotLoadedUri === targetUri;

    activeSlotRef.current = newSlot;
    const newActiveRef = newSlot === 0 ? videoRefA.current : videoRefB.current;
    activeVideoRef.current = newActiveRef;
    preloadReadyRef.current = false;
    slotSwapTimeRef.current = Date.now();

    setActiveSlot(newSlot);
    setSegIdx(next);
    segIdxRef.current = next;

    // Helper to run the crossfade animation (200ms smooth dissolve)
    const runCrossfade = () => {
      const outgoingOpacity = newSlot === 0 ? slotBOpacity : slotAOpacity;
      const incomingOpacity = newSlot === 0 ? slotAOpacity : slotBOpacity;
      Animated.parallel([
        Animated.timing(outgoingOpacity, {
          toValue: 0,
          duration: 200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(incomingOpacity, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start();
    };

    // Compute trim for the new segment directly (trim refs update in effect, not yet)
    const trim =
      post.trim_data && next < post.trim_data.length
        ? post.trim_data[next]
        : null;
    const seekTo = trim?.trimStartMs ?? 0;

    if (wasPreloadReady || slotAlreadyLoaded) {
      // Preload was ready OR the slot already has this URI loaded (wrap-around
      // for 2-segment posts). The frame is already displayed on the new slot.
      // The source URI didn't change, so onReadyForDisplay will NOT re-fire.
      // Seek to start FIRST, then crossfade once the seek resolves — so the
      // incoming slot shows position 0 during the dissolve, not a stale frame
      // from the previous segment's end position.
      playbackReadyRef.current = true;
      readyForDisplayRef.current = true;
      setPlaybackReady(true);
      pendingCrossfadeRef.current = null;
      const seekPromise = newActiveRef?.setPositionAsync(seekTo);
      if (seekPromise) {
        seekPromise
          .then(() => {
            runCrossfade();
          })
          .catch(() => {
            // Seek failed — crossfade anyway so we don't freeze
            runCrossfade();
          });
      } else {
        runCrossfade();
      }
    } else {
      // Preload wasn't ready and the slot has a different URI loaded.
      // onReadyForDisplay WILL fire when the fresh load completes.
      // DEFER the crossfade — keep the outgoing frame at full opacity so the
      // buffering state on the incoming slot is never visible through the dissolve.
      // onReadySlotA/B will trigger the crossfade once the first frame is rendered.
      playbackReadyRef.current = false;
      readyForDisplayRef.current = false;
      setPlaybackReady(false);
      pendingCrossfadeRef.current = { incomingSlot: newSlot };
    }
  }, [allSegments, shouldMountPreload, post.id, post.trim_data]);

  // When video finishes, advance to next segment or loop
  const onSegmentStatus = useCallback(
    (status: AVPlaybackStatus) => {
      handleStallDetection(status);

      if (!status.isLoaded) return;

      // ── Pre-buffer gate ──
      // Only pass on a real onReadyForDisplay event (readyForDisplayRef set
      // by onReadySlotA/B). The notBuffering fallback was removed because it
      // let playbackReady go true before the first frame was rendered.
      // The 3s safety timeout (separate effect above) handles edge cases where
      // onReadyForDisplay never fires.
      if (!playbackReadyRef.current && readyForDisplayRef.current) {
        playbackReadyRef.current = true;
        setPlaybackReady(true);
        if (prebufferTimerRef.current) {
          clearTimeout(prebufferTimerRef.current);
          prebufferTimerRef.current = null;
        }
      }

      const sourceDur =
        typeof status.durationMillis === "number" ? status.durationMillis : 0;

      if (!durationSetRef.current && sourceDur > 0) {
        durationSetRef.current = true;
        if (trimStartRef.current > 0) {
          videoRef.current
            ?.setPositionAsync(trimStartRef.current)
            .catch(() => {});
          return;
        }
      }

      // ── Stale position guard ──
      // After a slot swap, the outgoing slot's last position report can
      // arrive before the incoming slot's seek-to-0 completes. This stale
      // position (often near the previous segment's trimEnd) can trigger a
      // premature END OF SEGMENT on the new segment. Skip end-of-segment
      // detection for 400ms after a slot swap to let the seek settle.
      const msSinceSwap = Date.now() - slotSwapTimeRef.current;
      const isStalePosition = msSinceSwap < 400;

      // ── Unified end-of-segment detection ──
      if (!isStalePosition && !status.didJustFinish && !trimEndHandledRef.current && sourceDur > 0) {
        const effectiveTrimEnd =
          trimEndRef.current > 0
            ? Math.min(trimEndRef.current, sourceDur)
            : sourceDur;

        if (status.positionMillis >= effectiveTrimEnd - 120) {
          trimEndHandledRef.current = true;
          if (allSegments.length === 1) {
            videoRef.current
              ?.setPositionAsync(trimStartRef.current)
              .then(() => {
                trimEndHandledRef.current = false;
              })
              .catch(() => {});
          } else {
            advanceSegment();
          }
          return;
        }
      }

      // Native just-finished fallback
      if (status.didJustFinish && allSegments.length > 1) {
        advanceSegment();
      }
    },
    [allSegments.length, handleStallDetection, advanceSegment, post.id],
  );

  // ── Error recovery: retry loading ──────────────────────────────────
  const handleRetryVideo = useCallback(() => {
    setVideoError(null);
    videoRef.current
      ?.unloadAsync()
      .then(() =>
        videoRef.current?.loadAsync(
          { uri: currentUri },
          { shouldPlay: active, isLooping: allSegments.length === 1 },
          false,
        ),
      )
      .catch(() => {});
  }, [currentUri, active, videoRef]);

  // ── Delete this Drop (owner only) ──────────────────────────────────
  const handleDelete = useCallback(() => {
    Alert.alert(
      "Delete this Drop?",
      "This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deletePost.mutate(post.id),
        },
      ],
    );
  }, [deletePost, post.id]);

  // ── Per-slot callbacks for dual-player ─────────────────────────────
  // Only the active slot runs the full playback/stall logic; the inactive
  // slot just tracks preload readiness via onReadyForDisplay.
  const onStatusSlotA = useCallback(
    (status: AVPlaybackStatus) => {
      if (activeSlotRef.current === 0) {
        onSegmentStatus(status);
      }
    },
    [onSegmentStatus],
  );
  const onStatusSlotB = useCallback(
    (status: AVPlaybackStatus) => {
      if (activeSlotRef.current === 1) {
        onSegmentStatus(status);
      }
    },
    [onSegmentStatus],
  );

  const onReadySlotA = useCallback(() => {
    // Track the URI that slot A has loaded
    const slotAUri = activeSlotRef.current === 0 ? currentUri : preloadUri;
    slotALoadedUriRef.current = slotAUri;

    if (activeSlotRef.current === 0) {
      setVideoError(null);
      readyForDisplayRef.current = true;
      // Trigger deferred crossfade if this slot was the incoming one
      if (pendingCrossfadeRef.current?.incomingSlot === 0) {
        pendingCrossfadeRef.current = null;
        // Seek to start FIRST, then crossfade once seek resolves — so the
        // incoming slot shows position 0 during the dissolve, not a stale frame.
        const trim =
          post.trim_data && segIdxRef.current < post.trim_data.length
            ? post.trim_data[segIdxRef.current]
            : null;
        const seekTo = trim?.trimStartMs ?? 0;
        const seekPromise = videoRefA.current?.setPositionAsync(seekTo);
        if (seekPromise) {
          seekPromise
            .then(() => {
              Animated.parallel([
                Animated.timing(slotBOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
                Animated.timing(slotAOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
              ]).start();
            })
            .catch(() => {
              Animated.parallel([
                Animated.timing(slotBOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
                Animated.timing(slotAOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
              ]).start();
            });
        } else {
          Animated.parallel([
            Animated.timing(slotBOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
            Animated.timing(slotAOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          ]).start();
        }
      }
      if (!playbackReadyRef.current) {
        playbackReadyRef.current = true;
        setPlaybackReady(true);
        // Seek to start position — needed after a swap where preload wasn't
        // ready (the player may have loaded at a non-zero position).
        const trim =
          post.trim_data && segIdxRef.current < post.trim_data.length
            ? post.trim_data[segIdxRef.current]
            : null;
        const seekTo = trim?.trimStartMs ?? 0;
        if (!pendingCrossfadeRef.current) {
          // Only seek here if the deferred crossfade path didn't already seek
          videoRefA.current?.setPositionAsync(seekTo).catch(() => {});
        }
        if (prebufferTimerRef.current) {
          clearTimeout(prebufferTimerRef.current);
          prebufferTimerRef.current = null;
        }
      }
    } else {
      // Inactive slot: preload is ready
      preloadReadyRef.current = true;
    }
  }, [post.id, post.trim_data, currentUri, preloadUri, slotAOpacity, slotBOpacity]);

  const onReadySlotB = useCallback(() => {
    // Track the URI that slot B has loaded
    const slotBUri = activeSlotRef.current === 1 ? currentUri : preloadUri;
    slotBLoadedUriRef.current = slotBUri;

    if (activeSlotRef.current === 1) {
      setVideoError(null);
      readyForDisplayRef.current = true;
      // Trigger deferred crossfade if this slot was the incoming one
      if (pendingCrossfadeRef.current?.incomingSlot === 1) {
        pendingCrossfadeRef.current = null;
        // Seek to start FIRST, then crossfade once seek resolves — so the
        // incoming slot shows position 0 during the dissolve, not a stale frame.
        const trim =
          post.trim_data && segIdxRef.current < post.trim_data.length
            ? post.trim_data[segIdxRef.current]
            : null;
        const seekTo = trim?.trimStartMs ?? 0;
        const seekPromise = videoRefB.current?.setPositionAsync(seekTo);
        if (seekPromise) {
          seekPromise
            .then(() => {
              Animated.parallel([
                Animated.timing(slotAOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
                Animated.timing(slotBOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
              ]).start();
            })
            .catch(() => {
              Animated.parallel([
                Animated.timing(slotAOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
                Animated.timing(slotBOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
              ]).start();
            });
        } else {
          Animated.parallel([
            Animated.timing(slotAOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
            Animated.timing(slotBOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          ]).start();
        }
      }
      if (!playbackReadyRef.current) {
        playbackReadyRef.current = true;
        setPlaybackReady(true);
        // Seek to start position — needed after a swap where preload wasn't ready.
        const trim =
          post.trim_data && segIdxRef.current < post.trim_data.length
            ? post.trim_data[segIdxRef.current]
            : null;
        const seekTo = trim?.trimStartMs ?? 0;
        if (!pendingCrossfadeRef.current) {
          // Only seek here if the deferred crossfade path didn't already seek
          videoRefB.current?.setPositionAsync(seekTo).catch(() => {});
        }
        if (prebufferTimerRef.current) {
          clearTimeout(prebufferTimerRef.current);
          prebufferTimerRef.current = null;
        }
      }
    } else {
      preloadReadyRef.current = true;
    }
  }, [post.id, post.trim_data, currentUri, preloadUri, slotAOpacity, slotBOpacity]);

  const onLoadSlotA = useCallback((status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
    if (status.isLoaded) {
      // Track loaded URI on load (fires before onReadyForDisplay) as a fallback
      const slotAUri = activeSlotRef.current === 0 ? currentUri : preloadUri;
      slotALoadedUriRef.current = slotAUri;
      videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
    }
  }, [post.id, videoLog, currentUri, preloadUri]);

  const onLoadSlotB = useCallback((status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
    if (status.isLoaded) {
      const slotBUri = activeSlotRef.current === 1 ? currentUri : preloadUri;
      slotBLoadedUriRef.current = slotBUri;
      videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
    }
  }, [post.id, videoLog, currentUri, preloadUri]);

  const onErrorSlotA = useCallback((error: string) => {
    console.error(`[FeedItem:${post.id}] onError SLOT_A`, { error, activeSlot: activeSlotRef.current });
    if (activeSlotRef.current === 0) {
      errorCountRef.current += 1;
      setVideoError(error);
    }
  }, [post.id, videoLog]);

  const onErrorSlotB = useCallback((error: string) => {
    console.error(`[FeedItem:${post.id}] onError SLOT_B`, { error, activeSlot: activeSlotRef.current });
    if (activeSlotRef.current === 1) {
      errorCountRef.current += 1;
      setVideoError(error);
    } else {
      // Preload failed — mark as not ready so hot-swap falls back gracefully
      preloadReadyRef.current = false;
    }
  }, [post.id, videoLog]);

  return (
    <View
      style={styles.item}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0 && (width !== containerDims.w || height !== containerDims.h)) {
          setContainerDims({ w: width, h: height });
        }
      }}
    >
      {post.media_type === "video" ? (
        <View style={StyleSheet.absoluteFill}>
          {/* Slot A — primary player, always mounted for video posts */}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { opacity: slotAOpacity },
            ]}
          >
            <Video
              key={`slotA-${post.id}`}
              ref={videoRefA}
              source={{ uri: activeSlot === 0 ? currentUri : preloadUri }}
              style={[
                StyleSheet.absoluteFill,
                post._optimistic?.status === "failed" && { opacity: 0.3 },
              ]}
              resizeMode={ResizeMode.COVER}
              isLooping={allSegments.length === 1 && activeSlot === 0}
              shouldPlay={activeSlot === 0 && active && playbackReady && !isPaused && post._optimistic?.status !== "failed"}
              isMuted={activeSlot === 0 ? !active : true}
              useNativeControls={false}
              progressUpdateIntervalMillis={250}
              onPlaybackStatusUpdate={onStatusSlotA}
              onError={onErrorSlotA}
              onLoad={onLoadSlotA}
              onLoadStart={() => {
                videoLog({ type: "load_start", postId: post.id, uri: activeSlot === 0 ? currentUri : preloadUri });
              }}
              onReadyForDisplay={onReadySlotA}
            />
          </Animated.View>

          {/* Slot B — preload player, only mounted for active multi-segment posts */}
          {shouldMountPreload && (
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { opacity: slotBOpacity },
              ]}
            >
              <Video
                key={`slotB-${post.id}`}
                ref={videoRefB}
                source={{ uri: activeSlot === 1 ? currentUri : preloadUri }}
                style={StyleSheet.absoluteFill}
                resizeMode={ResizeMode.COVER}
                isLooping={false}
                shouldPlay={activeSlot === 1 && active && playbackReady && !isPaused && post._optimistic?.status !== "failed"}
                isMuted={activeSlot === 1 ? !active : true}
                useNativeControls={false}
                progressUpdateIntervalMillis={250}
                onPlaybackStatusUpdate={onStatusSlotB}
                onError={onErrorSlotB}
                onLoad={onLoadSlotB}
                onLoadStart={() => {
                  videoLog({ type: "load_start", postId: post.id, uri: activeSlot === 1 ? currentUri : preloadUri });
                }}
                onReadyForDisplay={onReadySlotB}
              />
            </Animated.View>
          )}

          {/* Double-tap to like zone */}
          <DoubleTapLikeZone
            onLike={() => {
              if (!likedOptimistic) {
                setLikedOptimistic(true);
                toggleLike.mutate({ postId: post.id, liked: true });
              }
            }}
            onSingleTap={() => setIsPaused((v) => !v)}
            style={{
              bottom: bottomInset + BOTTOM_OVERLAY_HEIGHT,
            }}
          />

          {/* Buffering indicator */}
          {stallState.isBuffering && active && (
            <View style={styles.bufferingOverlay} pointerEvents="none">
              <ActivityIndicator color={theme.accent} size="small" />
            </View>
          )}

          {/* Stall recovery / error overlay */}
          {(stallState.recovering || videoError) && active && (
            <View style={styles.stallOverlay} pointerEvents="box-none">
              {stallState.recovering ? (
                <>
                  <ActivityIndicator color="#fff" size="large" />
                  <UiText style={styles.stallText}>Recovering playback…</UiText>
                </>
              ) : videoError ? (
                <Pressable onPress={handleRetryVideo} style={styles.retryBtn}>
                  <RotateCcw color="#fff" size={20} strokeWidth={2.5} />
                  <UiText style={styles.retryText}>Tap to retry</UiText>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      ) : (
        <Image
          source={{ uri: post.media_url }}
          style={[
            StyleSheet.absoluteFill,
            post._optimistic?.status === "failed" && { opacity: 0.3 },
          ]}
          contentFit="cover"
          transition={150}
        />
      )}

      {/* Text overlays — rendered on top of media, below UI chrome */}
      {post.text_overlays && post.text_overlays.length > 0 && !post._optimistic?.status && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {post.text_overlays.map((ov) => (
            <FeedTextOverlay
              key={ov.id}
              overlay={ov}
              containerW={containerDims.w}
              containerH={containerDims.h}
            />
          ))}
        </View>
      )}

      {/* Optimistic posting overlay */}
      {post._optimistic?.status === "uploading" && (
        <View style={styles.optOverlay} pointerEvents="auto">
          <LinearGradient
            colors={["rgba(0,0,0,0.6)", "rgba(0,0,0,0.6)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.optInner}>
            <UiText style={styles.optTitle}>Posting your drop</UiText>
            <View style={styles.optProgressTrack}>
              <View
                style={[
                  styles.optProgressFill,
                  {
                    width: `${Math.min(post._optimistic?.progress ?? 0, 100)}%` as unknown as number,
                  },
                ]}
              />
            </View>
            <UiText style={styles.optProgressLabel}>
              Uploading... {post._optimistic?.progress ?? 0}%
            </UiText>
          </View>
        </View>
      )}
      {post._optimistic?.status === "failed" && (
        <View style={styles.optOverlay} pointerEvents="auto">
          <LinearGradient
            colors={["rgba(20,20,20,0.85)", "rgba(0,0,0,0.92)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.optInner}>
            <View style={styles.optErrorCircle}>
              <AlertCircle color={theme.danger} size={28} strokeWidth={2.5} />
            </View>
            <UiText style={styles.optTitle}>Upload failed</UiText>
            <UiText style={styles.optSub} numberOfLines={3}>
              {post._optimistic?.error ?? "Something went wrong during upload."}
            </UiText>
            <View style={styles.optBtnRow}>
              <Pressable onPress={onRetry} style={styles.optRetryBtn} hitSlop={8}>
                <RotateCcw color="#fff" size={16} strokeWidth={2.5} />
                <UiText style={styles.optRetryText}>Retry</UiText>
              </Pressable>
              <Pressable onPress={onDismiss} style={styles.optDismissBtn} hitSlop={8}>
                <X color="rgba(255,255,255,0.5)" size={16} strokeWidth={2.5} />
                <UiText style={styles.optDismissText}>Dismiss</UiText>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      <LinearGradient
        colors={["rgba(0,0,0,0.55)", "transparent"]}
        style={styles.gradTop}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={styles.gradBottom}
        pointerEvents="none"
      />

      <View
        style={[
          styles.actions,
          { bottom: bottomInset + 30 },
        ]}
      >
        <ActionButton
          icon={
            <Heart
              color={likedOptimistic ? theme.danger : "#fff"}
              fill={likedOptimistic ? theme.danger : "transparent"}
              size={28}
              strokeWidth={2}
            />
          }
          label={String(post.like_count ?? 0)}
          onPress={() => {
            const next = !likedOptimistic;
            setLikedOptimistic(next);
            toggleLike.mutate({ postId: post.id, liked: next });
          }}
        />
        <ActionButton
          icon={<Sparkles color="#fff" size={28} strokeWidth={1.8} />}
          label={String(reactionCount)}
          onPress={onReactions}
        />
        <ActionButton
          icon={<Send color="#fff" size={24} strokeWidth={2} />}
          label="Share"
          onPress={onShare}
        />
        {isOwner && (
          <ActionButton
            icon={<Trash2 color={theme.danger} size={24} strokeWidth={2} />}
            label="Delete"
            onPress={handleDelete}
          />
        )}
        {!isOwner && (
          <ActionButton
            icon={<Flag color="#fff" size={22} strokeWidth={2} />}
            label="Report"
            onPress={() => reportContent("post", post.id)}
          />
        )}
      </View>

      <View
        style={[
          styles.bottom,
          { bottom: bottomInset + 24 },
        ]}
        pointerEvents="box-none"
      >
        {isLiveDrop && (
          <View style={styles.liveTag}>
            <View style={styles.livePulse} />
            <UiText style={styles.liveTagText}>LIVE DROP</UiText>
          </View>
        )}
        <View style={styles.userRow}>
          <Pressable
            onPress={() => {
              if (!user?.id || !post.user_id) return;
              if (post.user_id === user.id) {
                router.push("/(tabs)/profile" as never);
              } else {
                router.push(`/user/${post.user_id}` as never);
              }
            }}
            style={styles.userRowPressable}
          >
            <View style={styles.avatar}>
              <FeedAvatar profile={post.profile} name={name} />
            </View>
            <UiText style={styles.username}>
              @{post.profile?.username ?? "dropper"}
            </UiText>
          </Pressable>
          <UiText style={styles.dotSep}>·</UiText>
          <UiText style={styles.ago}>{ago}</UiText>
        </View>
        {post.caption ? (
          <UiText style={styles.caption} numberOfLines={3}>
            {post.caption}
          </UiText>
        ) : null}
        <View style={styles.musicRow}>
          <Music2 color={theme.textMuted} size={12} />
          <UiText style={styles.musicText}>
            {live ? "Original drop · tonight" : "Original sound"}
          </UiText>
        </View>
      </View>
    </View>
  );
},
(prev, next) =>
  prev.post === next.post &&
  prev.active === next.active &&
  prev.live === next.live);

const styles = StyleSheet.create({
  /* Feed item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#F5F3EE",
  },
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  gradBottom: { position: "absolute", left: 0, right: 0, bottom: 0, height: 320 },

  /* Actions */
  actions: {
    position: "absolute",
    right: 12,
    alignItems: "center",
    gap: 22,
    zIndex: 999,
  },
  actionBtn: { alignItems: "center", gap: 4 },
  actionLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900" as const,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },

  /* Bottom info */
  bottom: {
    position: "absolute",
    left: 16,
    right: 80,
    gap: 8,
    zIndex: 999,
  },
  liveTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: theme.accent,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 0,
  },
  livePulse: {
    width: 6,
    height: 6,
    borderRadius: 0,
    backgroundColor: "#fff",
  },
  liveTagText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "900" as const,
    letterSpacing: 0.8,
  },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  userRowPressable: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  username: {
    color: "#fff",
    fontWeight: "900" as const,
    fontSize: 15,
  },
  dotSep: { color: theme.textMuted, fontSize: 13 },
  ago: { color: theme.textMuted, fontSize: 12, fontWeight: "600" as const },
  caption: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
  },
  musicRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  musicText: { color: theme.textMuted, fontSize: 12 },

  /* Buffering indicator */
  bufferingOverlay: {
    position: "absolute",
    top: "50%",
    left: "50%",
    marginLeft: -16,
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },

  /* Stall / error recovery overlay */
  stallOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  stallText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
    fontWeight: "600" as const,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  retryText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },

  /* Optimistic posting overlay */
  optOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  optInner: {
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  optProgressTrack: {
    width: 180,
    height: 4,
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.1)",
    overflow: "hidden",
  },
  optProgressFill: {
    height: "100%" as unknown as number,
    borderRadius: 0,
    backgroundColor: theme.accent,
  },
  optProgressLabel: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 12,
    fontWeight: "700" as const,
    textAlign: "center",
  },
  optTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "900" as const,
    textAlign: "center",
  },
  optSub: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center",
    lineHeight: 18,
  },
  optErrorCircle: {
    width: 56,
    height: 56,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  optBtnRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  optRetryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.accent,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 0,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 4,
  },
  optRetryText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "900" as const,
    letterSpacing: 0.3,
  },
  optDismissBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(10,10,10,0.07)",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.12)",
  },
  optDismissText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 14,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
  },

  /* Text overlays (feed playback) */
  textOverlayWrap: {
    position: "absolute",
  },
  textOverlayText: {
    fontWeight: "900" as const,
    textAlign: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 0,
    overflow: "hidden",
    textShadowColor: "rgba(0,0,0,0.4)",
    textShadowRadius: 2,
  },
});
