import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Heart, Sparkles, Reply, RotateCcw, ShieldCheck } from "lucide-react-native";

import { theme } from "@/constants/theme";
import DoubleTapLikeZone from "@/components/DoubleTapLikeZone";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import type { Post } from "@/providers/PostsProvider";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

// ── Feed item discriminated union ─────────────────────────────────────────

type FeedItem =
  | { kind: "reaction"; post: Post }
  | { kind: "reply"; post: Post; parentReactionId: string };

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ReactionTreeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [screenFocused, setScreenFocused] = useState<boolean>(true);

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
        .single();
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
          "id, user_id, media_url, media_type, caption, parent_post_id, thumbnail_url, created_at, like_count, comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("parent_post_id", id)
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
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.like_count as number | undefined) ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const tier1Posts = tier1Query.data ?? [];
  const tier1Ids = useMemo(() => tier1Posts.map((p) => p.id), [tier1Posts]);

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
          "id, user_id, media_url, media_type, caption, parent_post_id, thumbnail_url, created_at, like_count, comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .in("parent_post_id", tier1Ids)
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
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.like_count as number | undefined) ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const tier2Posts = tier2Query.data ?? [];

  // ── Build interleaved feed items ──────────────────────────────────────────
  // Tier 1 reactions appear newest-first. For each tier 1 reaction, its tier 2
  // replies are placed directly after it in the list (oldest reply first), so
  // scrolling down goes from newest reactions → oldest, with replies grouped
  // under their parent.
  const feedItems: FeedItem[] = useMemo(() => {
    // Index tier 2 replies by their parent_post_id
    const repliesByParent = new Map<string, Post[]>();
    for (const reply of tier2Posts) {
      const pid = reply.parent_post_id;
      if (!pid) continue;
      if (!repliesByParent.has(pid)) repliesByParent.set(pid, []);
      repliesByParent.get(pid)!.push(reply);
    }

    const items: FeedItem[] = [];
    for (const reaction of tier1Posts) {
      items.push({ kind: "reaction", post: reaction });
      const replies = repliesByParent.get(reaction.id);
      if (replies) {
        for (const reply of replies) {
          items.push({ kind: "reply", post: reply, parentReactionId: reaction.id });
        }
      }
    }
    return items;
  }, [tier1Posts, tier2Posts]);

  const qc = useQueryClient();

  // Track screen focus for playback control (no aggressive refetch on focus —
  // staleTime handles cache freshness).
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      return () => {
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
          // reactingTo set to that reaction's ID.
          router.push(`/camera?reactingTo=${reactionId}` as never);
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
            onPress={() => router.back()}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <ArrowLeft color={theme.text} size={22} strokeWidth={2} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Sparkles color={theme.accent} size={16} />
            <Text style={styles.headerTitle}>Reactions</Text>
          </View>
          <View style={styles.headerBtn} />
        </View>
        {postCount > 0 && (
          <Text style={styles.headerCount}>
            {postCount} reaction{postCount !== 1 ? "s" : ""}
          </Text>
        )}
      </SafeAreaView>

      {/* Body */}
      {isLoading ? (
        <View style={styles.center}>
          <Text style={styles.emptySub}>Loading…</Text>
        </View>
      ) : feedItems.length === 0 ? (
        <View style={styles.center}>
          <Sparkles color={theme.textDim} size={48} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>No reactions yet</Text>
          <Text style={styles.emptySub}>
            Be the first to react to this drop.
          </Text>
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
            <Text style={styles.emptyReactBtnText}>Create a reaction</Text>
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

      {/* ── Permission gating: bottom Record Reaction button ──────────────
          Only visible to NON-creators. The Drop's creator already sees
          per-reaction Reply buttons on each tier 1 reaction card instead.

          reactingTo is ALWAYS the root Drop's ID — hardcoded, intentional.
          Do NOT change this to a dynamic value based on scroll position. */}
      {!isLoading && !isCreator && (
        <SafeAreaView edges={["bottom"]} style={styles.reactSafe}>
          <Pressable
            onPress={() => {
              router.push(`/camera?reactingTo=${id}` as never);
            }}
            style={({ pressed }) => [
              styles.reactBtn,
              pressed && styles.reactBtnPressed,
            ]}
          >
            <Reply color="#fff" size={18} strokeWidth={2.5} />
            <Text style={styles.reactBtnText}>Record Reaction</Text>
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

  const [liked, setLiked] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const name =
    post.profile?.display_name || post.profile?.username || "dropper";

  // Video error state for retry UI
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);

  // ── Pre-buffering gate ─────────────────────────────────────────────
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate when the data source changes (post).
  // Do NOT reset on active toggle — that races with the pre-buffer gate
  // and causes a permanent freeze when scrolling back to a loaded video.
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

  // Auto-unpause when scrolling back to this video
  useEffect(() => {
    if (active) setIsPaused(false);
  }, [active]);

  // Safety timeout: force playbackReady=true after 3s
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
    console.log("[reaction-tree] video", e);
  }, []);

  const {
    videoRef,
    stallState,
    handlePlaybackStatus: handleStallStatus,
  } = useVideoStallDetection(post.id, active, post.media_url, videoLog);

  // ── Wrap stall handler with pre-buffer gate ────────────────────────
  const handlePlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      handleStallStatus(status);
      if (!status.isLoaded) return;
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
    [handleStallStatus, post.id],
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

  return (
    <View style={styles.item}>
      {post.media_type === "video" ? (
        <View style={StyleSheet.absoluteFill}>
          <Video
            key={post.id}
            ref={videoRef}
            source={{ uri: post.media_url }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.COVER}
            isLooping
            shouldPlay={active && playbackReady && !isPaused}
            isMuted={!active}
            useNativeControls={false}
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={handlePlaybackStatus}
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
          <Text style={styles.replyBadgeText}>Creator reply</Text>
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
          <Text style={styles.actionLabel}>
            {String((post.like_count ?? 0) + (liked ? 1 : 0))}
          </Text>
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
            <Text style={styles.actionLabel}>Reply</Text>
          </Pressable>
        )}

        <View style={styles.actionBtn}>
          <Sparkles color="#fff" size={28} strokeWidth={2} />
          <Text style={styles.actionLabel}>
            {String(post.like_count ?? 0)}
          </Text>
        </View>
      </View>

      {/* Bottom info */}
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <FeedAvatar profile={post.profile} name={name} />
          </View>
          <Text style={styles.username}>
            @{post.profile?.username ?? "dropper"}
          </Text>
        </View>

        {post.caption ? (
          <Text style={styles.caption} numberOfLines={2}>
            {post.caption}
          </Text>
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
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.08)",
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
    fontWeight: "800" as const,
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
    fontWeight: "800" as const,
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
    borderRadius: 14,
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
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },

  /* Item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#000",
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
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
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
    fontWeight: "700" as const,
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
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.violet,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: theme.violet,
    overflow: "hidden",
  },
  username: {
    color: "#fff",
    fontWeight: "800" as const,
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
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  reactBtnPressed: {
    opacity: 0.75,
  },
  reactBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },
});
