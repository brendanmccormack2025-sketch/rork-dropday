import React, { useMemo, useState, useCallback, useRef } from "react";
import {
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  ViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, Heart, Reply, Sparkles, X } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { usePosts, type Post } from "@/providers/PostsProvider";

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
            <Text style={styles.headerTitle}>Last Night</Text>
          </View>
          <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.headerBtn} hitSlop={8}>
            <X color={theme.textMuted} size={20} strokeWidth={2} />
          </Pressable>
        </View>
        {reactions.length > 0 && (
          <Text style={styles.headerCount}>
            {reactions.length} clip{reactions.length !== 1 ? "s" : ""}
          </Text>
        )}
      </SafeAreaView>

      {/* Body */}
      {reactionsLoading ? (
        <View style={styles.center}>
          <Text style={styles.emptySub}>Loading…</Text>
        </View>
      ) : reactions.length === 0 ? (
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
            <Text style={styles.reactBtnText}>Record Reaction</Text>
          </Pressable>
        </SafeAreaView>
      )}
    </View>
  );
}

function ReactionItem({ post, active }: { post: Post; active: boolean }) {
  const [liked, setLiked] = useState<boolean>(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoRef = useRef<Video>(null);
  const name = post.profile?.display_name || post.profile?.username || "dropper";

  const hasValidMediaUrl = typeof post.media_url === "string" && post.media_url.length > 0;

  // Release native player on unmount to avoid memory leaks
  React.useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

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
            onError={(error: string) => {
              setVideoError(error);
              console.error("[reactions] Video onError", {
                postId: post.id.slice(0, 8),
                error,
              });
            }}
            onReadyForDisplay={() => {
              setVideoError(null);
            }}
          />
          {/* Error overlay */}
          {videoError && active && (
            <View style={styles.errorOverlay} pointerEvents="box-none">
              <Text style={styles.errorText}>Playback error</Text>
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
          <Text style={styles.mediaFallbackText}>Media unavailable</Text>
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
          <Text style={styles.username}>@{post.profile?.username ?? "dropper"}</Text>
        </View>
        {post.caption ? (
          <Text style={styles.caption} numberOfLines={2}>
            {post.caption}
          </Text>
        ) : null}
        {/* Show what they're reacting to */}
        <View style={styles.reactingToRow}>
          <Sparkles color={theme.accent} size={11} />
          <Text style={styles.reactingToText}>Reacted to this drop</Text>
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
    backgroundColor: "#000",
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

  /* Error overlay */
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  errorText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontWeight: "600" as const,
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
    backgroundColor: theme.violet,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: theme.violet,
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
