import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Dimensions,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  View,
  ViewToken,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react-native";

import { FeedItem } from "@/components/FeedItem";
import { theme } from "@/constants/theme";
import { type Post } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { supabase } from "@/lib/supabase";

const { height: SCREEN_H } = Dimensions.get("window");

export default function ProfileDropsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ userId: string; initialIndex: string }>();
  const userId = params.userId ?? user?.id ?? "";
  const initialIndex = parseInt(params.initialIndex ?? "0", 10);

  // This screen is a fullScreenModal — always focused while mounted.
  // We don't use useVideoFocus() here because the tab screen underneath
  // may still hold focus briefly during the push transition, causing
  // a false-negative that freezes the video on first render.
  const screenFocused = true;

  const [activeIndex, setActiveIndex] = useState<number>(initialIndex);
  const listRef = useRef<FlatList<Post>>(null);

  // Fetch this profile's root drops (no reactions)
  const { data: posts = [], isLoading } = useQuery({
    queryKey: ["posts", "user-drops", userId],
    enabled: !!userId,
    queryFn: async (): Promise<Post[]> => {
      const { data, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("user_id", userId)
        .is("parent_post_id", null)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return [];
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        media_url: row.media_url as string,
        media_type: row.media_type as "image" | "video",
        caption: (row.caption as string | null) ?? null,
        parent_post_id: (row.parent_post_id as string | null) ?? null,
        segments: (row.segments as string[] | null) ?? null,
        audio_url: (row.audio_url as string | null) ?? null,
        trim_data: (row.trim_data as Post["trim_data"]) ?? null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.like_count as number | undefined) ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

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

  const handleShare = useCallback(
    async (post: Post) => {
      try {
        await Share.share({
          message: `Check out this DropDay: ${post.media_url}`,
        });
      } catch {}
    },
    [],
  );

  const handleReactions = useCallback(
    (postId: string) => {
      router.push(`/post/${postId}/reaction-tree` as never);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <FeedItem
        post={item}
        active={index === activeIndex && screenFocused}
        live
        onShare={() => handleShare(item)}
        onReactions={() => handleReactions(item.id)}
        onRetry={() => {}}
      />
    ),
    [activeIndex, screenFocused, handleShare, handleReactions],
  );

  const profileName = useMemo(
    () =>
      posts[0]?.profile?.display_name ??
      posts[0]?.profile?.username ??
      "Profile",
    [posts],
  );

  if (isLoading && posts.length === 0) {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={["top"]} style={styles.safe}>
          <UiText style={styles.loading}>Loading drops…</UiText>
        </SafeAreaView>
      </View>
    );
  }

  if (posts.length === 0) {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={["top"]} style={styles.safe}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
            <ArrowLeft color="#fff" size={24} strokeWidth={2.5} />
          </Pressable>
          <View style={styles.emptyWrap}>
            <UiText style={styles.emptyTitle}>No drops yet</UiText>
            <UiText style={styles.emptySub}>
              This user hasn't posted any drops.
            </UiText>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // Clamp initialIndex to valid range
  const safeInitialIndex = Math.max(0, Math.min(initialIndex, posts.length - 1));

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={posts}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        snapToInterval={SCREEN_H}
        snapToAlignment="start"
        decelerationRate="fast"
        bounces
        showsVerticalScrollIndicator={false}
        getItemLayout={getItemLayout}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        initialScrollIndex={safeInitialIndex}
        onScrollToIndexFailed={(info) => {
          // Retry after a short delay if the initial scroll misses
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: info.index,
              animated: false,
            });
          }, 100);
        }}
        // removeClippedSubviews must be false — when true on native,
        // expo-av Video backing views are detached during scroll,
        // freezing the player permanently.
        removeClippedSubviews={false}
        windowSize={5}
        maxToRenderPerBatch={3}
        initialNumToRender={2}
      />

      {/* Back button overlay */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.headerWrap}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
        >
          <ArrowLeft color="#fff" size={24} strokeWidth={2.5} />
        </Pressable>
        <UiText style={styles.headerTitle} numberOfLines={1}>
          @{posts[0]?.profile?.username ?? "profile"}
        </UiText>
        <View style={styles.headerSpacer} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0A0A14",
  },
  safe: {
    flex: 1,
  },
  loading: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    marginTop: 40,
  },

  /* Header overlay */
  headerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    flexShrink: 1,
    textAlign: "center",
  },
  headerSpacer: {
    width: 40,
  },

  /* Empty */
  emptyWrap: {
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
  },
});
