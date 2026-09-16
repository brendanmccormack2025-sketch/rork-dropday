import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  InteractionManager,
  Pressable,
  StyleSheet,
  View,
  ViewToken,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Video, ResizeMode, Audio, type AVPlaybackStatus } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Flag, Heart, Sparkles, Reply, RotateCcw, ShieldCheck, Trash2 } from "lucide-react-native";

import { theme } from "@/constants/theme";
import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import { usePosts, type Post } from "@/providers/PostsProvider";
import { useUserBlocks } from "@/hooks/useUserBlocks";
import { useReportContent } from "@/hooks/useReportContent";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

// ── Feed item discriminated union ─────────────────────────────────────────

type FeedItem =
  | { kind: "reaction"; post: Post }
  | { kind: "reply"; post: Post; parentReactionId: string };

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ReactionTreeScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { blockedUserIds } = useUserBlocks();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [screenFocused, setScreenFocused] = useState<boolean>(false);

  // ── Query 1: root Drop's creator ──────────────────────────────────────
  const rootDropQuery = useQuery({
    queryKey: ["post", id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async (): Promise<string | null> => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("posts")
        .select("user_id")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        console.error("[reaction-tree] root drop query error", error.message);
        return null;
      }
      return (data?.user_id as string) ?? null;
    },
  });

  const rootDropCreatorId = rootDropQuery.data ?? null;
  const isCreator = !!user?.id && !!rootDropCreatorId && user.id === rootDropCreatorId;

  // ── Query 2: tier 1 reactions (parent_post_id = root drop) ────────────
  const tier1Query = useQuery({
    queryKey: ["reactions", id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async (): Promise<Post[]> => {
      if (!id) return [];

      const { data: rows, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, thumbnail_url, moderation_status, created_at, likes(count), comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("parent_post_id", id)
        .eq("moderation_status", "active")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) {
        console.error("[reaction-tree] tier1 query error", error.message);
        return [];
      }

      return ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        media_url: row.media_url as string,
        media_type: row.media_type as "image" | "video",
        caption: (row.caption as string | null) ?? null,
        parent_post_id: (row.parent_post_id as string | null) ?? null,
        segments: null,
        audio_url: null,
        trim_data: null,
        text_overlays: null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        moderation_status: (row.moderation_status as string | undefined) ?? "active",
        created_at: row.created_at as string,
        like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const tier1Posts = tier1Query.data ?? [];
  const tier1Ids = useMemo(() => tier1Posts.map((p) => p.id), [tier1Posts]);

  // ── Follow set for ranking ────────────────────────────────────────────
  // Reuse the existing following array from PostsProvider — no extra fetch.
  const { following, reportedReactionIds } = usePosts();

  // ── Rank tier 1 reactions by blended score ────────────────────────────
  // Score = like_count + (10 if the reactor is followed by the current
  // viewer, else 0). The follow bonus of 10 means a followed account
  // needs to be outperformed by a non-followed reaction with 10+ more
  // likes before it drops below. Tiebreaker: created_at descending (newer
  // first). Tier 2 creator replies stay anchored under their parent
  // tier 1 reaction regardless of score — the ranking only applies here.
  const rankedTier1Posts = useMemo(() => {
    // Filter out blocked users' reactions and reported reactions before ranking
    const visible = (blockedUserIds.size > 0 || reportedReactionIds.size > 0)
      ? tier1Posts.filter((p) =>
          !blockedUserIds.has(p.user_id) && !reportedReactionIds.has(p.id))
      : tier1Posts;
    if (visible.length === 0) return visible;
    const follows = new Set(following);
    const scored = visible.map((p) => ({
      p,
      score: (p.like_count ?? 0) + (follows.has(p.user_id) ? 10 : 0),
      createdMs: new Date(p.created_at).getTime(),
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.createdMs - a.createdMs;
    });
    return scored.map((s) => s.p);
  }, [tier1Posts, following, blockedUserIds, reportedReactionIds]);

  // ── Query 3: tier 2 replies (parent_post_id IN tier 1 IDs) ────────────
  // Only the creator needs tier 2 data, but we fetch for everyone — the
  // reply data is small and it avoids a query-mount flash for creators.
  const tier2Query = useQuery({
    queryKey: ["replies", tier1Ids],
    enabled: tier1Ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Post[]> => {
      // Tier 2: posts whose parent_post_id is one of the tier 1 reactions.
      // Ordered ascending so replies appear in chronological order under
      // their parent reaction.
      const { data: rows, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, thumbnail_url, moderation_status, created_at, likes(count), comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .in("parent_post_id", tier1Ids)
        .eq("moderation_status", "active")
        .order("created_at", { ascending: true })
        .limit(500);

      if (error) {
        console.error("[reaction-tree] tier2 query error", error.message);
        return [];
      }

      return ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        media_url: row.media_url as string,
        media_type: row.media_type as "image" | "video",
        caption: (row.caption as string | null) ?? null,
        parent_post_id: (row.parent_post_id as string | null) ?? null,
        segments: null,
        audio_url: null,
        trim_data: null,
        text_overlays: null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        moderation_status: (row.moderation_status as string | undefined) ?? "active",
        created_at: row.created_at as string,
        like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const tier2Posts = tier2Query.data ?? [];

  // ── Build interleaved feed items ──────────────────────────────────────────
  // Tier 1 reactions are ranked by blended score (see rankedTier1Posts).
  // For each tier 1 reaction, its tier 2 replies are placed directly after
  // it in the list (oldest reply first), so replies stay grouped under
  // their parent regardless of the tier 1 ranking.
  const feedItems: FeedItem[] = useMemo(() => {
    // Index tier 2 replies by their parent_post_id
    // Filter out replies from blocked users
    const repliesByParent = new Map<string, Post[]>();
    for (const reply of tier2Posts) {
      if (blockedUserIds.has(reply.user_id)) continue;
      if (reportedReactionIds.has(reply.id)) continue;
      const pid = reply.parent_post_id;
      if (!pid) continue;
      if (!repliesByParent.has(pid)) repliesByParent.set(pid, []);
      repliesByParent.get(pid)!.push(reply);
    }

    const items: FeedItem[] = [];
    for (const reaction of rankedTier1Posts) {
      items.push({ kind: "reaction", post: reaction });
      const replies = repliesByParent.get(reaction.id);
      if (replies) {
        for (const reply of replies) {
          items.push({ kind: "reply", post: reply, parentReactionId: reaction.id });
        }
      }
    }
    return items;
  }, [rankedTier1Posts, tier2Posts, blockedUserIds, reportedReactionIds]);

  const qc = useQueryClient();

  // Track screen focus for playback control (no aggressive refetch on focus —
  // staleTime handles cache freshness). Also restore playback-only audio mode
  // whenever this screen gains focus. expo-camera leaves the iOS AVAudioSession
  // in PlayAndRecord mode, which can cause expo-av Video players to render video
  // but silently fail to start playback.
  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        setScreenFocused(true);
        Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        }).catch(() => {});
      });
      return () => {
        task.cancel();
        setScreenFocused(false);
      };
    }, []),
  );

  // ── FlatList config ───────────────────────────────────────────────────────
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      const firstIdx = first && typeof first.index === "number" ? first.index : null;
      if (firstIdx !== null) {
        setActiveIndex(firstIdx);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const getItemLayout = useCallback(
    (_: ArrayLike<FeedItem> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: FeedItem; index: number }) => (
      <ReactionItem
        item={item}
        active={index === activeIndex && screenFocused}
        isCreator={isCreator}
        onReply={(reactionId: string) => {
          // Creator replying to a tier 1 reaction — open camera with
          // reactingTo set to that reaction's ID and rootDropId so the
          // editor can navigate back to the correct reaction-tree after posting.
          router.push(`/camera?reactingTo=${reactionId}&rootDropId=${id}` as never);
        }}
      />
    ),
    [activeIndex, screenFocused, isCreator, router],
  );

  const keyExtractor = useCallback((item: FeedItem) => item.post.id, []);

  const isLoading = tier1Query.isLoading || rootDropQuery.isLoading;
  const postCount = feedItems.length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      {/* Header */}
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <ArrowLeft color={theme.text} size={22} strokeWidth={2} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Sparkles color={theme.accent} size={16} />
            <UiText style={styles.headerTitle}>Reactions</UiText>
          </View>
          <View style={styles.headerBtn} />
        </View>
        {postCount > 0 && (
          <UiText style={styles.headerCount}>
            {postCount} reaction{postCount !== 1 ? "s" : ""}
          </UiText>
        )}
      </SafeAreaView>

      {/* Body */}
      {isLoading ? (
        <View style={styles.center}>
          <UiText style={styles.emptySub}>Loading…</UiText>
        </View>
      ) : feedItems.length === 0 ? (
        <View style={styles.center}>
          <Sparkles color={theme.textDim} size={48} strokeWidth={1.5} />
          <UiText style={styles.emptyTitle}>No reactions yet</UiText>
          <UiText style={styles.emptySub}>
            Be the first to react to this drop.
          </UiText>
          <Pressable
            onPress={() => {
              router.push(`/camera?reactingTo=${id}` as never);
            }}
            style={({ pressed }) => [
              styles.emptyReactBtn,
              pressed && styles.emptyReactBtnPressed,
            ]}
          >
            <Reply color="#fff" size={18} strokeWidth={2.5} />
            <UiText style={styles.emptyReactBtnText}>Create a reaction</UiText>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={feedItems}
          extraData={isCreator}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          pagingEnabled
          snapToInterval={SCREEN_H}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          showsVerticalScrollIndicator={false}
          getItemLayout={getItemLayout}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          windowSize={5}
          maxToRenderPerBatch={3}
          initialNumToRender={2}
        />
      )}

      {/* ── Bottom Record Reaction button — always visible so every
          user (including the creator) can record a general reaction.
          Creators can also use per-reaction Reply buttons on tier 1 cards.

          reactingTo is ALWAYS the root Drop's ID — hardcoded, intentional.
          Do NOT change this to a dynamic value based on scroll position. */}
      {!isLoading && (
        <SafeAreaView edges={["bottom"]} style={styles.reactSafe}>
          <Pressable
            onPress={() => {
              if (!id) return;
              router.push(`/camera?reactingTo=${id}` as never);
            }}
            style={({ pressed }) => [
              styles.reactBtn,
              !id && styles.reactBtnDisabled,
              pressed && styles.reactBtnPressed,
            ]}
            disabled={!id}
          >
            <Reply color="#fff" size={18} strokeWidth={2.5} />
            <UiText style={styles.reactBtnText}>Record Reaction</UiText>
          </Pressable>
        </SafeAreaView>
      )}
    </View>
  );
}

// ── Reaction Item (standalone video, no stitching) ──────────────────────────

function ReactionItem({
  item,
  active,
  isCreator,
  onReply,
}: {
  item: FeedItem;
  active: boolean;
  isCreator: boolean;
  onReply: (reactionId: string) => void;
}) {
  const { post, kind } = item;
  const isReply = kind === "reply";

  const router = useRouter();
  const [liked, setLiked] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const { deleteReaction } = usePosts();
  const { user: authUser } = useAuth();
  const { reportContent } = useReportContent();
  const name =
    post.profile?.display_name || post.profile?.username || "dropper";
  const isOwner = !!authUser?.id && post.user_id === authUser.id;

  // ── Pre-buffer gate: don't start playback until the first frame is ready.
  //    Uses onReadyForDisplay (deterministic, fires once) + a 3s safety timeout
  //    to avoid the freeze-when-shouldPlay-fires-too-early pattern that occurs
  //    when expo-av tries to play before the native decoder is initialized.
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate when the data source changes (post changes).
  // Do NOT reset on active toggle — that creates a race where the pre-buffer
  // gate passes, then the reset undoes it, freezing the video.
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
  }, [post.id]);

  // ── Safety timeout: if onReadyForDisplay never fires (rare Android edge
  //    case), force playbackReady=true after 3s so the video doesn't stay
  //    frozen forever.
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

  const handleDeleteReaction = useCallback(() => {
    Alert.alert(
      "Delete this reaction?",
      "This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteReaction.mutate(post.id),
        },
      ],
    );
  }, [deleteReaction, post.id]);

  // Video error state for retry UI
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);

  // ── Stall detection + recovery ─────────────────────────────────────
  const videoLog = useCallback((e: VideoEvent) => {
  }, []);

  const {
    videoRef,
    stallState,
    handlePlaybackStatus: handleStallDetection,
  } = useVideoStallDetection(post.id, active, post.media_url, videoLog);

  // ── Combined onPlaybackStatusUpdate: stall detection first, then
  //    pre-buffer gate fallback (mirrors the feed's onSegmentStatus pattern).
  const onPlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      // Forward to stall detection handler first
      handleStallDetection(status);

      if (!status.isLoaded) return;

      // ── Pre-buffer gate fallback: if onReadyForDisplay hasn't fired yet
      //    but the player reports it's no longer buffering, assume the first
      //    frame is ready and unlock playback.
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
    },
    [handleStallDetection, post.id],
  );

  // Release native player resources on unmount
  useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, [videoRef]);

  // ── Error recovery ──────────────────────────────────────────────────
  const handleRetryVideo = useCallback(() => {
    setVideoError(null);
    videoRef.current
      ?.unloadAsync()
      .then(() =>
        videoRef.current?.loadAsync(
          { uri: post.media_url },
          { shouldPlay: active, isLooping: true },
          false,
        ),
      )
      .catch(() => {});
  }, [post.media_url, active, videoRef]);

  // ── Guard: missing or empty media_url → show thumbnail fallback ──
  const hasValidMediaUrl = typeof post.media_url === "string" && post.media_url.length > 0;

  return (
    <View style={styles.item}>
      {post.media_type === "video" && hasValidMediaUrl ? (
        <View style={styles.videoWrapper}>
          {/* Poster thumbnail shown immediately while the video pre-buffers */}
          {post.thumbnail_url ? (
            <Image
              source={{ uri: post.thumbnail_url }}
              style={styles.videoPoster}
              contentFit="cover"
            />
          ) : null}
          <Video
            key={post.id}
            ref={videoRef}
            source={{ uri: post.media_url }}
            style={styles.videoFill}
            resizeMode={ResizeMode.COVER}
            isLooping
            shouldPlay={active && playbackReady && !isPaused}
            isMuted={!active}
            useNativeControls={false}
            posterSource={
              post.thumbnail_url ? { uri: post.thumbnail_url } : undefined
            }
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={onPlaybackStatus}
            onError={(error: string) => {
              errorCountRef.current += 1;
              setVideoError(error);
              videoLog({ type: "load_error", postId: post.id, error });
              console.error("[reaction-tree] Video onError", {
                postId: post.id.slice(0, 8),
                error,
                errorCount: errorCountRef.current,
              });
            }}
            onLoad={(status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
              videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
            }}
            onLoadStart={() => {
              videoLog({ type: "load_start", postId: post.id, uri: post.media_url });
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
              }
            }}
          />

          {/* Double-tap to like zone */}
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
          source={hasValidMediaUrl ? { uri: post.media_url } : undefined}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
        />
      )}
      {/* Fallback when media_url is missing entirely */}
      {!hasValidMediaUrl && (
        <View style={styles.mediaFallback}>
          <Sparkles color={theme.textDim} size={32} strokeWidth={1.5} />
          <UiText style={styles.mediaFallbackText}>Media unavailable</UiText>
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


      {/* ── Tier 2 reply indicator — shown at the top of reply cards ──── */}
      {isReply && (
        <View style={styles.replyBadge} pointerEvents="none">
          <ShieldCheck color={theme.accent} size={14} strokeWidth={2.5} />
          <UiText style={styles.replyBadgeText}>Creator reply</UiText>
        </View>
      )}

      {/* Side actions */}
      <View style={styles.actions} pointerEvents="box-none">
        <Pressable
          onPress={() => setLiked((v) => !v)}
          style={styles.actionBtn}
          hitSlop={8}
        >
          <Heart
            color={liked ? theme.danger : "#fff"}
            fill={liked ? theme.danger : "transparent"}
            size={28}
            strokeWidth={2}
          />
          <UiText style={styles.actionLabel}>
            {String((post.like_count ?? 0) + (liked ? 1 : 0))}
          </UiText>
        </Pressable>

        {/* ── Permission gating: Reply button on tier 1 reactions ────────
            Only visible to the root Drop's creator. Tier 2 replies never
            show a reply button (depth limit). */}
        {isCreator && !isReply && (
          <Pressable
            onPress={() => onReply(post.id)}
            style={styles.actionBtn}
            hitSlop={8}
          >
            <Reply color="#fff" size={26} strokeWidth={2} />
            <UiText style={styles.actionLabel}>Reply</UiText>
          </Pressable>
        )}

        <View style={styles.actionBtn}>
          <Sparkles color="#fff" size={28} strokeWidth={2} />
          <UiText style={styles.actionLabel}>
            {String(post.like_count ?? 0)}
          </UiText>
        </View>

        {isOwner && (
          <Pressable onPress={handleDeleteReaction} style={styles.actionBtn} hitSlop={8}>
            <Trash2 color="rgba(255,255,255,0.85)" size={24} strokeWidth={2} />
            <UiText style={styles.actionLabel}>Delete</UiText>
          </Pressable>
        )}
        {!isOwner && (
          <Pressable onPress={() => reportContent("reaction", post.id)} style={styles.actionBtn} hitSlop={8}>
            <Flag color="#fff" size={22} strokeWidth={2} />
            <UiText style={styles.actionLabel}>Report</UiText>
          </Pressable>
        )}
      </View>

      {/* Bottom info */}
      <View style={styles.bottom} pointerEvents="box-none">
        <Pressable
          onPress={() => {
            if (!authUser?.id || !post.user_id) return;
            if (post.user_id === authUser.id) {
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

        {post.caption ? (
          <UiText style={styles.caption} numberOfLines={2}>
            {post.caption}
          </UiText>
        ) : null}
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  /* Header */
  headerSafe: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "900" as const,
    letterSpacing: -0.2,
  },
  headerCount: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "600" as const,
    textAlign: "center",
    marginTop: 4,
  },

  /* Center / empty */
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 16,
  },
  emptyReactBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    minHeight: 50,
    borderRadius: 0,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  emptyReactBtnPressed: {
    opacity: 0.75,
  },
  emptyReactBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900" as const,
    letterSpacing: 0.2,
  },

  /* Item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#F5F3EE",
  },

  /* Video — explicit wrapper + fill so the native player always gets
     concrete dimensions even when the parent layout is still resolving */
  videoWrapper: {
    width: SCREEN_W,
    height: SCREEN_H,
  },
  videoFill: {
    width: SCREEN_W,
    height: SCREEN_H,
  },
  videoPoster: {
    width: SCREEN_W,
    height: SCREEN_H,
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 0,
  },

  /* Media fallback */
  mediaFallback: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#111",
  },
  mediaFallbackText: {
    color: theme.textDim,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  gradBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 320,
  },

  /* Tier 2 reply badge */
  replyBadge: {
    position: "absolute",
    top: 100,
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.15)",
    zIndex: 5,
  },
  replyBadgeText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
  },

  /* Actions */
  actions: {
    position: "absolute",
    right: 12,
    bottom: 150,
    alignItems: "center",
    gap: 22,
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
    bottom: 130,
    gap: 8,
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
  caption: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
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
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
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

  /* React button */
  reactSafe: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  reactBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    minHeight: 50,
    borderRadius: 0,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  reactBtnDisabled: {
    opacity: 0.35,
  },
  reactBtnPressed: {
    opacity: 0.75,
  },
  reactBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900" as const,
    letterSpacing: 0.2,
  },

  /* Delete button */
  moreBtn: {
    position: "absolute",
    top: 60,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    zIndex: 5,
  },
});
