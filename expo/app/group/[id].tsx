import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Video, ResizeMode } from "expo-av";
import { ArrowLeft, Heart, LogOut, Trash2, Users } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";

import { theme } from "@/constants/theme";
import { showAlert } from "@/lib/showAlert";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts } from "@/providers/PostsProvider";
import { useGroups, type GroupPost } from "@/providers/GroupsProvider";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";

/**
 * Group page — name, accepted-member avatar row, and the group's post feed.
 * Group posts live in the main posts table (group_id set); posting happens
 * via the + button → Group Drop. Leaving sets membership to "left"; past
 * posts remain on the page.
 */
export default function GroupFeedScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = Array.isArray(id) ? id[0] : id;

  const { toggleLike, deletePost } = usePosts();
  const { useGroupPosts, useGroupMembers, leaveGroup } = useGroups();

  const postsQuery = useGroupPosts(groupId);
  const membersQuery = useGroupMembers(groupId);

  const posts = postsQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const memberCount = members.length;

  // Group metadata (name + avatar)
  const groupQuery = useQuery({
    queryKey: ["group-meta", groupId],
    enabled: !!groupId,
    staleTime: 60_000,
    queryFn: async (): Promise<{ id: string; name: string; avatar_url: string | null } | null> => {
      if (!groupId) return null;
      try {
        const { data, error } = await supabase
          .from("groups")
          .select("id, name, avatar_url")
          .eq("id", groupId)
          .maybeSingle();
        if (error) {
          console.warn("[group-meta] error", error.message);
          return null;
        }
        return (data as { id: string; name: string; avatar_url: string | null }) ?? null;
      } catch (e) {
        console.warn("[group-meta] fetch error", (e as Error)?.message ?? e);
        return null;
      }
    },
  });

  const isMember = useMemo(
    () => !!user?.id && members.some((m) => m.user_id === user.id),
    [members, user?.id],
  );

  // Local like overrides — toggleLike patches the main feed caches, not the
  // group-posts cache, so the card keeps its own optimistic state.
  const [likeOverrides, setLikeOverrides] = useState<
    Record<string, { liked: boolean; count: number }>
  >({});

  const likeStateFor = useCallback(
    (post: GroupPost) => {
      const override = likeOverrides[post.id];
      return {
        liked: override ? override.liked : post.has_liked,
        count: override ? override.count : post.like_count,
      };
    },
    [likeOverrides],
  );

  const handleToggleLike = useCallback(
    (post: GroupPost) => {
      const current = likeStateFor(post);
      const next = {
        liked: !current.liked,
        count: Math.max(0, current.count + (current.liked ? -1 : 1)),
      };
      setLikeOverrides((prev) => ({ ...prev, [post.id]: next }));
      toggleLike.mutate({ postId: post.id, liked: next.liked });
    },
    [likeStateFor, toggleLike],
  );

  const handleDeletePost = useCallback(
    (post: GroupPost) => {
      Alert.alert("Delete post?", "This will remove your post from the group.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deletePost.mutateAsync(post.id);
              await postsQuery.refetch();
            } catch (e) {
              showAlert("Delete failed", (e as Error)?.message ?? "Could not delete post.");
            }
          },
        },
      ]);
    },
    [deletePost, postsQuery],
  );

  const handleLeave = useCallback(() => {
    if (!groupId) return;
    Alert.alert(
      "Leave this group?",
      "Your past posts will remain on the group page.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
            try {
              await leaveGroup.mutateAsync({ groupId });
              router.back();
            } catch (e) {
              showAlert("Couldn't leave", (e as Error)?.message ?? "Something went wrong.");
            }
          },
        },
      ],
    );
  }, [groupId, leaveGroup, router]);

  const navigateToProfile = useCallback(
    (userId: string) => {
      if (userId === user?.id) {
        router.push("/(tabs)/profile" as never);
      } else {
        router.push({ pathname: "/user/[id]", params: { id: userId } } as never);
      }
    },
    [router, user?.id],
  );

  const groupName = groupQuery.data?.name ?? "Group";
  const groupAvatarUrl = groupQuery.data?.avatar_url ?? null;

  const renderPost = useCallback(
    ({ item }: { item: GroupPost }) => {
      const likeState = likeStateFor(item);
      return (
        <GroupPostCard
          post={item}
          liked={likeState.liked}
          likeCount={likeState.count}
          isOwn={user?.id === item.user_id}
          onToggleLike={() => handleToggleLike(item)}
          onDelete={() => handleDeletePost(item)}
          onPressProfile={() => navigateToProfile(item.user_id)}
        />
      );
    },
    [likeStateFor, handleToggleLike, handleDeletePost, navigateToProfile, user?.id],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft color={theme.text} size={22} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.headerCenter}>
          <UiText style={styles.headerTitle} numberOfLines={1}>
            {groupName}
          </UiText>
          <View style={styles.memberBadge}>
            <Users color={theme.textDim} size={11} strokeWidth={2.5} />
            <UiText style={styles.memberCount}>
              {memberCount} member{memberCount !== 1 ? "s" : ""}
            </UiText>
          </View>
        </View>
        {isMember ? (
          <Pressable onPress={handleLeave} style={styles.backBtn} hitSlop={8}>
            <LogOut color={theme.danger} size={19} strokeWidth={2.2} />
          </Pressable>
        ) : (
          <View style={styles.backBtn} />
        )}
      </View>

      {/* Accepted members row */}
      <View style={styles.membersBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.membersRow}>
          {members.map((m) => {
            const name = m.profile?.display_name ?? m.profile?.username ?? "Member";
            return (
              <Pressable
                key={m.user_id}
                onPress={() => navigateToProfile(m.user_id)}
                style={styles.memberItem}
              >
                <FeedAvatar profile={m.profile} name={name} />
                <UiText style={styles.memberName} numberOfLines={1}>
                  {name}
                </UiText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Posts list */}
      <FlatList
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={renderPost}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          postsQuery.isLoading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator color={theme.accent} size="large" />
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Users color={theme.textDim} size={48} strokeWidth={1.5} />
              <UiText style={styles.emptyTitle}>No posts yet</UiText>
              <UiText style={styles.emptySub}>
                Use the + button → Group Drop to post a video from your camera roll here.
              </UiText>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

// ── Group Post Card ──────────────────────────────────────────────────────────

function GroupPostCard({
  post,
  liked,
  likeCount,
  isOwn,
  onToggleLike,
  onDelete,
  onPressProfile,
}: {
  post: GroupPost;
  liked: boolean;
  likeCount: number;
  isOwn: boolean;
  onToggleLike: () => void;
  onDelete: () => void;
  onPressProfile: () => void;
}) {
  const posterName = post.profile?.display_name ?? post.profile?.username ?? "User";

  return (
    <View style={styles.card}>
      {/* Poster info */}
      <View style={styles.cardHeader}>
        <Pressable onPress={onPressProfile} style={styles.cardHeaderPressable}>
          <FeedAvatar profile={post.profile} name={posterName} />
          <View style={styles.posterInfo}>
            <UiText style={styles.posterName} numberOfLines={1}>
              {posterName}
            </UiText>
            <UiText style={styles.posterHandle} numberOfLines={1}>
              @{post.profile?.username ?? "user"}
            </UiText>
          </View>
        </Pressable>
        {isOwn && (
          <Pressable onPress={onDelete} hitSlop={8} style={styles.deleteBtn}>
            <Trash2 color={theme.textDim} size={18} strokeWidth={2} />
          </Pressable>
        )}
      </View>

      {/* Media */}
      <View style={styles.mediaWrap}>
        {post.media_type === "video" ? (
          <Video
            source={{ uri: post.media_url }}
            style={styles.media}
            resizeMode={ResizeMode.COVER}
            shouldPlay={false}
            isLooping
            useNativeControls
          />
        ) : (
          <Image
            source={{ uri: post.media_url }}
            style={styles.media}
            contentFit="cover"
            transition={120}
            cachePolicy="memory-disk"
          />
        )}
      </View>

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable
          onPress={onToggleLike}
          style={({ pressed }) => [
            styles.reactionBtn,
            pressed && styles.reactionBtnPressed,
          ]}
          hitSlop={8}
        >
          <Heart
            color={liked ? "#FF453A" : theme.textMuted}
            size={22}
            strokeWidth={liked ? 0 : 2.5}
            fill={liked ? "#FF453A" : "none"}
          />
          {likeCount > 0 && (
            <UiText style={[styles.reactionCount, liked && styles.reactionCountActive]}>
              {likeCount}
            </UiText>
          )}
        </Pressable>
      </View>

      {/* Caption */}
      {post.caption && (
        <View style={styles.captionWrap}>
          <UiText style={styles.posterNameInline}>{posterName}</UiText>
          <UiText style={styles.captionText}>{post.caption}</UiText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  memberBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  memberCount: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "500" as const,
  },

  /* Members bar */
  membersBar: {
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    paddingVertical: 10,
  },
  membersRow: {
    paddingHorizontal: 12,
    gap: 14,
  },
  memberItem: {
    alignItems: "center",
    gap: 4,
    width: 52,
  },
  memberName: {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: "600" as const,
  },

  /* List */
  list: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 40,
    gap: 16,
  },

  /* Card */
  card: {
    backgroundColor: theme.card,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardHeaderPressable: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  posterInfo: {
    flex: 1,
    gap: 1,
  },
  posterName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  posterHandle: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "500" as const,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Media */
  mediaWrap: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: "#000",
  },
  media: {
    width: "100%",
    height: "100%",
  },

  /* Actions */
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 16,
  },
  reactionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  reactionBtnPressed: {
    transform: [{ scale: 0.92 }],
  },
  reactionCount: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  reactionCountActive: {
    color: "#FF453A",
  },

  /* Caption */
  captionWrap: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  posterNameInline: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700" as const,
  },
  captionText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "400" as const,
    flex: 1,
  },

  /* Empty */
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
    paddingVertical: 80,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    textAlign: "center",
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
