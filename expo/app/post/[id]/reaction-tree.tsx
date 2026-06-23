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
import { ArrowLeft, Heart, Sparkles, Reply, Rewind, RotateCcw } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import type { Post } from "@/providers/PostsProvider";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

/** Profile subset needed for avatars and "replying to" derivation. */
type ProfileCard = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ReactionTreeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [screenFocused, setScreenFocused] = useState<boolean>(true);

  // ── Data: RPC → enrich with profiles ──────────────────────────────────────
  const treeQuery = useQuery({
    queryKey: ["reaction-tree", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return { posts: [] as Post[], profileMap: new Map<string, ProfileCard>() };

      // 1. Call the recursive CTE RPC
      const { data: rawRows, error: rpcErr } = await supabase.rpc(
        "get_reaction_tree",
        { root_id: id },
      );

      if (rpcErr) {
        console.error("[reaction-tree] RPC error", {
          message: rpcErr.message,
          code: rpcErr.code,
          details: rpcErr.details,
          hint: rpcErr.hint,
        });
        return { posts: [] as Post[], profileMap: new Map<string, ProfileCard>() };
      }

      const posts: Post[] = ((rawRows ?? []) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          original_duration_ms: (row.original_duration_ms as number | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: null,
        }),
      );

      // 2. Collect unique user IDs and fetch their profiles
      const userIds = [...new Set(posts.map((p) => p.user_id))];
      const profileMap = new Map<string, ProfileCard>();

      if (userIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", userIds);

        if (profileRows) {
          for (const p of profileRows) {
            profileMap.set(p.id as string, {
              username: p.username as string,
              display_name: (p.display_name as string | null) ?? null,
              avatar_url: (p.avatar_url as string | null) ?? null,
            });
          }
        }
      }

      // 3. Attach profile data to each post
      const enriched = posts.map((p) => ({
        ...p,
        profile: profileMap.get(p.user_id) ?? null,
      }));

      return { posts: enriched, profileMap };
    },
  });

  const qc = useQueryClient();
  const posts = treeQuery.data?.posts ?? [];
  const profileMap = treeQuery.data?.profileMap ?? new Map<string, ProfileCard>();

  // ── Derive "replying to" usernames client-side ────────────────────────────
  const replyingToMap = useMemo(() => {
    // Build a post lookup for parent resolution
    const postMap = new Map<string, Post>();
    for (const p of posts) {
      postMap.set(p.id, p);
    }

    const result = new Map<string, string>();
    for (const p of posts) {
      if (!p.parent_post_id) continue;
      const parent = postMap.get(p.parent_post_id);
      if (!parent) continue;
      const parentProfile = profileMap.get(parent.user_id);
      if (parentProfile?.username) {
        result.set(p.id, parentProfile.username);
      }
    }
    return result;
  }, [posts, profileMap]);

  // ── Refetch on focus so the tree stays current after posting a reaction ──
  // Also pause all videos on blur so audio doesn't bleed into unrelated screens.
  useFocusEffect(
    useCallback(() => {
      qc.invalidateQueries({ queryKey: ["reaction-tree", id] });
      setScreenFocused(true);
      return () => {
        setScreenFocused(false);
      };
    }, [qc, id]),
  );

  // ── FlatList config ───────────────────────────────────────────────────────
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      const firstIdx = first && typeof first.index === "number" ? first.index : null;
      console.log("[reaction-tree] viewability changed", {
        activeIndex: firstIdx,
        viewableCount: viewableItems.length,
        viewableIds: viewableItems.map((v) => ({
          index: v.index,
          id: (v.item as Post)?.id?.slice(0, 8),
          isViewable: v.isViewable,
        })),
      });
      if (firstIdx !== null) {
        setActiveIndex(firstIdx);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const getItemLayout = useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <TreeItem
        post={item}
        active={index === activeIndex && screenFocused}
        isRoot={index === 0}
        replyingTo={replyingToMap.get(item.id)}
      />
    ),
    [activeIndex, screenFocused, replyingToMap],
  );

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
          {/* Spacer to keep title centered */}
          <View style={styles.headerBtn} />
        </View>
        {posts.length > 0 && (
          <Text style={styles.headerCount}>
            {posts.length} clip{posts.length !== 1 ? "s" : ""}
          </Text>
        )}
      </SafeAreaView>

      {/* Body */}
      {treeQuery.isLoading ? (
        <View style={styles.center}>
          <Text style={styles.emptySub}>Loading…</Text>
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <Sparkles color={theme.textDim} size={48} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>No reactions yet</Text>
          <Text style={styles.emptySub}>
            Be the first to react to this drop.
          </Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
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
          windowSize={3}
          maxToRenderPerBatch={3}
          initialNumToRender={2}
        />
      )}

      {/* React button — fixed at bottom, targets the currently-viewed post */}
      {posts.length > 0 && !treeQuery.isLoading && (
        <SafeAreaView edges={["bottom"]} style={styles.reactSafe}>
          <Pressable
            onPress={() => {
              const targetId = posts[activeIndex]?.id;
              if (!targetId) return;
              router.push(`/watch-and-react?postId=${targetId}` as never);
            }}
            disabled={activeIndex >= posts.length}
            style={({ pressed }) => [
              styles.reactBtn,
              activeIndex >= posts.length && styles.reactBtnDisabled,
              pressed && styles.reactBtnPressed,
            ]}
          >
            <Reply color="#fff" size={18} strokeWidth={2.5} />
            <Text style={styles.reactBtnText}>
              React
              {posts[activeIndex]?.profile?.username
                ? ` to @${posts[activeIndex]!.profile!.username}`
                : ""}
            </Text>
          </Pressable>
        </SafeAreaView>
      )}
    </View>
  );
}

// ── Tree Item ───────────────────────────────────────────────────────────────

function TreeItem({
  post,
  active,
  isRoot,
  replyingTo,
}: {
  post: Post;
  active: boolean;
  isRoot: boolean;
  replyingTo?: string;
}) {
  return (
    <RootItem
      post={post}
      active={active}
      replyingTo={replyingTo}
      isRoot={isRoot}
    />
  );
}

// ── Root Item (full-screen, unchanged from original) ────────────────────────

function RootItem({
  post,
  active,
  replyingTo,
  isRoot = true,
}: {
  post: Post;
  active: boolean;
  replyingTo?: string;
  isRoot?: boolean;
}) {
  const [liked, setLiked] = useState<boolean>(false);
  const name =
    post.profile?.display_name || post.profile?.username || "dropper";
  const isReaction = !!post.parent_post_id;

  // Video error state for retry UI
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);

  // ── Pre-buffering: don't start playback until the first frame is ready.
  //    Uses onReadyForDisplay (deterministic) + !isBuffering fallback + 3s timeout.
  const [playbackReady, setPlaybackReady] = useState<boolean>(false);
  const playbackReadyRef = useRef<boolean>(false);
  const readyForDisplayRef = useRef<boolean>(false);
  const prebufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMountRef = useRef<boolean>(true);

  // Reset pre-buffer gate when active toggles or post changes.
  // Skip initial mount to avoid racing with native onPlaybackStatusUpdate.
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    setPlaybackReady(false);
    playbackReadyRef.current = false;
    readyForDisplayRef.current = false;
  }, [active, post.id]);

  // Safety timeout: force playbackReady=true after 3s if onReadyForDisplay never fires
  useEffect(() => {
    if (!active || playbackReady) return;
    prebufferTimerRef.current = setTimeout(() => {
      if (!playbackReadyRef.current) {
        console.log("[reaction-tree] pre-buffer safety timeout — forcing playback", {
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
      // Start playback when the first frame is ready
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
          console.log("[reaction-tree] pre-buffer complete, starting playback", {
            postId: post.id.slice(0, 8),
            trigger: hasFrame ? "onReadyForDisplay" : "notBuffering",
          });
        }
      }
    },
    [handleStallStatus, post.id],
  );

  // ── Imperative play/pause — safety net when FlatList recycles native views.
  //    Gated on playbackReady so we don't start before pre-buffering completes.
  useEffect(() => {
    console.log("[reaction-tree] RootItem audio state", {
      postId: post.id.slice(0, 8),
      active,
      isMuted: !active,
      isReaction,
      mediaUrl: post.media_url.slice(-30),
      isBuffering: stallState.isBuffering,
      stallCount: stallState.stallCount,
      playbackReady,
    });
    if (active && playbackReady) {
      const t = setTimeout(() => {
        videoRef.current?.playAsync().catch(() => {});
      }, 80);
      return () => clearTimeout(t);
    } else {
      videoRef.current?.pauseAsync().catch(() => {});
    }
  }, [active, playbackReady, stallState.isBuffering, stallState.stallCount]);

  // ── Offset-based seeking: when a reaction becomes active AND the player
  //     is pre-buffered (playbackReady), seek to the reaction segment.
  //     Gating on playbackReady prevents the seek from firing on a player
  //     that hasn't loaded its first frame yet, which would cause a permanent
  //     black screen.
  const hasSoughtToReaction = useRef(false);
  useEffect(() => {
    const wasStitched = post.segments != null && post.segments.length > 0;
    if (
      active &&
      playbackReady &&
      isReaction &&
      wasStitched &&
      post.original_duration_ms &&
      post.original_duration_ms > 0 &&
      !hasSoughtToReaction.current
    ) {
      hasSoughtToReaction.current = true;
      console.log("[reaction-tree] seeking to reaction segment", {
        postId: post.id.slice(0, 8),
        originalDurationMs: post.original_duration_ms,
      });
      const t = setTimeout(() => {
        videoRef.current?.setPositionAsync(post.original_duration_ms!).catch(() => {});
      }, 100);
      return () => clearTimeout(t);
    } else if (!active || !playbackReady) {
      hasSoughtToReaction.current = false;
    }
  }, [active, playbackReady, isReaction, post.original_duration_ms, post.segments, post.id, videoRef]);

  // Release native player resources on unmount
  useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, [videoRef]);

  // ── Error recovery: retry loading ──────────────────────────────────
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

  // ── Jump to source (seek back to start of original clip) ────────────
  const handleJumpToSource = useCallback(() => {
    videoRef.current?.setPositionAsync(0).catch(() => {});
    hasSoughtToReaction.current = false;
  }, []);

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
            shouldPlay={active && playbackReady}
            isMuted={!active}
            useNativeControls={false}
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={handlePlaybackStatus}
            onError={(error: string) => {
              errorCountRef.current += 1;
              setVideoError(error);
              videoLog({ type: "load_error", postId: post.id, error });
              console.error("[reaction-tree] Video onError", {
                postId: post.id,
                media_url: post.media_url,
                active,
                isReaction: !!post.parent_post_id,
                error,
                errorCount: errorCountRef.current,
              });
            }}
            onLoad={(status: { isLoaded: boolean; uri?: string; durationMillis?: number }) => {
              videoLog({ type: "load_success", postId: post.id, durationMs: status.durationMillis });
              console.log("[reaction-tree] Video onLoad", {
                postId: post.id,
                media_url: post.media_url,
                active,
                isReaction: !!post.parent_post_id,
                durationMs: status.durationMillis,
                uriUsed: status.uri,
              });
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
                console.log("[reaction-tree] onReadyForDisplay — starting playback", {
                  postId: post.id.slice(0, 8),
                });
              }
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

        <View style={styles.actionBtn}>
          <Sparkles color="#fff" size={28} strokeWidth={2} />
          <Text style={styles.actionLabel}>
            {String(post.reaction_count ?? 0)}
          </Text>
        </View>
      </View>

      {/* Bottom info */}
      <View style={styles.bottom} pointerEvents="box-none">
        {!isRoot && replyingTo && (
          <View style={styles.replyingRow}>
            <Reply color={theme.accent} size={11} strokeWidth={2.5} />
            <Text style={styles.replyingText}>
              replying to @{replyingTo}
            </Text>
          </View>
        )}

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

        {/* Jump to Source button — shown only on reaction posts that have been stitched */}
        {isReaction && post.original_duration_ms && post.original_duration_ms > 0 && (
          <Pressable
            onPress={handleJumpToSource}
            style={styles.jumpSourceBtn}
            hitSlop={8}
          >
            <Rewind color={theme.accent} size={13} strokeWidth={2.5} />
            <Text style={styles.jumpSourceText}>View Original</Text>
          </Pressable>
        )}
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
  replyingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  replyingText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "600" as const,
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

  /* Jump to Source button */
  jumpSourceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(10,132,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.2)",
    alignSelf: "flex-start",
  },
  jumpSourceText: {
    color: theme.accent,
    fontSize: 12,
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
  reactBtnDisabled: {
    opacity: 0.3,
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
