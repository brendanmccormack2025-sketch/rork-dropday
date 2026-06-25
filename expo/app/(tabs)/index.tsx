import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewToken,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useFocusEffect, useRouter } from "expo-router";
import { useVideoFocus } from "@/hooks/useVideoFocus";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import {
  Heart,
  Music2,
  Send,
  Zap,
  Search,
  X,
  Users,
  Sparkles,
  RotateCcw,
} from "lucide-react-native";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";

import DropletLogo from "@/components/DropletLogo";
import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { FeedAvatar } from "@/components/Avatar";
import { theme, getDropWindowState, formatCountdown } from "@/constants/theme";
import { usePosts, type Post, type OptimisticStatus } from "@/providers/PostsProvider";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");
const TAB_BAR_HEIGHT = 88;
const FREE_VIEWS_BEFORE_GATE = 5;

export default function FeedScreen() {
  const router = useRouter();
  const { feed, feedLoading, refetchFeed, refetchMyPosts, hasPostedInWindow, retryOptimisticPost } = usePosts();
  const [now, setNow] = useState<Date>(new Date());
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [viewedIds, setViewedIds] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sharePost, setSharePost] = useState<Post | null>(null);
  const screenFocused = useVideoFocus();
  const isFirstFocusRef = useRef<boolean>(true);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const win = useMemo(() => getDropWindowState(now), [now]);
  const countdown = useMemo(
    () => formatCountdown(win.isOpen ? win.msUntilClose : win.msUntilOpen),
    [win]
  );

  const viewedCount = viewedIds.size;
  // MVP: participation gate disabled — all users can scroll the full feed.
  // Re-enable before launch by restoring: !hasPostedInWindow && viewedCount >= FREE_VIEWS_BEFORE_GATE
  const gateActive = false;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Refetch both feed and myPosts so hasPostedInWindow updates correctly.
    // Previously only feed was refetched, so the participation gate
    // would stay active even after posting a drop.
    await Promise.all([refetchFeed(), refetchMyPosts()]);
    setRefreshing(false);
  }, [refetchFeed, refetchMyPosts]);

  // Refetch on tab focus — ensures fresh data when returning from camera
  // or edit-profile without needing a manual pull-to-refresh.
  // Skip the initial mount: useQuery already fetches on cold start,
  // and an extra refetch here can race with the feed Video player's
  // initialization, causing a 100% reproducible freeze on cold open.
  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }
      refetchFeed();
    }, [refetchFeed])
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
        const id = (first.item as Post | undefined)?.id;
        if (id) {
          setViewedIds((prev) => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
      }
    }
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const getItemLayout = useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    []
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <FeedItem
        post={item}
        active={index === activeIndex && screenFocused}
        live={win.isOpen}
        onShare={() => setSharePost(item)}
        onReactions={() => {
        if ((item.reaction_count ?? 0) > 0) {
          router.push(`/post/${item.id}/reaction-tree` as never);
        } else {
          router.push(`/camera?reactingTo=${item.id}` as never);
        }
      }}
        onRetry={() => retryOptimisticPost(item._optimistic?.tempId ?? "")}
      />
    ),
    [activeIndex, screenFocused, win.isOpen, router, retryOptimisticPost]
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={feed}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        ListEmptyComponent={
          feedLoading ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptySub}>Loading drops…</Text>
            </View>
          ) : (
            <EmptyState />
          )
        }
        contentContainerStyle={
          feed.length === 0 ? styles.emptyContainer : undefined
        }
        snapToInterval={SCREEN_H}
        snapToAlignment="start"
        decelerationRate="fast"
        bounces
        showsVerticalScrollIndicator={false}
        getItemLayout={feed.length > 0 ? getItemLayout : undefined}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        scrollEnabled={!gateActive}
        // windowSize=5 instead of 3 gives more buffer before views are recycled.
        // removeClippedSubviews is intentionally omitted — on native it detaches
        // Video backing views during scroll, which can freeze expo-av players.
        windowSize={5}
        maxToRenderPerBatch={3}
        initialNumToRender={2}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.accent}
            progressBackgroundColor={theme.card}
          />
        }
      />

      {/* Floating top header + search */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.headerWrap}>
        <View style={styles.headerRow} pointerEvents="box-none">
          <View style={styles.brandRow}>
            <DropletLogo size={22} />
            <Text style={styles.brand}>DropDay</Text>
          </View>
          <View
            style={[styles.pill, win.isOpen && styles.pillLive]}
            pointerEvents="none"
          >
            {win.isOpen ? (
              <Zap color="#050505" size={10} fill="#050505" />
            ) : (
              <View style={styles.dot} />
            )}
            <Text style={[styles.pillText, win.isOpen && styles.pillTextLive]}>
              {win.isOpen ? "LIVE" : countdown}
            </Text>
          </View>
        </View>

        {/* Faint TikTok-style search bar */}
        <Pressable
          onPress={() => setSearchOpen(true)}
          style={styles.searchBar}
        >
          <Search color="rgba(255,255,255,0.55)" size={15} />
          <Text style={styles.searchPlaceholder}>
            Search friends, creators, hashtags
          </Text>
        </Pressable>
      </SafeAreaView>

      {/* 5-view participation gate */}
      {gateActive && (
        <GateOverlay
          onDrop={() => router.push("/camera")}
          viewed={viewedCount}
        />
      )}

      {/* Search overlay */}
      <SearchOverlay
        visible={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery("");
        }}
        query={searchQuery}
        onQueryChange={setSearchQuery}
      />

      {/* Share sheet */}
      <ShareSheet
        post={sharePost}
        onClose={() => setSharePost(null)}
      />
    </View>
  );
}

const FeedItem = memo(function FeedItem({
  post,
  active,
  live,
  onShare,
  onReactions,
  onRetry,
}: {
  post: Post;
  active: boolean;
  live: boolean;
  onShare: () => void;
  onReactions: () => void;
  onRetry: () => void;
}) {
  const [liked, setLiked] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const { reactionsByParent } = usePosts();
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
  //    Uses onReadyForDisplay (deterministic, fires once) + a 3s safety timeout
  //    to avoid the freeze-when-shouldPlay-fires-too-early pattern.
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate & pause state when the data source changes
  // (post or segment). Do NOT reset on active toggle — that creates a race
  // where the pre-buffer gate passes, then the reset undoes it, freezing
  // the video on a single frame with no recovery path.
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

  // Auto-unpause when scrolling back to this video.
  // Only resets isPaused — playbackReady is left intact so the video
  // resumes immediately without re-waiting for the pre-buffer gate.
  useEffect(() => {
    if (active) setIsPaused(false);
  }, [active]);

  // Clear prebuffer safety timer on unmount or when deps change
  useEffect(() => {
    return () => {
      if (prebufferTimerRef.current) {
        clearTimeout(prebufferTimerRef.current);
        prebufferTimerRef.current = null;
      }
    };
  }, [post.id, segIdx]);

  // ── Safety timeout: if onReadyForDisplay never fires (rare Android edge case),
  //    force playbackReady=true after 3s so the video doesn't stay frozen forever.
  useEffect(() => {
    // Only arm the timer when the player is supposed to be active and not yet ready.
    if (!active || playbackReady) return;

    prebufferTimerRef.current = setTimeout(() => {
      if (!playbackReadyRef.current) {
        console.log("[feed] pre-buffer safety timeout — forcing playback", {
          postId: post.id.slice(0, 8),
        });
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
    console.log("[feed] video", e);
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
      // Forward to stall detection handler first
      handleStallDetection(status);

      if (!status.isLoaded) return;

      // ── Pre-buffer gate: start playback when the first frame is ready ──
      //    onReadyForDisplay is the PRIMARY signal (deterministic, fires once).
      //    onPlaybackStatusUpdate (!isBuffering) is a SECONDARY fallback for
      //    edge cases where onReadyForDisplay doesn't fire on some Android devices.
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
          console.log("[feed] pre-buffer complete, starting playback", {
            postId: post.id.slice(0, 8),
            trigger: hasFrame ? "onReadyForDisplay" : "notBuffering",
            playableDurationMs: status.playableDurationMillis,
          });
        }
      }

      const sourceDur =
        typeof status.durationMillis === "number" ? status.durationMillis : 0;

      // First frame where duration becomes available — seek to trimStartMs if needed
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
          // Single trimmed segment: manual loop back to trimStartMs
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

      // ── Untrimmed end-of-source: advance to next segment before native loop ──
      // With isLooping=true the native player never fires didJustFinish.
      // Detect when the playhead nears the source end and advance pre-emptively.
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

  // ── Diagnostic: log audio/playback state transitions ────────────────
  useEffect(() => {
    console.log("[feed] FeedItem state", {
      postId: post.id.slice(0, 8),
      active,
      isMuted: !active,
      segIdx,
      uri: currentUri.slice(-30),
      isBuffering: stallState.isBuffering,
      stallCount: stallState.stallCount,
      playbackReady,
      readyForDisplay: readyForDisplayRef.current,
    });
  }, [active, post.id, segIdx, currentUri, stallState.isBuffering, stallState.stallCount, playbackReady]);

  return (
    <View style={styles.item}>
      {post.media_type === "video" ? (
        <View style={StyleSheet.absoluteFill}>
          <Video
            key={`${post.id}_seg${segIdx}`}
            ref={videoRef}
            source={{ uri: currentUri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.COVER}
            isLooping
            shouldPlay={active && playbackReady && !isPaused}
            isMuted={!active}
            useNativeControls={false}
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={onSegmentStatus}
            onError={(error: string) => {
              errorCountRef.current += 1;
              setVideoError(error);
              videoLog({ type: "load_error", postId: post.id, error });
              console.error("[feed] Video onError", {
                postId: post.id.slice(0, 8),
                uri: currentUri.slice(-30),
                error,
                errorCount: errorCountRef.current,
              });
            }}
            onLoad={(status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
              videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
              console.log("[feed] Video onLoad", {
                postId: post.id.slice(0, 8),
                durationMs: status.durationMillis,
                active,
              });
            }}
            onLoadStart={() => {
              videoLog({ type: "load_start", postId: post.id, uri: currentUri });
            }}
            onReadyForDisplay={() => {
              videoLog({ type: "ready_for_display", postId: post.id });
              setVideoError(null);
              readyForDisplayRef.current = true;
              // If the pre-buffer gate hasn't passed yet, trigger it now.
              // This is the most reliable signal that the first frame is visible.
              if (!playbackReadyRef.current) {
                playbackReadyRef.current = true;
                setPlaybackReady(true);
                if (prebufferTimerRef.current) {
                  clearTimeout(prebufferTimerRef.current);
                  prebufferTimerRef.current = null;
                }
                console.log("[feed] onReadyForDisplay — starting playback", {
                  postId: post.id.slice(0, 8),
                });
              }
            }}
          />

          {/* Double-tap to like zone — between video and other overlays */}
          <DoubleTapLikeZone
            onLike={() => setLiked(true)}
            onSingleTap={() => setIsPaused((v) => !v)}
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
                  <Text style={styles.stallText}>Recovering playback…</Text>
                </>
              ) : videoError ? (
                <Pressable onPress={handleRetryVideo} style={styles.retryBtn}>
                  <RotateCcw color="#fff" size={20} strokeWidth={2.5} />
                  <Text style={styles.retryText}>Tap to retry</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      ) : (
        <Image
          source={{ uri: post.media_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
        />
      )}

      {/* Optimistic posting overlay */}
      {post._optimistic?.status === "uploading" && (
        <View style={styles.optOverlay} pointerEvents="auto">
          <LinearGradient
            colors={["rgba(0,0,0,0.6)", "rgba(0,0,0,0.6)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.optInner}>
            <Text style={styles.optTitle}>Posting your drop</Text>
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
            <Text style={styles.optProgressLabel}>
              Uploading... {post._optimistic?.progress ?? 0}%
            </Text>
          </View>
        </View>
      )}
      {post._optimistic?.status === "failed" && (
        <View style={styles.optOverlay} pointerEvents="auto">
          <LinearGradient
            colors={["rgba(0,0,0,0.65)", "rgba(0,0,0,0.65)"]}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.optInner}>
            <Text style={styles.optErrorIcon}>!</Text>
            <Text style={styles.optTitle}>Upload failed</Text>
            <Text style={styles.optSub} numberOfLines={2}>{post._optimistic?.error ?? "Something went wrong."}</Text>
            <Pressable onPress={onRetry} style={styles.optRetryBtn}>
              <Text style={styles.optRetryText}>Retry</Text>
            </Pressable>
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

      <View style={styles.actions} pointerEvents="box-none">
        <ActionButton
          icon={
            <Heart
              color={liked ? theme.danger : "#fff"}
              fill={liked ? theme.danger : "transparent"}
              size={28}
              strokeWidth={2}
            />
          }
          label={String((post.like_count ?? 0) + (liked ? 1 : 0))}
          onPress={() => setLiked((v) => !v)}
        />
        <ActionButton
          icon={<Sparkles color="#fff" size={28} strokeWidth={2} />}
          label={String(reactionCount)}
          onPress={onReactions}
        />
        <ActionButton
          icon={<Send color="#fff" size={26} strokeWidth={2} />}
          label="Share"
          onPress={onShare}
        />
      </View>

      <View style={styles.bottom} pointerEvents="box-none">
        {isLiveDrop && (
          <View style={styles.liveTag}>
            <View style={styles.livePulse} />
            <Text style={styles.liveTagText}>LIVE DROP</Text>
          </View>
        )}
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <FeedAvatar
              profile={post.profile}
              name={name}
            />
          </View>
          <Text style={styles.username}>@{post.profile?.username ?? "dropper"}</Text>
          <Text style={styles.dotSep}>·</Text>
          <Text style={styles.ago}>{ago}</Text>
        </View>
        {post.caption ? (
          <Text style={styles.caption} numberOfLines={3}>
            {post.caption}
          </Text>
        ) : null}
        <View style={styles.musicRow}>
          <Music2 color={theme.textMuted} size={12} />
          <Text style={styles.musicText}>
            {live ? "Original drop · tonight" : "Original sound"}
          </Text>
        </View>
      </View>
    </View>
  );
},
(prev, next) =>
  prev.post.id === next.post.id &&
  prev.active === next.active &&
  prev.live === next.live);

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
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <SafeAreaView style={styles.emptyWrap}>
      <DropletLogo size={56} />
      <Text style={styles.emptyTitle}>No drops yet</Text>
      <Text style={styles.emptySub}>Be the first to drop.</Text>
    </SafeAreaView>
  );
}

function GateOverlay({
  onDrop,
  viewed,
}: {
  onDrop: () => void;
  viewed: number;
}) {
  return (
    <View style={styles.gateRoot} pointerEvents="auto">
      <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={styles.gateInner}>
        <View style={styles.gateIcon}>
          <DropletLogo size={42} />
        </View>
        <Text style={styles.gateTitle}>Drop to unlock</Text>
        <Text style={styles.gateSub}>
          You've watched {viewed} drops. Post your DropDay to keep watching
          tonight's feed.
        </Text>
        <Pressable onPress={onDrop} style={styles.gateBtn}>
          <Sparkles color="#fff" size={16} />
          <Text style={styles.gateBtnText}>Drop now</Text>
        </Pressable>
        <Text style={styles.gateFootnote}>
          Unlimited access for the night once you post.
        </Text>
      </View>
    </View>
  );
}

function SearchOverlay({
  visible,
  onClose,
  query,
  onQueryChange,
}: {
  visible: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (s: string) => void;
}) {
  const suggestions = useMemo(
    () => [
      { label: "Tonight's top drops", icon: "trending" as const },
      { label: "Friends online", icon: "friends" as const },
      { label: "#latenight", icon: "tag" as const },
      { label: "#dropday", icon: "tag" as const },
      { label: "New creators", icon: "creator" as const },
    ],
    []
  );
  return (
    <Modal visible={visible} animationType="fade" transparent>
      <View style={styles.searchRoot}>
        <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
          <View style={styles.searchHeader}>
            <View style={styles.searchInputWrap}>
              <Search color="rgba(255,255,255,0.55)" size={16} />
              <TextInput
                value={query}
                onChangeText={onQueryChange}
                placeholder="Search DropDay"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={styles.searchInput}
                autoFocus
              />
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.searchClose}>
              <Text style={styles.searchCloseText}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.sectionLabel}>Suggestions</Text>
          {suggestions
            .filter((s) => s.label.toLowerCase().includes(query.toLowerCase()))
            .map((s) => (
              <Pressable key={s.label} style={styles.suggestionRow}>
                <View style={styles.suggestionIcon}>
                  <Search color={theme.accent} size={14} />
                </View>
                <Text style={styles.suggestionText}>{s.label}</Text>
              </Pressable>
            ))}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function ShareSheet({
  post,
  onClose,
}: {
  post: Post | null;
  onClose: () => void;
}) {
  const { following } = usePosts();
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!post) setSentTo(new Set());
  }, [post]);

  if (!post) return null;

  const handleNativeShare = async () => {
    try {
      await Share.share({
        message: `Check out this DropDay: ${post.media_url}`,
      });
    } catch {}
  };

  const handleSendToFollower = (id: string) => {
    setSentTo((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>Send to a friend</Text>
        <Text style={styles.sheetSub}>
          Share this drop privately with your followers.
        </Text>

        {following.length === 0 ? (
          <View style={styles.sheetEmpty}>
            <Users color={theme.textMuted} size={20} />
            <Text style={styles.sheetEmptyText}>
              Follow friends to send drops directly.
            </Text>
          </View>
        ) : (
          <FlatList
            data={following}
            keyExtractor={(id) => id}
            contentContainerStyle={{ paddingVertical: 8, gap: 8 }}
            renderItem={({ item }) => {
              const sent = sentTo.has(item);
              return (
                <View style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Users color="#fff" size={16} />
                  </View>
                  <Text style={styles.friendName}>
                    {item.slice(0, 8)}…
                  </Text>
                  <Pressable
                    onPress={() => handleSendToFollower(item)}
                    style={[styles.sendBtn, sent && styles.sendBtnDone]}
                  >
                    <Text
                      style={[
                        styles.sendBtnText,
                        sent && styles.sendBtnTextDone,
                      ]}
                    >
                      {sent ? "Sent" : "Send"}
                    </Text>
                  </Pressable>
                </View>
              );
            }}
            style={{ maxHeight: 280 }}
          />
        )}

        <Pressable onPress={handleNativeShare} style={styles.shareMore}>
          <Send color={theme.accent} size={16} />
          <Text style={styles.shareMoreText}>Share elsewhere</Text>
        </Pressable>

        <Pressable onPress={onClose} style={styles.sheetClose}>
          <X color={theme.text} size={18} />
        </Pressable>
      </View>
    </Modal>
  );
}

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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  /* Header overlay */
  headerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  pillLive: { backgroundColor: theme.success, borderColor: theme.success },
  pillText: {
    color: theme.text,
    fontSize: 11,
    fontWeight: "800" as const,
    letterSpacing: 0.5,
    fontVariant: ["tabular-nums"],
  },
  pillTextLive: { color: "#050505" },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.textMuted,
  },

  /* Faint search bar */
  searchBar: {
    marginHorizontal: 16,
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  searchPlaceholder: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "500" as const,
  },

  /* Feed item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#000",
  },
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  gradBottom: { position: "absolute", left: 0, right: 0, bottom: 0, height: 320 },

  /* Actions */
  actions: {
    position: "absolute",
    right: 12,
    bottom: TAB_BAR_HEIGHT + 30,
    alignItems: "center",
    gap: 22,
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
    bottom: TAB_BAR_HEIGHT + 24,
    gap: 8,
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
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: theme.accent,
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "800" as const,
    fontSize: 13,
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

  /* Empty */
  emptyContainer: {
    flexGrow: 1,
    minHeight: SCREEN_H + 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    minHeight: SCREEN_H + 1,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
  },

  /* Gate overlay */
  gateRoot: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  gateInner: {
    alignItems: "center",
    gap: 12,
    padding: 28,
    borderRadius: 24,
    backgroundColor: "rgba(15,15,15,0.85)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.4)",
  },
  gateIcon: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: "rgba(10,132,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.3)",
  },
  gateTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
    marginTop: 4,
  },
  gateSub: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 280,
  },
  gateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.accent,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 999,
    marginTop: 8,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 18,
    elevation: 8,
  },
  gateBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
  gateFootnote: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 4,
  },

  /* Search modal */
  searchRoot: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  searchHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 14,
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  searchInput: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  searchClose: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  searchCloseText: {
    color: theme.accent,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  sectionLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 6,
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  suggestionIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(10,132,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  suggestionText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "500" as const,
  },

  /* Share sheet */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: 14,
  },
  sheetTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    letterSpacing: -0.2,
  },
  sheetSub: {
    color: theme.textMuted,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 10,
  },
  sheetEmpty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 24,
  },
  sheetEmptyText: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  friendAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  friendName: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  sendBtn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  sendBtnDone: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  sendBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700" as const,
  },
  sendBtnTextDone: {
    color: theme.textMuted,
  },
  shareMore: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "rgba(10,132,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.25)",
  },
  shareMoreText: {
    color: theme.accent,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  sheetClose: {
    position: "absolute",
    top: 12,
    right: 12,
    padding: 6,
  },

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
  optErrorIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.danger,
    color: "#fff",
    fontSize: 24,
    fontWeight: "800" as const,
    textAlign: "center",
    lineHeight: 48,
    overflow: "hidden",
  },
  optRetryBtn: {
    marginTop: 8,
    backgroundColor: theme.accent,
    paddingHorizontal: 28,
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
});
