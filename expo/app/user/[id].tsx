import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock,
  Heart,
  MessageCircle,
  Sparkles,
  UserCheck,
  UserPlus,
  Video,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { ProfileAvatar } from "@/components/Avatar";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, resolveAvatarUrl, type Post } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

const { width: SCREEN_W } = Dimensions.get("window");
const GAP = 4;
const COL_WIDTH = (SCREEN_W - 32 - GAP) / 2;

export default function PublicProfileScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { followUser, unfollowUser } = usePosts();
  const [followPending, setFollowPending] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const isOwnProfile = !!user?.id && user.id === id;

  // ── Profile query ────────────────────────────────────────────────────
  const profileQuery = useQuery({
    queryKey: ["profile", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, bio")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        console.warn("[user/profile] error", error.message);
        return null;
      }
      return data
        ? {
            id: data.id as string,
            username: data.username as string,
            display_name: (data.display_name as string | null) ?? null,
            avatar_url: (data.avatar_url as string | null) ?? null,
            bio: (data.bio as string | null) ?? null,
          }
        : null;
    },
  });

  const profile = profileQuery.data ?? null;

  // ── Drops query ──────────────────────────────────────────────────────
  const dropsQuery = useQuery({
    queryKey: ["posts", "user", id],
    enabled: !!id,
    queryFn: async (): Promise<Post[]> => {
      if (!id) return [];
      const { data, error } = await supabase
        .from("posts")
        .select(
          "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
        )
        .eq("user_id", id)
        .is("parent_post_id", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        console.warn("[user/drops] error", error.message);
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
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.like_count as number | undefined) ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const drops = dropsQuery.data ?? [];

  // ── Followers / following counts ─────────────────────────────────────
  const { data: followersCount = 0 } = useQuery({
    queryKey: ["followers-count", id],
    enabled: !!id,
    queryFn: async (): Promise<number> => {
      if (!id) return 0;
      const { count, error } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("followee_id", id);
      if (error) return 0;
      return count ?? 0;
    },
  });

  const { data: followingCount = 0 } = useQuery({
    queryKey: ["following-count", id],
    enabled: !!id,
    queryFn: async (): Promise<number> => {
      if (!id) return 0;
      const { count, error } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("follower_id", id);
      if (error) return 0;
      return count ?? 0;
    },
  });

  // ── Follow status: 'none' | 'pending' | 'accepted' ──────────────────
  const { data: followStatus = "none" } = useQuery({
    queryKey: ["is-following", user?.id, id],
    enabled: !!user?.id && !!id && !isOwnProfile,
    queryFn: async (): Promise<"none" | "pending" | "accepted"> => {
      if (!user?.id || !id) return "none";
      const { data, error } = await supabase
        .from("follows")
        .select("status")
        .eq("follower_id", user.id)
        .eq("followee_id", id)
        .maybeSingle();
      if (error) return "none";
      if (!data) return "none";
      return (data.status as "pending" | "accepted") ?? "none";
    },
  });

  const isFollowing = followStatus === "accepted";
  const isRequested = followStatus === "pending";

  // ── Follow / Unfollow / Cancel request ───────────────────────────────
  const handleToggleFollow = useCallback(async () => {
    console.log("[follow-debug] handler called. id:", id, "isOwnProfile:", isOwnProfile, "followPending:", followPending, "followStatus:", followStatus);
    if (!id || isOwnProfile || followPending) return;
    setFollowPending(true);
    try {
      if (followStatus === "accepted") {
        // Following → Unfollow (delete row)
        await unfollowUser.mutateAsync(id);
      } else if (followStatus === "pending") {
        // Requested → Cancel request (delete row)
        await unfollowUser.mutateAsync(id);
      } else {
        // Not following → Follow (insert row; trigger sets status)
        await followUser.mutateAsync(id);
      }
    } catch (e) {
      console.warn("[user/follow] error", (e as Error)?.message ?? e);
    } finally {
      setFollowPending(false);
    }
  }, [id, isOwnProfile, followStatus, followPending, followUser, unfollowUser]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      profileQuery.refetch(),
      dropsQuery.refetch(),
    ]);
    setRefreshing(false);
  }, [profileQuery, dropsQuery]);

  const displayName = useMemo(
    () => profile?.display_name ?? profile?.username ?? "dropper",
    [profile],
  );
  const username = useMemo(
    () => profile?.username ?? "dropper",
    [profile],
  );

  const isLoading = profileQuery.isLoading || dropsQuery.isLoading;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <FlatList
          data={drops}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={drops.length > 0 ? styles.row : undefined}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.accent}
              progressBackgroundColor={theme.card}
            />
          }
          ListHeaderComponent={
            <View style={styles.header}>
              {/* Top bar */}
              <View style={styles.topBar}>
                <Pressable
                  onPress={() => {
                    if (router.canGoBack()) router.back();
                    else router.replace("/(tabs)");
                  }}
                  style={styles.backBtn}
                  hitSlop={8}
                >
                  <ArrowLeft color={theme.text} size={20} strokeWidth={2} />
                </Pressable>
                <UiText style={styles.topBarTitle} numberOfLines={1}>
                  @{username}
                </UiText>
                <View style={styles.backBtn} />
              </View>

              {isLoading ? (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={theme.accent} size="large" />
                </View>
              ) : (
                <>
                  {/* Avatar + name */}
                  <View style={styles.profileRow}>
                    <View style={styles.avatarWrap}>
                      <ProfileAvatar
                        avatarUrl={profile?.avatar_url}
                        name={displayName}
                      />
                    </View>
                    <View style={styles.profileInfo}>
                      <UiText style={styles.displayName} numberOfLines={1}>
                        {displayName}
                      </UiText>
                      <UiText style={styles.usernameText}>@{username}</UiText>
                    </View>
                  </View>

                  {/* Bio */}
                  {profile?.bio ? (
                    <UiText style={styles.bio}>{profile.bio}</UiText>
                  ) : null}

                  {/* Follow / Send Message button */}
                  {!isOwnProfile && (
                    <View style={styles.actionRow}>
                      <Pressable
                        onPress={handleToggleFollow}
                        disabled={followPending}
                        style={({ pressed }) => [
                          styles.followBtn,
                          (isFollowing || isRequested) && styles.followBtnActive,
                          pressed && !isFollowing && !isRequested && styles.followBtnPressed,
                          pressed && (isFollowing || isRequested) && styles.followBtnActivePressed,
                        ]}
                      >
                        {followPending ? (
                          <ActivityIndicator
                            color={isFollowing || isRequested ? theme.textMuted : "#fff"}
                            size="small"
                          />
                        ) : isFollowing ? (
                          <>
                            <UserCheck color={theme.textMuted} size={16} strokeWidth={2.5} />
                            <UiText style={styles.followBtnTextActive}>Following</UiText>
                          </>
                        ) : isRequested ? (
                          <>
                            <Clock color={theme.textMuted} size={16} strokeWidth={2.5} />
                            <UiText style={styles.followBtnTextActive}>Requested</UiText>
                          </>
                        ) : (
                          <>
                            <UserPlus color="#fff" size={16} strokeWidth={2.5} />
                            <UiText style={styles.followBtnText}>Follow</UiText>
                          </>
                        )}
                      </Pressable>
                    </View>
                  )}

                  {/* Stats row */}
                  <View style={styles.statsRow}>
                    <View style={styles.stat}>
                      <UiText style={styles.statNum}>{drops.length}</UiText>
                      <UiText style={styles.statLabel}>Drops</UiText>
                    </View>
                    <View style={styles.statDivider} />
                    <Pressable
                      style={styles.stat}
                      onPress={() => {
                        if (!id) return;
                        router.push({
                          pathname: "/follow-list",
                          params: {
                            userId: id,
                            type: "followers",
                            title: "Followers",
                          },
                        } as never);
                      }}
                    >
                      <UiText style={styles.statNum}>{followersCount}</UiText>
                      <UiText style={styles.statLabel}>Followers</UiText>
                    </Pressable>
                    <View style={styles.statDivider} />
                    <Pressable
                      style={styles.stat}
                      onPress={() => {
                        if (!id) return;
                        router.push({
                          pathname: "/follow-list",
                          params: {
                            userId: id,
                            type: "following",
                            title: "Following",
                          },
                        } as never);
                      }}
                    >
                      <UiText style={styles.statNum}>{followingCount}</UiText>
                      <UiText style={styles.statLabel}>Following</UiText>
                    </Pressable>
                  </View>

                  {/* Section header */}
                  <View style={styles.sectionHeader}>
                    <Sparkles color={theme.accent} size={14} strokeWidth={2} />
                    <UiText style={styles.sectionLabel}>Drops</UiText>
                  </View>
                </>
              )}
            </View>
          }
          ListEmptyComponent={
            !isLoading ? (
              <View style={styles.empty}>
                <Video color={theme.textDim} size={40} strokeWidth={1.5} />
                <UiText style={styles.emptyTitle}>No drops yet</UiText>
                <UiText style={styles.emptySub}>
                  @{username} hasn't posted any drops yet.
                </UiText>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ProfileTile
              post={item}
              onPress={() => {
                router.push({
                  pathname: "/profile-drops",
                  params: { userId: id, initialIndex: "0" },
                } as never);
              }}
            />
          )}
        />
      </SafeAreaView>
    </View>
  );
}

function ProfileTile({ post, onPress }: { post: Post; onPress: () => void }) {
  const coverUri = post.thumbnail_url ?? post.media_url;
  return (
    <Pressable onPress={onPress} style={styles.tile}>
      <Image
        source={{ uri: coverUri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={100}
      />
      {post.media_type === "video" && (
        <View style={styles.videoBadge}>
          <Video color="#fff" size={10} fill="#fff" />
        </View>
      )}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.7)"]}
        style={styles.tileGrad}
      />
      <View style={styles.tileBottom}>
        <View style={styles.tileStats}>
          <Heart color={theme.danger} size={10} fill={theme.danger} />
          <UiText style={styles.tileStatText}>{post.like_count ?? 0}</UiText>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  listContent: { paddingBottom: 120 },

  /* Header */
  header: { paddingHorizontal: 16, paddingTop: 8 },

  /* Top bar */
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  topBarTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700" as const,
    letterSpacing: -0.2,
  },

  /* Loading */
  loadingWrap: {
    paddingVertical: 60,
    alignItems: "center",
  },

  /* Profile row */
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 16,
  },
  avatarWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  displayName: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  usernameText: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: "600" as const,
  },

  /* Bio */
  bio: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "500" as const,
    lineHeight: 20,
    marginBottom: 16,
  },

  /* Follow / message buttons */
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 18,
  },
  followBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.accent,
    paddingVertical: 13,
    borderRadius: 12,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  followBtnPressed: {
    backgroundColor: theme.primaryDeep,
    transform: [{ scale: 0.97 }],
  },
  followBtnActive: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnActivePressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  followBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700" as const,
  },
  followBtnTextActive: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: "600" as const,
  },

  /* Stats */
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    marginBottom: 22,
  },
  stat: {
    alignItems: "center",
    gap: 3,
  },
  statNum: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "800" as const,
    letterSpacing: -0.4,
  },
  statLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "600" as const,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: "rgba(255,255,255,0.06)",
  },

  /* Section header */
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  sectionLabel: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },

  /* Empty */
  empty: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 56,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },

  /* Tile grid */
  row: { gap: GAP, marginBottom: GAP },
  tile: {
    flex: 1,
    aspectRatio: 0.85,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: theme.card,
  },
  tileGrad: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "50%",
  },
  videoBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  tileBottom: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tileStats: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tileStatText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700" as const,
  },
});
