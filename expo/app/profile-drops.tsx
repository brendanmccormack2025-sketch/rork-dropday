import React, { useEffect, useMemo, useCallback } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";

import { FeedListView } from "@/components/FeedListView";
import { theme } from "@/constants/theme";
import { usePosts, type Post } from "@/providers/PostsProvider";

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
  const { myPosts, refetchMyPosts } = usePosts();
  const insets = useSafeAreaInsets();

  // Refetch on mount so reaction_count and other aggregate fields are
  // current — avoids inheriting a stale cached payload from the profile tab.
  useEffect(() => { refetchMyPosts(); }, [refetchMyPosts]);
  const params = useLocalSearchParams<{ initialIndex: string }>();
  const initialIndex = parseInt(params.initialIndex ?? "0", 10);

  // Filter to root drops only (same logic as the profile grid's "drops" memo).
  // This data comes from the SAME myPostsQuery in PostsProvider that the
  // profile grid uses, so reaction_count values are always identical.
  const posts = useMemo(
    () => myPosts.filter((p) => !p.parent_post_id),
    [myPosts],
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
          message: `Check out this DropDay: ${post.media_url}`,
        });
      } catch {}
    },
    [],
  );

  const profileDisplay = useMemo(
    () => `@${posts[0]?.profile?.username ?? "profile"}`,
    [posts],
  );

  // Use safe area bottom inset for action buttons / username positioning
  // (no tab bar on this screen, so base offset is just the home indicator height)
  const bottomInset = insets.bottom + 8;

  return (
    <FeedListView
      posts={posts}
      isLoading={false}
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
            // Position below status bar / Dynamic Island using safe area top inset
            { paddingTop: insets.top + 12, zIndex: 999 },
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
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
