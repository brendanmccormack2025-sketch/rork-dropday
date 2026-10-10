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
import { TrialStatusBadge } from "@/components/TrialStatusBadge";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Heart,
  MessageCircle,
  Sparkles,
  Video,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { ProfileAvatar } from "@/components/Avatar";
import { useAuth } from "@/providers/AuthProvider";
import { resolveAvatarUrl, type Post } from "@/providers/PostsProvider";
import { profilePostIds } from "@/lib/profilePosts";
import { isOnOtherProfile } from "@/lib/profileVisibility";
import CreatorLinkPills from "@/components/CreatorLinkPills";
import VerifiedCreatorBadge from "@/components/VerifiedCreatorBadge";
import { graduationColumns, linkSourceFor, noteMissingGraduationColumns, parseCreatorStatus, showsVerifiedBadge } from "@/lib/creatorStatus";
import { noteMissingYoutubeColumn, profileLinkColumns } from "@/lib/creatorLinks";
import { supabase } from "@/lib/supabase";
import { useUserBlocks } from "@/hooks/useUserBlocks";

const { width: SCREEN_W } = Dimensions.get("window");
const GAP = 4;
const COL_WIDTH = (SCREEN_W - 32 - GAP) / 2;

export default function PublicProfileScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const isOwnProfile = !!user?.id && user.id === id;
  const { blockUser, unblockUser, isBlocked, blockPending } = useUserBlocks();
  const userProfileBlocked = !isOwnProfile && isBlocked(id);

  // ── Profile query ────────────────────────────────────────────────────
  const profileQuery = useQuery({
    queryKey: ["profile", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return null;
      // Column list is built at run time (youtube_url may not exist yet).
      const run = async () =>
        (await supabase
          .from("profiles")
          .select(`id, username, display_name, avatar_url, bio, ${profileLinkColumns()}${graduationColumns()}`)
          .eq("id", id)
          .maybeSingle()) as unknown as {
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        };
      let { data, error } = await run();
      if (noteMissingYoutubeColumn(error)) ({ data, error } = await run());
      // The graduation columns do not exist until migration-graduation.sql is run: ask again without them.
      if (noteMissingGraduationColumns(error)) ({ data, error } = await run());
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
            website: (data.website as string | null) ?? null,
            instagram_handle: (data.instagram_handle as string | null) ?? null,
            tiktok_handle: (data.tiktok_handle as string | null) ?? null,
            youtube_url: (data.youtube_url as string | null | undefined) ?? null,
            creator_status: parseCreatorStatus(data.creator_status),
            graduation_reason: (data.graduation_reason as string | null | undefined) ?? null,
            graduated_at: (data.graduated_at as string | null | undefined) ?? null,
            instagram_url: (data.instagram_url as string | null | undefined) ?? null,
            tiktok_url: (data.tiktok_url as string | null | undefined) ?? null,
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
      // Other people's profile: posts that survived, newest first (also after their 24 h window; media kept). The server
      // decides which (profile_posts); without it, the same rules as a direct query.
      const ids = await profilePostIds(id);
      if (ids && ids.length === 0) return [];
      const select =
        "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, view_count, moderation_status, status, follower_visibility, created_at, survived_at, distribution_started_at, distribution_expires_at, expired_at, media_deleted_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url, instagram_handle, tiktok_handle, youtube_url, website)";
      let query = supabase.from("posts").select(select).is("parent_post_id", null).eq("moderation_status", "active");
      query = ids
        ? query.in("id", ids)
        : query.eq("user_id", id).not("survived_at", "is", null).in("status", ["survived", "expired"]).is("media_deleted_at", null);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(100);
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
        text_overlays: null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        status: (row.status as Post["status"]) ?? "trial",
        survived_at: (row.survived_at as string | null) ?? null,
        distribution_started_at: (row.distribution_started_at as string | null) ?? null,
        distribution_expires_at: (row.distribution_expires_at as string | null) ?? null,
        expired_at: (row.expired_at as string | null) ?? null,
        media_deleted_at: (row.media_deleted_at as string | null) ?? null,
        follower_visibility: (row.follower_visibility as boolean | null) ?? true,
        created_at: row.created_at as string,
        like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
    },
  });

  const drops = dropsQuery.data ?? [];

  // Blocked user's content is hidden entirely — the grid renders empty and
  // the ListEmptyComponent shows a blocked notice instead of their drops.
  const visibleDrops = useMemo(
    () => (userProfileBlocked ? [] : drops.filter(isOnOtherProfile)),
    [drops, userProfileBlocked],
  );

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
          data={visibleDrops}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={visibleDrops.length > 0 ? styles.row : undefined}
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
                    if (navigation.canGoBack()) router.back();
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
                      {showsVerifiedBadge(profile) ? <VerifiedCreatorBadge /> : null}
                    </View>
                  </View>

                  {/* Bio */}
                  {profile?.bio ? (
                    <UiText style={styles.bio}>{profile.bio}</UiText>
                  ) : null}

                  {/* Links (shared helper: only valid https links) */}
                  <CreatorLinkPills profile={linkSourceFor(profile)} />

                  {/* Block button */}
                  {!isOwnProfile && (
                    <View style={styles.actionRow}>
                      <Pressable
                        onPress={() => {
                          if (userProfileBlocked) {
                            unblockUser(id);
                          } else {
                            blockUser(id);
                          }
                        }}
                        disabled={blockPending}
                        style={({ pressed }) => [
                          styles.blockBtn,
                          userProfileBlocked && styles.blockBtnActive,
                          pressed && styles.blockBtnPressed,
                        ]}
                      >
                        {blockPending ? (
                          <ActivityIndicator color={theme.textMuted} size="small" />
                        ) : (
                          <>
                            <Ban
                              color={userProfileBlocked ? theme.textMuted : theme.textMuted}
                              size={16}
                              strokeWidth={2.5}
                            />
                            <UiText style={styles.blockBtnText}>
                              {userProfileBlocked ? "Unblock" : "Block"}
                            </UiText>
                          </>
                        )}
                      </Pressable>
                    </View>
                  )}

                  {/* Section header — hidden when this account is blocked */}
                  {!userProfileBlocked && (
                    <View style={styles.sectionHeader}>
                      <Sparkles color={theme.accent} size={14} strokeWidth={2} />
                      <UiText style={styles.sectionLabel}>On Trial now</UiText>
                    </View>
                  )}
                </>
              )}
            </View>
          }
          ListEmptyComponent={
            !isLoading ? (
              userProfileBlocked ? (
                <View style={styles.empty}>
                  <Ban color={theme.textDim} size={40} strokeWidth={1.5} />
                  <UiText style={styles.emptyTitle}>
                    You've blocked this account
                  </UiText>
                  <UiText style={styles.emptySub}>
                    Unblock @{username} to see their posts again.
                  </UiText>
                </View>
              ) : (
                <View style={styles.empty}>
                  <Video color={theme.textDim} size={40} strokeWidth={1.5} />
                  <UiText style={styles.emptyTitle}>Nothing on trial right now</UiText>
                  <UiText style={styles.emptySub}>
                    @{username} has no posts on trial at the moment.
                  </UiText>
                </View>
              )
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
      {/* Everything on someone else's profile survived Trial. */}
      <View style={styles.statusBadgeWrap}>
        <TrialStatusBadge status="survived" />
      </View>
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
    borderRadius: 0,
    backgroundColor: "rgba(10,10,10,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  topBarTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "900" as const,
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
    borderRadius: 0,
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
    fontWeight: "900" as const,
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
    borderRadius: 0,
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
    backgroundColor: "rgba(10,10,10,0.08)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.1)",
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnActivePressed: {
    backgroundColor: "rgba(10,10,10,0.06)",
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

  /* Block button */
  blockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(10,10,10,0.07)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.1)",
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 0,
  },
  blockBtnActive: {
    backgroundColor: "rgba(232,41,28,0.1)",
    borderColor: "rgba(232,41,28,0.2)",
  },
  blockBtnPressed: {
    opacity: 0.7,
  },
  blockBtnText: {
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
    fontWeight: "900" as const,
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
    backgroundColor: "rgba(10,10,10,0.07)",
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
    fontWeight: "900" as const,
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
    fontWeight: "900" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },

  /* Tile grid */
  row: { gap: GAP, marginBottom: GAP },
  statusBadgeWrap: { position: "absolute", top: 6, left: 6 },
  tile: {
    flex: 1,
    aspectRatio: 0.85,
    borderRadius: 0,
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
    borderRadius: 0,
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
    fontWeight: "900" as const,
  },
});
