import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
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
} from "lucide-react-native";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";

import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { FeedAvatar } from "@/components/Avatar";
import { theme, getDropWindowState } from "@/constants/theme";
import { usePosts, type Post, type TextOverlay, type TextBackgroundStyle } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";

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

  // Video error state for retry UI
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);

  // ── Pre-buffering: don't start playback until the first frame is ready.
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate & pause state when the data source changes
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    setPlaybackReady(false);
    playbackReadyRef.current = false;
    readyForDisplayRef.current = false;
    setIsPaused(false);
  }, [post.id, segIdx]);

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

  // Clear prebuffer safety timer on unmount or when deps change
  useEffect(() => {
    return () => {
      if (prebufferTimerRef.current) {
        clearTimeout(prebufferTimerRef.current);
        prebufferTimerRef.current = null;
      }
    };
  }, [post.id, segIdx]);

  // ── Safety timeout: if onReadyForDisplay never fires (rare Android edge case)
  useEffect(() => {
    if (!active || playbackReady) return;

    prebufferTimerRef.current = setTimeout(() => {
      if (!playbackReadyRef.current) {
        playbackReadyRef.current = true;
        setPlaybackReady(true);
      }
    }, 3000);

    return () => {
      if (prebufferTimerRef.current) {
        clearTimeout(prebufferTimerRef.current);
        prebufferTimerRef.current = null;
      }
    };
  }, [active, playbackReady, post.id]);

  // ── Stall detection + recovery ─────────────────────────────────────
  const videoLog = useCallback((e: VideoEvent) => {
    // Silent logging to keep console clean
  }, []);

  const {
    videoRef,
    stallState,
    handlePlaybackStatus: handleStallDetection,
  } = useVideoStallDetection(post.id, active, currentUri, videoLog);

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

  // Reset segment index when post changes
  useEffect(() => {
    setSegIdx(0);
    setVideoError(null);
    errorCountRef.current = 0;
    setIsPaused(false);
  }, [post.id]);

  // When video finishes, advance to next segment or loop
  const onSegmentStatus = useCallback(
    (status: AVPlaybackStatus) => {
      handleStallDetection(status);

      if (!status.isLoaded) return;

      // ── Pre-buffer gate ──
      if (!playbackReadyRef.current) {
        const hasFrame = readyForDisplayRef.current;
        const notBuffering = !status.isBuffering;
        if (hasFrame || notBuffering) {
          playbackReadyRef.current = true;
          setPlaybackReady(true);
          if (prebufferTimerRef.current) {
            clearTimeout(prebufferTimerRef.current);
            prebufferTimerRef.current = null;
          }
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

      // End-of-trim detection
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
        const current = segIdxRef.current;
        if (allSegments.length === 1) {
          videoRef.current
            ?.setPositionAsync(trimStartRef.current)
            .then(() => {
              trimEndHandledRef.current = false;
            })
            .catch(() => {});
        } else {
          const next = (current + 1) % allSegments.length;
          setSegIdx(next);
        }
        return;
      }

      // ── Untrimmed end-of-source: advance before native loop ──
      if (
        sourceDur > 0 &&
        status.positionMillis >= sourceDur - 120 &&
        trimEndRef.current <= 0
      ) {
        const current = segIdxRef.current;
        const next = (current + 1) % allSegments.length;
        setSegIdx(next);
      }
    },
    [allSegments.length, handleStallDetection],
  );

  // ── Error recovery: retry loading ──────────────────────────────────
  const handleRetryVideo = useCallback(() => {
    setVideoError(null);
    videoRef.current
      ?.unloadAsync()
      .then(() =>
        videoRef.current?.loadAsync(
          { uri: currentUri },
          { shouldPlay: active, isLooping: true },
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
          <Video
            key={`${post.id}_seg${segIdx}`}
            ref={videoRef}
            source={{ uri: currentUri }}
            style={[
              StyleSheet.absoluteFill,
              post._optimistic?.status === "failed" && { opacity: 0.3 },
            ]}
            resizeMode={ResizeMode.COVER}
            isLooping
            shouldPlay={active && playbackReady && !isPaused && post._optimistic?.status !== "failed"}
            isMuted={!active}
            useNativeControls={false}
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={onSegmentStatus}
            onError={(error: string) => {
              errorCountRef.current += 1;
              setVideoError(error);
              videoLog({ type: "load_error", postId: post.id, error });
            }}
            onLoad={(status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
              videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
            }}
            onLoadStart={() => {
              videoLog({ type: "load_start", postId: post.id, uri: currentUri });
            }}
            onReadyForDisplay={() => {
              videoLog({ type: "ready_for_display", postId: post.id });
              setVideoError(null);
              readyForDisplayRef.current = true;
              if (!playbackReadyRef.current) {
                playbackReadyRef.current = true;
                setPlaybackReady(true);
                if (prebufferTimerRef.current) {
                  clearTimeout(prebufferTimerRef.current);
                  prebufferTimerRef.current = null;
                }
              }
            }}
          />

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
    backgroundColor: "#0A0A14",
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
    fontWeight: "700" as const,
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
    borderRadius: 6,
  },
  livePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  liveTagText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
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
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  username: {
    color: "#fff",
    fontWeight: "800" as const,
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
    borderRadius: 16,
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
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
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
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.1)",
    overflow: "hidden",
  },
  optProgressFill: {
    height: "100%" as unknown as number,
    borderRadius: 2,
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
    fontWeight: "800" as const,
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
    borderRadius: 28,
    backgroundColor: "rgba(255,59,48,0.15)",
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
    borderRadius: 999,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 4,
  },
  optRetryText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
  optDismissBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
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
    fontWeight: "800" as const,
    textAlign: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden",
    textShadowColor: "rgba(0,0,0,0.4)",
    textShadowRadius: 2,
  },
});
