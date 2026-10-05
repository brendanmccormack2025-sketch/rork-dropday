import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  AppState,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import {
  Heart,
  Music,
  Send,
  Sparkles,
  RotateCcw,
  X,
  AlertCircle,
  Eye,
  MoreHorizontal,
  Video,
} from "lucide-react-native";
import { VideoView, useVideoPlayer, type VideoPlayer } from "expo-video";
import { useVideoStatusFeed, type VideoPlaybackStatus } from "@/hooks/useVideoStatusFeed";

import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { TrialStatusBadge } from "@/components/TrialStatusBadge";
import CreatorLinkIcons from "@/components/CreatorLinkIcons";
import { theme } from "@/constants/theme";
import { usePosts, resolveAvatarUrl, type Post, type TextOverlay, type TextBackgroundStyle } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import { useReportContent } from "@/hooks/useReportContent";
import { supabase } from "@/lib/supabase";
import { getOutputTimeMs } from "@/lib/editModel";
import * as Updates from "expo-updates";
import { isInternalTester } from "@/constants/debug";
import { isVideoRenderAvailable } from "@/lib/renderAtPost";
import { usePlaybackDiagnostics } from "@/lib/playbackDiagnostics";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");
const TAB_BAR_HEIGHT = 88;
/**
 * Same-file seams: the idle player waits parked RUNUP_MS before the next
 * segment's trimStart, and starts playing (muted, hidden) a "lead" before the
 * outgoing segment ends so it is at normal speed when it reaches trimStart.
 * The lead follows the measured run-up-to-swap time (initial value, clamp).
 */
const RUNUP_MS = 80;
const SEAM_LEAD_INITIAL_MS = 100;
const SEAM_LEAD_MAX_MS = 120;
/** The seam timer is armed this long before the lead point, then polls fast. */
const SEAM_ARM_AHEAD_MS = 70;
const SEAM_POLL_MS = 16;
/** If the incoming player has not reached trimStart this long after its run-up started, swap anyway. */
const SEAM_FALLBACK_MS = 150;
/**
 * Single-file posts: loop with a ping-pong of the two players (the idle one,
 * parked at 0, muted and hidden, starts just before the end and takes over at
 * the end) instead of the native seek-and-play loop. false = native loop only.
 * The native loop is also the fallback when the idle player is not ready.
 */
const LOOP_PINGPONG = true;
const LOOP_LEAD_INITIAL_MS = 60;
/** The swap happens when the playing player is this close to the end of the file. */
const LOOP_SWAP_BEFORE_END_MS = 20;
/** Watch duration that qualifies a view for the exposure gate (posts.qualified_view_count). */
const QUALIFIED_VIEW_MS = 3000;
/** Session-level dedupe so scrolling back to a post doesn't re-record the same viewer. */
const qualifiedViewRecorded = new Set<string>();
/** Session-level dedupe for raw impressions — mirrors qualifiedViewRecorded; the
 *  server dedupes per viewer/post anyway (post_raw_views PK), this just avoids
 *  repeat RPCs when scrolling back to a post. */
const rawViewRecorded = new Set<string>();
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
  muted = false,
  circle = false,
}: {
  icon: React.ReactNode;
  /** Omit for icon-only actions (e.g. share). */
  label?: string;
  onPress?: () => void;
  /** Informational stats (view count) get reduced visual weight. */
  muted?: boolean;
  /** Render the icon inside a translucent circle (React action). */
  circle?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const [isPressed, setIsPressed] = useState(false);

  // Press feedback: quick squash on press-in, springy release on press-out.
  // Display-only stats (no onPress) stay static.
  const handlePressIn = () => {
    if (!onPress) return;
    setIsPressed(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    Animated.spring(scale, {
      toValue: 0.82,
      speed: 60,
      bounciness: 4,
      useNativeDriver: true,
    }).start();
  };
  const handlePressOut = () => {
    if (!onPress) return;
    setIsPressed(false);
    Animated.spring(scale, {
      toValue: 1,
      speed: 40,
      bounciness: 8,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={8}
    >
      <Animated.View style={[styles.actionBtn, { transform: [{ scale }] }]}>
        {circle ? (
          <View
            style={[styles.actionIconCircle, isPressed && styles.actionIconCirclePressed]}
          >
            {icon}
          </View>
        ) : (
          icon
        )}
        {label != null && (
          <UiText style={[styles.actionLabel, muted && styles.actionLabelMuted]}>
            {label}
          </UiText>
        )}
      </Animated.View>
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
  onShare,
  onReactions,
  onRetry,
  onDismiss,
  bottomInset = TAB_BAR_HEIGHT,
  itemHeight,
}: {
  post: Post;
  active: boolean;
  onShare: () => void;
  onReactions: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  /** Bottom offset for action buttons and user info — TAB_BAR_HEIGHT on main feed, safe-area-based on profile view. */
  bottomInset?: number;
  /** Measured list height; defaults to the window height. */
  itemHeight?: number;
}) {
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
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
  // Once the media file is deleted (after expiry) no player is ever mounted.
  const isPlayableVideo = post.media_type === "video" && !post.media_deleted_at;
  // Multi-segment playback: if post.segments exists, cycle through them
  const allSegments = useMemo<string[]>(
    () => (post.segments && post.segments.length > 0 ? post.segments : [post.media_url]),
    [post.segments, post.media_url],
  );
  // Segments cut from one source file share a URL; they differ only by trim range.
  const hasSharedSegmentUrls = useMemo(
    () => new Set(allSegments).size < allSegments.length,
    [allSegments],
  );
  // A plain single-file post (no trim_data): it loops natively, or ping-pongs
  // between the two players when LOOP_PINGPONG is on. Trimmed single clips keep
  // the old JS loop at trimEnd.
  const nativeLoopPost =
    allSegments.length === 1 && !(post.trim_data && post.trim_data.length > 0);
  const pingPongPost = LOOP_PINGPONG && nativeLoopPost;
  // Output-timeline position (after cuts), tracked only when an overlay has a
  // time window so posts without timed overlays never re-render for it.
  const hasTimedOverlays = !!post.text_overlays?.some(
    (ov) => ov.startMs !== undefined || ov.endMs !== undefined,
  );
  const [outputTimeMs, setOutputTimeMs] = useState<number>(0);
  const [segIdx, setSegIdx] = useState<number>(0);
  const currentUri = allSegments[segIdx] ?? post.media_url;
  const segIdxRef = useRef<number>(0);
  useEffect(() => { segIdxRef.current = segIdx; }, [segIdx]);

  // ── Dual-player preload ────────────────────────────────────────────
  // Two Video instances swap roles so the next segment is already loaded
  // when the current one ends, avoiding a cold-load stall between segments.
  // Matches the editor's videoRefA/videoRefB pattern in edit.tsx.
  // expo-video players: slot A holds the active segment, slot B preloads the
  // next one. Sources are swapped via replace() (useVideoPlayer only reads
  // its initial argument), mirroring the old per-slot `source` props.
  const playerA = useVideoPlayer(
    isPlayableVideo ? { uri: allSegments[0] ?? post.media_url } : null,
    (p) => {
      p.timeUpdateEventInterval = 0.25;
    },
  );
  const playerB = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });
  // Shared-URL segments are cut inside one file, so overshooting trimEnd plays
  // footage that was cut out. Report position more often so the seam is tight.
  // Internal-tester diagnostics need finer position reports to measure gaps.
  const diagEnabled = usePlaybackDiagnostics() && isInternalTester(user?.id);
  useEffect(() => {
    const interval = diagEnabled ? 0.03 : hasSharedSegmentUrls || pingPongPost ? 0.05 : 0.25;
    playerA.timeUpdateEventInterval = interval;
    playerB.timeUpdateEventInterval = interval;
  }, [hasSharedSegmentUrls, pingPongPost, diagEnabled, playerA, playerB]);

  // Diagnostics: gaps measured for the last 3 loop restarts or seams.
  // toPlayingMs = playToEnd (loop) or seam swap -> player reports playing;
  // toAdvanceMs = playing -> position first advances.
  type DiagGap = { kind: "loop" | "seam"; toPlayingMs: number; toAdvanceMs: number; fallback: boolean };
  const [diagGaps, setDiagGaps] = useState<DiagGap[]>([]);
  const diagPendingRef = useRef<{
    kind: "loop" | "seam";
    t0: number;
    playingAt: number;
    pos0: number | null;
    startPos: number;
    sawStop: boolean;
    fallback: boolean;
  } | null>(null);
  const diagFallbackRef = useRef<boolean>(false);
  const diagStart = useCallback(
    (kind: "loop" | "seam", alreadyPlaying: boolean, startPos = 0) => {
      if (!diagEnabled) return;
      const now = Date.now();
      diagPendingRef.current = {
        kind,
        t0: now,
        playingAt: alreadyPlaying ? now : 0,
        pos0: null,
        startPos,
        sawStop: false,
        fallback: diagFallbackRef.current,
      };
      diagFallbackRef.current = false;
    },
    [diagEnabled],
  );
  const videoRefA = useRef<VideoPlayer | null>(null);
  const videoRefB = useRef<VideoPlayer | null>(null);
  const activeVideoRef = useRef<VideoPlayer | null>(null);
  // URIs the players were last asked to load (replace() dedupe)
  const loadedAUriRef = useRef<string | null>(
    isPlayableVideo ? allSegments[0] ?? post.media_url : null,
  );
  const loadedBUriRef = useRef<string | null>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const preloadReadyRef = useRef<boolean>(false);
  // Seam timing (same-file hard cuts): how long the run-up takes from its start
  // to the swap. The next run-up starts that many ms before the segment ends.
  const seamLeadMsRef = useRef<number>(SEAM_LEAD_INITIAL_MS);
  const seamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True while the idle player is already playing its run-up (the swap then only
  // flips visibility and sound; no seek, no play).
  const seamRunupActiveRef = useRef<boolean>(false);
  const lastSwapHardCutRef = useRef<boolean>(false);
  // Ping-pong loop: how long before the end the idle player starts (its measured
  // start-up time), and whether this cycle's swap has been armed.
  const loopLeadMsRef = useRef<number>(LOOP_LEAD_INITIAL_MS);
  const loopArmedRef = useRef<boolean>(false);
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
  const shouldMountPreload = isPlayableVideo && active && (allSegments.length > 1 || pingPongPost);

  // Keep player refs + activeVideoRef in sync with the active slot
  useEffect(() => {
    videoRefA.current = playerA;
    videoRefB.current = playerB;
    activeSlotRef.current = activeSlot;
    activeVideoRef.current = activeSlot === 0 ? playerA : playerB;
  }, [activeSlot, playerA, playerB]);

  // Per-slot source URIs (matches the old per-slot `source` props)
  const slotAUri = activeSlot === 0 ? currentUri : preloadUri;
  const slotBUri = activeSlot === 1 ? currentUri : preloadUri;

  // Replace player sources when the active/preload segment changes
  useEffect(() => {
    if (!isPlayableVideo) return;
    if (loadedAUriRef.current !== slotAUri) {
      loadedAUriRef.current = slotAUri;
      playerA.replace({ uri: slotAUri });
    }
  }, [slotAUri, playerA, isPlayableVideo]);

  useEffect(() => {
    if (shouldMountPreload) {
      if (loadedBUriRef.current !== slotBUri) {
        loadedBUriRef.current = slotBUri;
        playerB.replace({ uri: slotBUri });
      }
    } else if (loadedBUriRef.current !== null) {
      loadedBUriRef.current = null;
      playerB.replace(null);
    }
  }, [shouldMountPreload, slotBUri, playerB]);

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

  // Playback control (mirrors the old shouldPlay/isLooping/isMuted props)
  useEffect(() => {
    if (!isPlayableVideo) return;
    const canPlay = active && playbackReady && !isPaused && post._optimistic?.status !== "failed";
    playerA.muted = activeSlot === 0 ? !active : true;
    playerA.loop = allSegments.length === 1 && activeSlot === 0;
    if (activeSlot === 0 && canPlay) {
      playerA.play();
    } else {
      playerA.pause();
    }
    playerB.muted = activeSlot === 1 ? !active : true;
    playerB.loop = pingPongPost && activeSlot === 1;
    if (activeSlot === 1 && canPlay && shouldMountPreload) {
      playerB.play();
    } else {
      playerB.pause();
    }
  }, [playerA, playerB, activeSlot, active, playbackReady, isPaused, shouldMountPreload, allSegments.length, pingPongPost, isPlayableVideo, post._optimistic?.status]);

  // Single-file posts: once playing, do not make play() wait to rebuffer, so the
  // restart after a loop starts immediately (iOS automaticallyWaitsToMinimizeStalling).
  // Before the first frame it stays at the default so the initial load is unchanged.
  useEffect(() => {
    if (!isPlayableVideo || allSegments.length !== 1) return;
    const options = { waitsToMinimizeStalling: !playbackReady };
    playerA.bufferOptions = options;
    playerB.bufferOptions = options;
  }, [isPlayableVideo, allSegments.length, playbackReady, playerA, playerB]);

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
  // Prop-driven playback can miss a false→true transition after mount (e.g.
  // when initialScrollIndex causes a brief inactive→active transition).
  // Explicit play() guarantees playback regardless.
  useEffect(() => {
    if (active) {
      setIsPaused(false);
      if (playbackReady) {
        videoRef.current?.play();
      }
    }
  }, [active, playbackReady]);

  // Qualified view: the viewer watched this post for >= 3 seconds while it was
  // the active (60%-visible, focused) feed item. Feeds the exposure gate on the
  // verdict checkpoint (posts.qualified_view_count). Dedupe per viewer/post is
  // enforced server-side by post_qualified_views; the Set avoids repeat RPCs
  // when scrolling back to a post.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      if (qualifiedViewRecorded.has(post.id)) return;
      qualifiedViewRecorded.add(post.id);
      supabase
        .rpc("record_qualified_view", { p_post_id: post.id })
        .then(null, () => {
          // Recording failed — clear the dedupe so a later activation retries.
          qualifiedViewRecorded.delete(post.id);
        });
    }, QUALIFIED_VIEW_MS);
    return () => clearTimeout(timer);
  }, [active, post.id]);

  // Raw view: fires immediately when the post becomes the active, playing feed
  // item — a basic impression, no watch-duration gate and no author exclusion
  // (unlike qualified views). Feeds posts.view_count shown on the feed's eye
  // icon. Dedupe per viewer/post is enforced server-side by post_raw_views;
  // the Set avoids repeat RPCs when scrolling back to a post.
  useEffect(() => {
    if (!active) return;
    if (rawViewRecorded.has(post.id)) return;
    rawViewRecorded.add(post.id);
    supabase
      .rpc("record_raw_view", { p_post_id: post.id })
      .then(null, () => {
        // Recording failed — clear the dedupe so a later activation retries.
        rawViewRecorded.delete(post.id);
      });
  }, [active, post.id]);

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
        if (ref) ref.currentTime = seekTo / 1000;
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

  // Reset segment index and dual-player state when post changes
  useEffect(() => {
    setSegIdx(0);
    segIdxRef.current = 0;
    setOutputTimeMs(0);
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
    lastSwapHardCutRef.current = false;
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
    // Same-file seams can be 350 ms apart, so their debounce is much shorter.
    if (now - lastAdvanceTimeRef.current < (hasSharedSegmentUrls ? 120 : 500)) {
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

    // Seam between two segments of the same file: a hard cut. No dissolve (it
    // would blend two moments of one recording). Normally the incoming player is
    // already playing its run-up (muted, hidden) and is at trimStart: the swap
    // only flips visibility and sound. Without a run-up (fallback) it seeks and
    // starts here. The outgoing player stops at the swap.
    if (hasSharedSegmentUrls && slotAlreadyLoaded && allSegments[current] === targetUri) {
      const outgoing = newSlot === 0 ? videoRefB.current : videoRefA.current;
      const runupActive = seamRunupActiveRef.current;
      seamRunupActiveRef.current = false;
      if (outgoing) {
        outgoing.pause();
        outgoing.muted = true;
      }
      if (newActiveRef) {
        if (!runupActive) newActiveRef.currentTime = seekTo / 1000;
        newActiveRef.muted = !active;
        if (active && !isPaused) newActiveRef.play();
      }
      slotAOpacity.setValue(newSlot === 0 ? 1 : 0);
      slotBOpacity.setValue(newSlot === 0 ? 0 : 1);
      lastSwapHardCutRef.current = true;
      if (!runupActive) diagFallbackRef.current = true;
      diagStart("seam", !!newActiveRef && runupActive && newActiveRef.playing, 0);
      // Safety net: after a swap the incoming player must be playing. If both
      // players ended up paused (and the post should be playing), start it.
      if (active && !isPaused && newActiveRef) {
        const swapped = newActiveRef;
        setTimeout(() => {
          if (activeVideoRef.current === swapped && !isPausedRef.current && !swapped.playing) swapped.play();
        }, 200);
      }
      playbackReadyRef.current = true;
      readyForDisplayRef.current = true;
      setPlaybackReady(true);
      pendingCrossfadeRef.current = null;
      return;
    }
    lastSwapHardCutRef.current = false;
    seamRunupActiveRef.current = false;
    diagFallbackRef.current = true;
    diagStart("seam", false, 0);

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
      // expo-video seeks via the currentTime setter (synchronous) — crossfade right after.
      if (newActiveRef) {
        newActiveRef.currentTime = seekTo / 1000;
      }
      runCrossfade();
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
  }, [allSegments, shouldMountPreload, post.id, post.trim_data, hasSharedSegmentUrls, active, isPaused, diagStart]);

  // Shared-URL segments never trigger a preload load (the file is already in the
  // idle slot), so the idle player is parked by hand: paused, muted, hidden and
  // sitting RUNUP_MS before the next segment's trimStart, ready to be started.
  // Checked every 50 ms so it also catches the first seam (idle player still
  // loading at mount). After a crossfade swap (mixed posts) it waits 250 ms so
  // the fading-out frame is not disturbed; after a hard cut it parks at once.
  const parkPositionMs = useCallback(
    (nextIndex: number) => Math.max(0, (post.trim_data?.[nextIndex]?.trimStartMs ?? 0) - RUNUP_MS),
    [post.trim_data],
  );
  useEffect(() => {
    if (!shouldMountPreload || !hasSharedSegmentUrls) return;
    const timer = setInterval(() => {
      if (seamTimerRef.current) return;
      if (!lastSwapHardCutRef.current && Date.now() - slotSwapTimeRef.current < 250) return;
      const idleIsB = activeSlotRef.current === 0;
      const idle = idleIsB ? videoRefB.current : videoRefA.current;
      const loaded = idleIsB ? slotBLoadedUriRef.current : slotALoadedUriRef.current;
      if (!idle || loaded !== preloadUri || idle.status !== "readyToPlay") return;
      const target = parkPositionMs((segIdxRef.current + 1) % allSegments.length);
      if (Math.abs(idle.currentTime * 1000 - target) > 40) {
        idle.pause();
        idle.muted = true;
        idle.currentTime = target / 1000;
      }
    }, 50);
    return () => clearInterval(timer);
  }, [shouldMountPreload, hasSharedSegmentUrls, preloadUri, parkPositionMs, allSegments.length]);

  // Seam into the same file. Armed a little before the lead point, then polled
  // every 16 ms: when the outgoing player is `lead` ms from its trimEnd the idle
  // player (parked RUNUP_MS before the next trimStart) starts playing, muted and
  // hidden. The moment its position reaches the next trimStart, advanceSegment
  // swaps. If that has not happened SEAM_FALLBACK_MS after the run-up started,
  // advanceSegment swaps anyway (seeking and playing the incoming player).
  const stopSeamTimer = useCallback(() => {
    if (seamTimerRef.current) {
      clearInterval(seamTimerRef.current);
      seamTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    return () => {
      stopSeamTimer();
      seamRunupActiveRef.current = false;
    };
  }, [post.id, stopSeamTimer]);

  const armSeam = useCallback(() => {
    if (seamTimerRef.current) return;
    const current = segIdxRef.current;
    const next = (current + 1) % allSegments.length;
    const outgoing = activeSlotRef.current === 0 ? videoRefA.current : videoRefB.current;
    const incoming = activeSlotRef.current === 0 ? videoRefB.current : videoRefA.current;
    const outTrimEnd = post.trim_data?.[current]?.trimEndMs ?? 0;
    const nextStart = post.trim_data?.[next]?.trimStartMs ?? 0;
    if (!outgoing || !incoming || outTrimEnd <= 0) {
      if (__DEV__) console.log(`[seam:${post.id.slice(0, 8)}] FALLBACK: no players or no trim data`);
      advanceSegment();
      return;
    }
    const armedAt = Date.now();
    let runupStartedAt = 0;
    seamTimerRef.current = setInterval(() => {
      const now = Date.now();
      // Cut-out footage is never audible: the outgoing player is muted the
      // moment it reaches its trimEnd, even if the swap is a few ms late.
      if (outgoing.currentTime * 1000 >= outTrimEnd - 5) outgoing.muted = true;
      if (runupStartedAt === 0) {
        if (outgoing.currentTime * 1000 >= outTrimEnd - seamLeadMsRef.current) {
          runupStartedAt = now;
          // Normally already parked; if not, seek there first (the fallback covers a slow seek).
          const parkAt = parkPositionMs(next);
          if (Math.abs(incoming.currentTime * 1000 - parkAt) > 40) incoming.currentTime = parkAt / 1000;
          incoming.muted = true;
          incoming.play();
          seamRunupActiveRef.current = true;
        } else if (now - armedAt > 1000) {
          if (__DEV__) console.log(`[seam:${post.id.slice(0, 8)}] FALLBACK: outgoing never reached its lead point`);
          stopSeamTimer();
          advanceSegment();
        }
        return;
      }
      const reached = incoming.currentTime * 1000 >= nextStart;
      if (reached || now - runupStartedAt >= SEAM_FALLBACK_MS) {
        stopSeamTimer();
        if (__DEV__) {
          console.log(
            reached
              ? `[seam:${post.id.slice(0, 8)}] swap ${now - runupStartedAt} ms after run-up start (lead ${Math.round(seamLeadMsRef.current)} ms)`
              : `[seam:${post.id.slice(0, 8)}] FALLBACK: incoming at ${Math.round(incoming.currentTime * 1000)} ms, wanted ${nextStart} ms after ${now - runupStartedAt} ms`,
          );
        }
        if (reached) {
          // Running average (weight 1/4 on the newest), clamped to 0-SEAM_LEAD_MAX_MS.
          seamLeadMsRef.current = Math.min(
            SEAM_LEAD_MAX_MS,
            Math.max(0, seamLeadMsRef.current * 0.75 + (now - runupStartedAt) * 0.25),
          );
        } else {
          seamRunupActiveRef.current = false;
        }
        advanceSegment();
      }
    }, SEAM_POLL_MS);
  }, [allSegments.length, post.trim_data, advanceSegment, parkPositionMs, stopSeamTimer]);

  // Ping-pong loop for a single file. Armed shortly before the end of the file;
  // polled every 16 ms. When the playing player is `lead` ms from the end the idle
  // one (parked at 0) starts, muted and hidden; when the playing one is
  // LOOP_SWAP_BEFORE_END_MS from the end, visibility and sound swap and the old
  // player is parked at 0. If the idle player is not loaded or ready, or the
  // playing one already looped by itself, nothing is swapped and the native loop
  // (still on) does the restart.
  const armLoop = useCallback(
    (durationMs: number) => {
      if (seamTimerRef.current) return;
      const aPlaying = activeSlotRef.current === 0;
      const outgoing = aPlaying ? videoRefA.current : videoRefB.current;
      const incoming = aPlaying ? videoRefB.current : videoRefA.current;
      const idleLoaded = aPlaying ? slotBLoadedUriRef.current : slotALoadedUriRef.current;
      if (
        !outgoing ||
        !incoming ||
        idleLoaded !== currentUri ||
        incoming.status !== "readyToPlay" ||
        incoming.currentTime * 1000 > 60
      ) {
        diagFallbackRef.current = true;
        return;
      }
      const armedAt = Date.now();
      let startedAt = 0;
      let measured = false;
      const abort = () => {
        stopSeamTimer();
        if (startedAt > 0) {
          incoming.pause();
          incoming.muted = true;
          incoming.currentTime = 0;
        }
        diagFallbackRef.current = true;
      };
      seamTimerRef.current = setInterval(() => {
        const now = Date.now();
        const outMs = outgoing.currentTime * 1000;
        if (outMs < durationMs / 2) {
          abort(); // the playing player already looped on its own
          return;
        }
        if (startedAt === 0) {
          if (outMs >= durationMs - loopLeadMsRef.current) {
            startedAt = now;
            incoming.muted = true;
            incoming.play();
          } else if (now - armedAt > 1500) {
            abort();
          }
          return;
        }
        if (!measured && incoming.currentTime * 1000 > 15) {
          measured = true;
          // Start-up time of the idle player = how early it has to start.
          loopLeadMsRef.current = Math.min(
            SEAM_LEAD_MAX_MS,
            Math.max(0, loopLeadMsRef.current * 0.75 + (now - startedAt) * 0.25),
          );
        }
        if (outMs < durationMs - LOOP_SWAP_BEFORE_END_MS) return;
        stopSeamTimer();
        if (!incoming.playing) {
          abort();
          return;
        }
        const newSlot: 0 | 1 = aPlaying ? 1 : 0;
        outgoing.pause();
        outgoing.muted = true;
        incoming.muted = !active;
        slotAOpacity.setValue(newSlot === 0 ? 1 : 0);
        slotBOpacity.setValue(newSlot === 0 ? 0 : 1);
        activeSlotRef.current = newSlot;
        activeVideoRef.current = incoming;
        slotSwapTimeRef.current = now;
        setActiveSlot(newSlot);
        outgoing.currentTime = 0; // park for the next cycle
        loopArmedRef.current = false;
        diagStart("loop", true, 0);
        if (__DEV__) {
          console.log(
            `[loop:${post.id.slice(0, 8)}] swapped; idle started ${now - startedAt} ms ago at ${Math.round(incoming.currentTime * 1000)} ms (lead ${Math.round(loopLeadMsRef.current)} ms)`,
          );
        }
        // Safety net: never leave both players paused.
        setTimeout(() => {
          if (activeVideoRef.current === incoming && !isPausedRef.current && !incoming.playing) incoming.play();
        }, 200);
      }, SEAM_POLL_MS);
    },
    [active, currentUri, post.id, stopSeamTimer, diagStart],
  );

  // When video finishes, advance to next segment or loop
  const onSegmentStatus = useCallback(
    (status: VideoPlaybackStatus) => {
      handleStallDetection(status);

      if (!status.isLoaded) return;

      // Diagnostics (internal testers, switch on): time from the loop restart or
      // seam swap to the player playing again, and from there to the position
      // advancing.
      const dp = diagPendingRef.current;
      if (dp) {
        const now = Date.now();
        if (!status.isPlaying) dp.sawStop = true;
        if (
          dp.playingAt === 0 &&
          status.isPlaying &&
          (dp.kind === "seam" || dp.sawStop || status.positionMillis < dp.startPos - 1000)
        ) {
          dp.playingAt = now;
        }
        let finished: DiagGap | null = null;
        if (dp.playingAt > 0 && dp.pos0 === null) {
          dp.pos0 = status.positionMillis;
        } else if (dp.playingAt > 0 && status.isPlaying && status.positionMillis > (dp.pos0 ?? 0) + 15) {
          finished = {
            kind: dp.kind,
            toPlayingMs: dp.playingAt - dp.t0,
            toAdvanceMs: now - dp.playingAt,
            fallback: dp.fallback,
          };
        } else if (now - dp.t0 > 3000) {
          finished = { kind: dp.kind, toPlayingMs: -1, toAdvanceMs: -1, fallback: dp.fallback };
        }
        if (finished) {
          diagPendingRef.current = null;
          const gap = finished;
          setDiagGaps((prev) => [...prev.slice(-2), gap]);
        }
      }
      if (diagEnabled && status.didJustFinish && allSegments.length === 1) {
        diagStart("loop", false, status.positionMillis);
      }

      if (hasTimedOverlays) {
        setOutputTimeMs(
          getOutputTimeMs(
            segIdxRef.current,
            status.positionMillis,
            post.trim_data ?? allSegments.map(() => ({ trimStartMs: 0, trimEndMs: Infinity })),
          ),
        );
      }

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
          if (videoRef.current) {
            videoRef.current.currentTime = trimStartRef.current / 1000;
          }
          return;
        }
      }

      // ── Single-file loop: arm the ping-pong shortly before the end of the file.
      // Plain single-file posts have no JS early seek: the native loop (or the
      // ping-pong) restarts them. ──
      if (pingPongPost && sourceDur > 0) {
        if (status.positionMillis < sourceDur / 2) {
          loopArmedRef.current = false;
        } else if (
          !loopArmedRef.current &&
          status.isPlaying &&
          status.positionMillis >= sourceDur - (loopLeadMsRef.current + SEAM_ARM_AHEAD_MS)
        ) {
          loopArmedRef.current = true;
          armLoop(sourceDur);
        }
      }

      // ── Stale position guard ──
      // After a slot swap, the outgoing slot's last position report can
      // arrive before the incoming slot's seek-to-0 completes. This stale
      // position (often near the previous segment's trimEnd) can trigger a
      // premature END OF SEGMENT on the new segment. Skip end-of-segment
      // detection for 400ms after a slot swap to let the seek settle.
      const msSinceSwap = Date.now() - slotSwapTimeRef.current;
      // After a same-file hard cut the incoming player was already playing, so
      // only 40 ms are skipped (pieces can be 350 ms long).
      const isStalePosition = msSinceSwap < (lastSwapHardCutRef.current ? 40 : 400);

      // ── Unified end-of-segment detection ──
      if (!isStalePosition && !status.didJustFinish && !trimEndHandledRef.current && sourceDur > 0 && !nativeLoopPost) {
        const effectiveTrimEnd =
          trimEndRef.current > 0
            ? Math.min(trimEndRef.current, sourceDur)
            : sourceDur;

        const sameFileSeam =
          hasSharedSegmentUrls &&
          allSegments.length > 1 &&
          allSegments[segIdxRef.current] === allSegments[(segIdxRef.current + 1) % allSegments.length];
        const margin = sameFileSeam ? seamLeadMsRef.current + SEAM_ARM_AHEAD_MS : 120;
        if (status.positionMillis >= effectiveTrimEnd - margin) {
          trimEndHandledRef.current = true;
          if (allSegments.length === 1) {
            if (videoRef.current) {
              videoRef.current.currentTime = trimStartRef.current / 1000;
              trimEndHandledRef.current = false;
            }
          } else if (sameFileSeam) {
            armSeam();
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
    [allSegments, hasSharedSegmentUrls, hasTimedOverlays, post.trim_data, handleStallDetection, advanceSegment, armSeam, armLoop, nativeLoopPost, pingPongPost, post.id, diagEnabled, diagStart],
  );

  // ── Error recovery: retry loading ──────────────────────────────────
  const handleRetryVideo = useCallback(() => {
    setVideoError(null);
    const p = videoRef.current;
    if (!p) return;
    p.replace({ uri: currentUri });
    p.loop = allSegments.length === 1;
    p.muted = !active;
    if (active) p.play();
  }, [currentUri, active, videoRef, allSegments.length]);

  // ── Delete this Drop (owner only) ──────────────────────────────────
  const handleDelete = useCallback(() => {
    Alert.alert(
      "Delete this post?",
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

  // ── More menu: owner Delete / non-owner Report (same actions, same
  // owner-only permissions as the previous dedicated rail buttons) ──
  const handleMore = useCallback(() => {
    if (isOwner) {
      Alert.alert("More options", undefined, [
        { text: "Delete", style: "destructive", onPress: handleDelete },
        { text: "Cancel", style: "cancel" },
      ]);
    } else {
      Alert.alert("More options", undefined, [
        {
          text: "Report",
          style: "destructive",
          onPress: () => reportContent("post", post.id),
        },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [isOwner, handleDelete, reportContent, post.id]);

  // ── Per-slot callbacks for dual-player ─────────────────────────────
  // Only the active slot runs the full playback/stall logic; the inactive
  // slot just tracks preload readiness via onReadyForDisplay.
  const onStatusSlotA = useCallback(
    (status: VideoPlaybackStatus) => {
      if (activeSlotRef.current === 0) {
        onSegmentStatus(status);
      }
    },
    [onSegmentStatus],
  );
  const onStatusSlotB = useCallback(
    (status: VideoPlaybackStatus) => {
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
        if (videoRefA.current) {
          videoRefA.current.currentTime = seekTo / 1000;
        }
        Animated.parallel([
          Animated.timing(slotBOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(slotAOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]).start();
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
          if (videoRefA.current) {
            videoRefA.current.currentTime = seekTo / 1000;
          }
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
        if (videoRefB.current) {
          videoRefB.current.currentTime = seekTo / 1000;
        }
        Animated.parallel([
          Animated.timing(slotAOpacity, { toValue: 0, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(slotBOpacity, { toValue: 1, duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]).start();
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
          if (videoRefB.current) {
            videoRefB.current.currentTime = seekTo / 1000;
          }
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

  const onLoadSlotA = useCallback((info: { durationMillis: number }) => {
    // Track loaded URI on load (fires before onReadyForDisplay) as a fallback
    const loadedUri = activeSlotRef.current === 0 ? currentUri : preloadUri;
    slotALoadedUriRef.current = loadedUri;
    videoLog({ type: "load_success", postId: post.id, durationMs: info.durationMillis });
  }, [post.id, videoLog, currentUri, preloadUri]);

  const onLoadSlotB = useCallback((info: { durationMillis: number }) => {
    const loadedUri = activeSlotRef.current === 1 ? currentUri : preloadUri;
    slotBLoadedUriRef.current = loadedUri;
    videoLog({ type: "load_success", postId: post.id, durationMs: info.durationMillis });
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

  // expo-video player event feeds → per-slot status handlers
  useVideoStatusFeed(playerA, {
    onStatus: onStatusSlotA,
    onLoad: onLoadSlotA,
    onError: onErrorSlotA,
  });
  useVideoStatusFeed(playerB, {
    onStatus: onStatusSlotB,
    onLoad: onLoadSlotB,
    onError: onErrorSlotB,
  });

  const creatorAvatarUri = useMemo(
    () => resolveAvatarUrl(post.profile?.avatar_url ?? null),
    [post.profile?.avatar_url],
  );

  // Pause while an external app opens; resume when we come back to the foreground.
  const pauseForExternalLink = useCallback(() => {
    setIsPaused(true);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        sub.remove();
        setIsPaused(false);
      }
    });
  }, []);

  // ── Creator profile navigation (rail avatar + bottom-left username) ──
  const openCreatorProfile = useCallback(() => {
    if (!user?.id || !post.user_id) return;
    if (post.user_id === user.id) {
      router.push("/(tabs)/profile" as never);
    } else {
      router.push(`/user/${post.user_id}` as never);
    }
  }, [user?.id, post.user_id, router]);

  return (
    <View
      style={itemHeight ? [styles.item, { height: itemHeight }] : styles.item}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0 && (width !== containerDims.w || height !== containerDims.h)) {
          setContainerDims({ w: width, h: height });
        }
      }}
    >
      {isPlayableVideo ? (
        <View style={StyleSheet.absoluteFill}>
          {/* Slot A — primary player, always mounted for video posts */}
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { opacity: slotAOpacity },
            ]}
          >
            <VideoView
              player={playerA}
              style={[
                StyleSheet.absoluteFill,
                post._optimistic?.status === "failed" && { opacity: 0.3 },
              ]}
              contentFit="cover"
              nativeControls={false}
              onFirstFrameRender={onReadySlotA}
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
              <VideoView
                player={playerB}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                nativeControls={false}
                onFirstFrameRender={onReadySlotB}
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

          {/* Internal-tester playback diagnostics (Settings > Playback diagnostics) */}
          {diagEnabled && (
            <View style={styles.diagBox} pointerEvents="none">
              <UiText style={styles.diagText}>url …{post.media_url.slice(-12)}</UiText>
              <UiText style={styles.diagText}>
                seg {post.segments?.length ?? 0} / distinct {new Set(post.segments ?? []).size} · trim{" "}
                {post.trim_data?.length ?? 0}
              </UiText>
              <UiText style={styles.diagText}>
                rt {Updates.runtimeVersion ?? "?"} · upd {Updates.updateId ? Updates.updateId.slice(0, 8) : "embedded"} ·
                render {isVideoRenderAvailable() ? "yes" : "no"}
              </UiText>
              {diagGaps.length === 0 ? (
                <UiText style={styles.diagText}>gaps: waiting for a loop or seam…</UiText>
              ) : (
                diagGaps.map((g, i) => (
                  <UiText key={i} style={styles.diagText}>
                    {g.kind} {g.toPlayingMs}+{g.toAdvanceMs} ms{g.fallback ? " FALLBACK" : ""}
                  </UiText>
                ))
              )}
            </View>
          )}

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
      ) : post.media_deleted_at ? (
        <View style={[StyleSheet.absoluteFill, styles.mediaGone]}>
          {post.thumbnail_url ? (
            <Image
              source={{ uri: post.thumbnail_url }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
            />
          ) : null}
          <View style={styles.mediaGoneLabel}>
            <UiText style={styles.mediaGoneText}>EXPIRED</UiText>
          </View>
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
          {post.text_overlays
            .filter(
              (ov) =>
                (ov.startMs === undefined || outputTimeMs >= ov.startMs) &&
                (ov.endMs === undefined || outputTimeMs < ov.endMs),
            )
            .map((ov) => (
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
            <UiText style={styles.optTitle}>Posting your post</UiText>
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

      {/* Archived scrim — owner-only dim. Archived posts are filtered out of
          every non-owner surface (feeds, other-user profiles), so this only
          ever renders on the creator's own drops. Content dims; UI chrome
          (action rail, TRIAL ENDED badge, username) stays bright. */}
      {(post.status === "archived" || post.status === "expired") && (
        <View style={styles.archivedScrim} pointerEvents="none" />
      )}

      <LinearGradient
        colors={["rgba(0,0,0,0.4)", "transparent"]}
        style={styles.gradTop}
        pointerEvents="none"
      />
      {/* Bottom scrim — transparent → rgba(0,0,0,0.75) at 45% of the 96px
          region behind the tab bar. */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.75)"]}
        locations={[0, 0.45]}
        style={styles.gradBottom}
        pointerEvents="none"
      />

      {/* Right-side vertical action rail — avatar, like, reaction, share,
          more menu, then the view count with reduced weight. */}
      <View
        style={[
          styles.actions,
          { bottom: bottomInset + 22 },
        ]}
      >
        <Pressable
          onPress={openCreatorProfile}
          hitSlop={8}
        >
          <View style={styles.railAvatar}>
            {creatorAvatarUri ? (
              <Image
                source={{ uri: creatorAvatarUri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={100}
                cachePolicy="memory"
              />
            ) : (
              <UiText style={styles.railAvatarInitial}>
                {name.charAt(0).toUpperCase()}
              </UiText>
            )}
          </View>
        </Pressable>
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
          circle
          icon={<Video color="#fff" size={18} strokeWidth={2} />}
          label={String(reactionCount)}
          onPress={onReactions}
        />
        <ActionButton
          icon={<Send color="#fff" size={26} strokeWidth={2} />}
          onPress={onShare}
        />
        <ActionButton
          icon={<MoreHorizontal color="#fff" size={26} strokeWidth={2} />}
          onPress={handleMore}
        />
        <ActionButton
          icon={<Eye color="rgba(255,255,255,0.6)" size={22} strokeWidth={2} />}
          label={String(post.view_count ?? 0)}
          muted
        />
      </View>

      {/* Bottom-left block — status badge, username, caption, sound row */}
      <View
        style={[
          styles.bottom,
          { bottom: bottomInset + 24 },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.badgeSlot} pointerEvents="none">
          <TrialStatusBadge status={post.status} distributionExpiresAt={post.distribution_expires_at} />
        </View>
        <View style={styles.userRow}>
          <Pressable onPress={openCreatorProfile} hitSlop={4}>
            <UiText style={styles.username}>
              @{post.profile?.username ?? "dropper"}
            </UiText>
          </Pressable>
          <UiText style={styles.dotSep}>·</UiText>
          <UiText style={styles.ago}>{ago}</UiText>
        </View>
        <CreatorLinkIcons profile={post.profile} onBeforeOpen={pauseForExternalLink} />
        {post.caption ? (
          <UiText style={styles.caption} numberOfLines={3}>
            {post.caption}
          </UiText>
        ) : null}
        <View style={styles.musicRow}>
          <Music color="rgba(255,255,255,0.6)" size={12} />
          <UiText style={styles.musicText}>
            Original sound
          </UiText>
        </View>
      </View>
    </View>
  );
},
(prev, next) =>
  prev.post === next.post &&
  prev.active === next.active);

const styles = StyleSheet.create({
  /* Feed item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#F5F3EE",
  },
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 90 },
  gradBottom: { position: "absolute", left: 0, right: 0, bottom: 0, height: 96 },

  /* Right-side action rail */
  actions: {
    position: "absolute",
    right: 12,
    alignItems: "center",
    gap: 20,
    zIndex: 999,
  },
  railAvatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    overflow: "hidden",
    backgroundColor: "#B8281A",
    alignItems: "center",
    justifyContent: "center",
  },
  railAvatarInitial: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "500" as const,
  },
  actionBtn: { alignItems: "center", gap: 4 },
  actionIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  actionIconCirclePressed: { backgroundColor: "rgba(255,255,255,0.28)" },
  actionLabel: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "500" as const,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  actionLabelMuted: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "500" as const,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },

  /* Bottom info */
  bottom: {
    position: "absolute",
    left: 18,
    right: 84,
    gap: 6,
    zIndex: 999,
  },
  badgeSlot: { marginBottom: 4 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  username: {
    color: "#fff",
    fontWeight: "500" as const,
    fontSize: 15,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 3,
  },
  dotSep: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontWeight: "400" as const,
  },
  ago: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontWeight: "400" as const,
  },
  caption: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500" as const,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 3,
  },
  musicRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  musicText: { color: "rgba(255,255,255,0.6)", fontSize: 12 },

  /* Buffering indicator */
  diagBox: {
    position: "absolute",
    top: 72,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.72)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 2,
  },
  diagText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600" as const,
  },
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

  /* Media deleted after expiry: thumbnail (or plain) background + label */
  mediaGone: {
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
  },
  mediaGoneLabel: {
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  mediaGoneText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700" as const,
    letterSpacing: 1,
  },

  /* Stall / error recovery overlay */
  stallOverlay: {
    ...StyleSheet.absoluteFill,
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

  /* Archived scrim — full-bleed dark wash over the content */
  archivedScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.6)",
  },

  /* Optimistic posting overlay */
  optOverlay: {
    ...StyleSheet.absoluteFill,
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
