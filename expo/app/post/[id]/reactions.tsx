import React, { useMemo, useState, useCallback, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  ViewToken,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Video, ResizeMode } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, EllipsisVertical, Flag, Heart, Reply, RotateCcw, Sparkles, X } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { usePosts, type Post } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useVideoStallDetection, type VideoEvent } from "@/hooks/useVideoStallDetection";
import { useReportContent } from "@/hooks/useReportContent";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

export default function PostReactionsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { reactionsByParent, reactionsLoading, refetchReactions } = usePosts();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchReactions();
    setRefreshing(false);
  }, [refetchReactions]);

  const reactions = useMemo<Post[]>(
    () => (id ? reactionsByParent[id] ?? [] : []),
    [id, reactionsByParent],
  );

  const onViewableItemsChanged = React.useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
      }
    },
  ).current;

  const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 60 }).current;

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  const renderItem = React.useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <ReactionItem post={item} active={index === activeIndex} />
    ),
    [activeIndex],
  );

  return (
    <View style={styles.root}>
      {/* Header */}
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.headerBtn} hitSlop={8}>
            <ArrowLeft color={theme.text} size={22} strokeWidth={2} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Sparkles color={theme.accent} size={16} />
            <UiText style={styles.headerTitle}>Last Night</UiText>
          </View>
          <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.headerBtn} hitSlop={8}>
            <X color={theme.textMuted} size={20} strokeWidth={2} />
          </Pressable>
        </View>
        {reactions.length > 0 && (
          <UiText style={styles.headerCount}>
            {reactions.length} clip{reactions.length !== 1 ? "s" : ""}
          </UiText>
        )}
      </SafeAreaView>

      {/* Body */}
      {reactionsLoading ? (
        <View style={styles.center}>
          <UiText style={styles.emptySub}>Loading…</UiText>
        </View>
      ) : reactions.length === 0 ? (
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
          data={reactions}
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
          removeClippedSubviews
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.accent}
              progressBackgroundColor={theme.card}
            />
          }
        />
      )}

      {/* Record Reaction button — always visible for non-creators */}
      {!reactionsLoading && (
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
            <UiText style={styles.reactBtnText}>Record Reaction</UiText>
          </Pressable>
        </SafeAreaView>
      )}
    </View>
  );
}

function ReactionItem({ post, active }: { post: Post; active: boolean }) {
  const [liked, setLiked] = useState<boolean>(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const errorCountRef = useRef<number>(0);
  const { deleteReaction } = usePosts();
  const { user } = useAuth();
  const { reportContent } = useReportContent();
  const name = post.profile?.display_name || post.profile?.username || "dropper";
  const isOwner = !!user?.id && post.user_id === user.id;

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

  const hasValidMediaUrl = typeof post.media_url === "string" && post.media_url.length > 0;

  // ── Stall detection + auto-recovery ───────────────────────────────
  const videoLog = useCallback((e: VideoEvent) => {
    console.log("[reactions] video", e);
  }, []);

  const {
    videoRef,
    stallState,
    handlePlaybackStatus,
  } = useVideoStallDetection(post.id, active, post.media_url, videoLog);

  // Release native player on unmount to avoid memory leaks
  React.useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, [videoRef]);

  // ── Error recovery ────────────────────────────────────────────────
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
      {post.media_type === "video" && hasValidMediaUrl ? (
        <View style={styles.videoWrapper}>
          {/* Poster thumbnail shown immediately before the video loads */}
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
            shouldPlay={active}
            isMuted={!active}
            useNativeControls={false}
            posterSource={
              post.thumbnail_url ? { uri: post.thumbnail_url } : undefined
            }
            progressUpdateIntervalMillis={250}
            onPlaybackStatusUpdate={handlePlaybackStatus}
            onError={(error: string) => {
              errorCountRef.current += 1;
              setVideoError(error);
              videoLog({ type: "load_error", postId: post.id, error });
              console.error("[reactions] Video onError", {
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
      ) : post.media_type === "image" && hasValidMediaUrl ? (
        <Image
          source={{ uri: post.media_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
        />
      ) : (
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

      {/* Delete button — only visible to the owner */}
      {isOwner && (
        <Pressable
          onPress={handleDeleteReaction}
          style={styles.moreBtn}
          hitSlop={8}
        >
          <EllipsisVertical color="rgba(255,255,255,0.8)" size={22} strokeWidth={2} />
        </Pressable>
      )}

      {/* Report button — visible to non-owners */}
      {!isOwner && (
        <Pressable
          onPress={() => reportContent("reaction", post.id)}
          style={styles.moreBtn}
          hitSlop={8}
        >
          <Flag color="rgba(255,255,255,0.8)" size={20} strokeWidth={2} />
        </Pressable>
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
      </View>

      {/* Bottom info */}
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <FeedAvatar
              profile={post.profile}
              name={name}
            />
          </View>
          <UiText style={styles.username}>@{post.profile?.username ?? "dropper"}</UiText>
        </View>
        {post.caption ? (
          <UiText style={styles.caption} numberOfLines={2}>
            {post.caption}
          </UiText>
        ) : null}
        {/* Show what they're reacting to */}
        <View style={styles.reactingToRow}>
          <Sparkles color={theme.accent} size={11} />
          <UiText style={styles.reactingToText}>Reacted to this drop</UiText>
        </View>
      </View>
    </View>
  );
}

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

  /* Center */
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
    backgroundColor: "#0A0A14",
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
    ...StyleSheet.absoluteFillObject,
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

  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  gradBottom: { position: "absolute", left: 0, right: 0, bottom: 0, height: 320 },

  /* Actions */
  actions: {
    position: "absolute",
    right: 12,
    bottom: 120,
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
    bottom: 80,
    gap: 8,
  },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
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
  caption: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
  },
  reactingToRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 2,
  },
  reactingToText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "600" as const,
  },

  /* Empty state react button */
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

  /* Delete button */
  moreBtn: {
    position: "absolute",
    top: 60,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    zIndex: 5,
  },

  /* Bottom react button */
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
