import React, { useEffect, useMemo, useCallback } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react-native";

import { FeedListView } from "@/components/FeedListView";
import { theme } from "@/constants/theme";
import { usePosts, type Post } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { supabase } from "@/lib/supabase";

/**
 * Full-screen video feed showing the current user's root drops.
 *
 * Uses the exact same FeedListView component and the exact same data
 * source (usePosts().myPosts) as the profile grid, so all video playback,
 * like/delete/react/share buttons, swipe navigation, and reaction counts
 * work identically. The only difference from the main feed is the data
 * being passed (this user's drops instead of the global feed).
 */
export default function ProfileDropsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { myPosts } = usePosts();
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{ initialIndex: string; userId: string }>();
  const initialIndex = parseInt(params.initialIndex ?? "0", 10);
  const userId = params.userId ?? null;

  // When viewing another user's drops, fetch their posts directly using the
  // same pattern as the profile screen (user/[id].tsx).
  const isOtherUser = !!userId && userId !== user?.id;

  const otherUserPostsQuery = useQuery({
    queryKey: ["posts", "user", userId],
    enabled: isOtherUser,
    queryFn: async (): Promise<Post[]> => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, moderation_status, created_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("user_id", userId)
        .is("parent_post_id", null)
        .eq("moderation_status", "active")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        console.warn("[profile-drops/user] error", error.message);
        return [];
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        media_url: row.media_url as string,
        media_type: row.media_type as "image" | "video",
        caption: (row.caption as string | null) ?? null,
        parent_post_id: (row.parent_post_id as string | null) ?? null,
        segments: (row.segments as string[] | null) ?? null,
        audio_url: null,
        trim_data: null,
        text_overlays: null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  // Invalidate caches on mount so reaction_count and reaction-tree data
  // are current — avoids inheriting stale cached payloads.
  // invalidateQueries is more reliable than refetch() because it forces
  // a background refetch even if another fetch is already in-flight.
  useEffect(() => {
    if (isOtherUser) {
      qc.invalidateQueries({ queryKey: ["posts", "user", userId] });
    } else {
      qc.invalidateQueries({ queryKey: ["posts", "mine"] });
    }
    qc.invalidateQueries({ queryKey: ["posts", "all-reactions"] });
  }, [qc, isOtherUser, userId]);

  // Filter to root drops only. For own profile, use myPosts (same data source
  // as the profile grid). For other users, use the direct query result.
  const posts = useMemo(
    () =>
      (isOtherUser ? otherUserPostsQuery.data ?? [] : myPosts).filter(
        (p) => !p.parent_post_id,
      ),
    [isOtherUser, myPosts, otherUserPostsQuery.data],
  );

  const handleReactions = useCallback(
    (post: Post) => {
      router.push(`/post/${post.id}/reaction-tree` as never);
    },
    [router],
  );

  const handleShare = useCallback(
    async (post: Post) => {
      try {
        await Share.share({
          message: `Check out this Trial: ${post.media_url}`,
        });
      } catch {}
    },
    [],
  );

  const profileDisplay = useMemo(
    () =>
      isOtherUser && userId
        ? `@${posts[0]?.profile?.username ?? userId}`
        : `@${posts[0]?.profile?.username ?? "profile"}`,
    [posts, isOtherUser, userId],
  );

  const isLoading = isOtherUser ? otherUserPostsQuery.isLoading : false;

  // Use safe area bottom inset for action buttons / username positioning
  // (no tab bar on this screen, so base offset is just the home indicator height)
  const bottomInset = insets.bottom + 8;

  return (
    <FeedListView
      posts={posts}
      isLoading={isLoading}
      initialIndex={initialIndex}
      // This screen is a fullScreenModal — always focused while mounted.
      // Override useVideoFocus (which tracks tab focus) so playback starts
      // immediately without waiting for a tab-focus event.
      forceFocused
      onReactionsPost={handleReactions}
      onSharePost={handleShare}
      bottomInset={bottomInset}
      headerComponent={
        <View
          style={[
            styles.headerWrap,
            { paddingTop: insets.top + 12 },
          ]}
        >
          <Pressable
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={12}
          >
            <ArrowLeft color="#fff" size={24} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle} numberOfLines={1}>
            {profileDisplay}
          </UiText>
          <View style={styles.headerSpacer} />
        </View>
      }
      emptyComponent={
        <View style={styles.emptyWrap}>
          <View
            style={{
              position: "absolute",
              top: insets.top + 12,
              left: 16,
              zIndex: 999,
            }}
          >
            <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
              <ArrowLeft color="#fff" size={24} strokeWidth={2.5} />
            </Pressable>
          </View>
          <UiText style={styles.emptyTitle}>No drops yet</UiText>
          <UiText style={styles.emptySub}>
            This user hasn't posted any drops.
          </UiText>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  /* Header overlay */
  headerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
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
    fontWeight: "900" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
});
