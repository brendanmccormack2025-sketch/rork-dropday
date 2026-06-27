import React, { useMemo, useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react-native";

import { FeedListView } from "@/components/FeedListView";
import { theme } from "@/constants/theme";
import { type Post } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { supabase } from "@/lib/supabase";

/**
 * Full-screen video feed showing a specific user's root drops.
 *
 * Uses the exact same FeedListView component as the main Drop feed tab,
 * so all video playback, like/delete/react/share buttons, and swipe
 * navigation work identically. The only difference is the data source
 * (one user's drops instead of the global feed).
 */
export default function ProfileDropsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ userId: string; initialIndex: string }>();
  const userId = params.userId ?? user?.id ?? "";
  const initialIndex = parseInt(params.initialIndex ?? "0", 10);

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

  const handleReactions = useCallback(
    (post: Post) => {
      console.log("[DEBUG] profile-drops handleReactions called, postId=", post.id);
      router.push(`/post/${post.id}/reaction-tree` as never);
    },
    [router],
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
      isLoading={isLoading}
      initialIndex={initialIndex}
      // This screen is a fullScreenModal — always focused while mounted.
      // Override useVideoFocus (which tracks tab focus) so playback starts
      // immediately without waiting for a tab-focus event.
      forceFocused
      onReactionsPost={handleReactions}
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
