import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
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
import { LinearGradient } from "expo-linear-gradient";
import { Heart, Sparkles } from "lucide-react-native";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";

import DropletLogo from "@/components/DropletLogo";
import { FeedAvatar } from "@/components/Avatar";
import { theme } from "@/constants/theme";
import { usePosts, type Post } from "@/providers/PostsProvider";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");
const TAB_BAR_HEIGHT = 88;

export default function ReactionsScreen() {
  const { reactionsByParent, reactionsLoading, refetchReactions } = usePosts();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchReactions();
    setRefreshing(false);
  }, [refetchReactions]);

  // Flatten grouped reactions into a sorted array
  const reactions = useMemo<Post[]>(() => {
    const flat: Post[] = [];
    for (const key of Object.keys(reactionsByParent)) {
      const group = reactionsByParent[key];
      if (group) {
        for (const p of group) {
          flat.push(p);
        }
      }
    }
    flat.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return flat;
  }, [reactionsByParent]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
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
      <ReactionItem post={item} active={index === activeIndex} />
    ),
    [activeIndex],
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={reactions}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        ListEmptyComponent={
          reactionsLoading ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptySub}>Loading…</Text>
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Sparkles color={theme.textDim} size={48} strokeWidth={1.5} />
              <Text style={styles.emptyTitle}>Nothing from last night</Text>
              <Text style={styles.emptySub}>
                Video replies to drops will appear here. When someone reacts to
                a drop, you'll see it here.
              </Text>
            </View>
          )
        }
        contentContainerStyle={
          reactions.length === 0 ? styles.emptyContainer : undefined
        }
        snapToInterval={SCREEN_H}
        snapToAlignment="start"
        decelerationRate="fast"
        bounces
        showsVerticalScrollIndicator={false}
        getItemLayout={reactions.length > 0 ? getItemLayout : undefined}
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

      {/* Floating header */}
      <SafeAreaView
        edges={["top"]}
        pointerEvents="box-none"
        style={styles.headerWrap}
      >
        <View style={styles.headerRow}>
          <View style={styles.brandRow}>
            <DropletLogo size={20} />
            <Text style={styles.brand}>Last Night</Text>
          </View>
          {reactions.length > 0 && (
            <View style={styles.countPill}>
              <Sparkles color={theme.accent} size={11} />
              <Text style={styles.countText}>
                {reactions.length} clip{reactions.length !== 1 ? "s" : ""}
              </Text>
            </View>
          )}
        </View>
      </SafeAreaView>


    </View>
  );
}

function ReactionItem({ post, active }: { post: Post; active: boolean }) {
  const [liked, setLiked] = useState<boolean>(false);
  const videoRef = useRef<Video>(null);
  const name =
    post.profile?.display_name || post.profile?.username || "dropper";

  // Reset liked state when post changes
  const postIdRef = useRef<string>(post.id);
  if (postIdRef.current !== post.id) {
    postIdRef.current = post.id;
  }
  useEffect(() => {
    setLiked(false);
  }, [post.id]);

  const onPlaybackStatus = useCallback((status: AVPlaybackStatus) => {
    // No-op — just needed for the Video component to function
  }, []);

  return (
    <View style={styles.item}>
      {post.media_type === "video" ? (
        <Video
          ref={videoRef}
          source={{ uri: post.media_url }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          isLooping
          shouldPlay={active}
          isMuted={!active}
          useNativeControls={false}
          progressUpdateIntervalMillis={50}
          onPlaybackStatusUpdate={onPlaybackStatus}
        />
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
          <Text style={styles.username}>
            @{post.profile?.username ?? "dropper"}
          </Text>
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
  countPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  countText: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700" as const,
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
    lineHeight: 19,
  },


});
