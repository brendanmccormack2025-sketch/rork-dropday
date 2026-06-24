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
import { ArrowLeft, Heart, Sparkles, Reply, RotateCcw } from "lucide-react-native";

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

  // ── Data: query reactions for this parent post ────────────────────────────
  const reactionsQuery = useQuery({
    queryKey: ["reactions", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return [] as Post[];

      // Query standalone reaction posts linked to this parent
      const { data: rows, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, created_at, like_count, comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("parent_post_id", id)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) {
        console.error("[reaction-tree] query error", error.message);
        return [] as Post[];
      }

      const posts: Post[] = ((rows ?? []) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: null,
          audio_url: null,
          trim_data: null,
          thumbnail_url: null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }),
      );

      return posts;
    },
  });

  const qc = useQueryClient();
  const posts = reactionsQuery.data ?? [];

  // ── Refetch on focus so the feed stays current after posting a reaction ──
  useFocusEffect(
    useCallback(() => {
      qc.invalidateQueries({ queryKey: ["reactions", id] });
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
      <ReactionItem
        post={item}
        active={index === activeIndex && screenFocused}
      />
    ),
    [activeIndex, screenFocused],
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
          <View style={styles.headerBtn} />
        </View>
        {posts.length > 0 && (
          <Text style={styles.headerCount}>
            {posts.length} reaction{posts.length !== 1 ? "s" : ""}
          </Text>
        )}
      </SafeAreaView>

      {/* Body */}
      {reactionsQuery.isLoading ? (
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

      {/* React button — fixed at bottom */}
      {!reactionsQuery.isLoading && (
        <SafeAreaView edges={["bottom"]} style={styles.reactSafe}>
          <Pressable
            onPress={() => {
              router.push(`/watch-and-react?postId=${id}` as never);
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

function ReactionItem({ post, active }: { post: Post; active: boolean }) {
  const [liked, setLiked] = useState<boolean>(false);
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

  // Reset pre-buffer gate when active toggles or post changes.
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    setPlaybackReady(false);
    playbackReadyRef.current = false;
    readyForDisplayRef.current = false;
  }, [active, post.id]);

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

  // ── Imperative play/pause ──────────────────────────────────────────
  useEffect(() => {
    if (active && playbackReady) {
      const t = setTimeout(() => {
        videoRef.current?.playAsync().catch(() => {});
      }, 80);
      return () => clearTimeout(t);
    } else {
      videoRef.current?.pauseAsync().catch(() => {});
    }
  }, [active, playbackReady]);

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
