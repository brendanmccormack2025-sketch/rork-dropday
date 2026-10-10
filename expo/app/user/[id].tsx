import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Ban, Trophy } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { type Post } from "@/providers/PostsProvider";
import { profilePostIds } from "@/lib/profilePosts";
import { isOnOtherProfile } from "@/lib/profileVisibility";
import { LinkIconRow, PostTile, ProfileEmpty, RoundAvatar, RoundIconButton, SoftButton, gridStyles } from "@/components/profile/ProfileParts";
import { SIDE_MARGIN, colors, space, type } from "@/constants/design";
import { EMPTY_OTHER_SURVIVED, GRID_COLUMNS } from "@/lib/profileUi";
import VerifiedCreatorBadge from "@/components/VerifiedCreatorBadge";
import { graduationColumns, linkSourceFor, noteMissingGraduationColumns, parseCreatorStatus, showsVerifiedBadge } from "@/lib/creatorStatus";
import { noteMissingYoutubeColumn, profileLinkColumns } from "@/lib/creatorLinks";
import { supabase } from "@/lib/supabase";
import { useUserBlocks } from "@/hooks/useUserBlocks";

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
          key={`grid-${GRID_COLUMNS}`}
          numColumns={GRID_COLUMNS}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={visibleDrops.length > 0 ? gridStyles.row : undefined}
          contentContainerStyle={gridStyles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} progressBackgroundColor={theme.card} />}
          ListHeaderComponent={
            <View>
              <View style={styles.topBar}>
                <RoundIconButton
                  label="Back"
                  onPress={() => {
                    if (navigation.canGoBack()) router.back();
                    else router.replace("/(tabs)");
                  }}
                >
                  <ArrowLeft color={colors.text} size={19} strokeWidth={2.2} />
                </RoundIconButton>
              </View>

              {isLoading ? (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={theme.accent} size="large" />
                </View>
              ) : (
                <View style={styles.identity}>
                  <RoundAvatar avatarUrl={profile?.avatar_url} name={displayName} />
                  <View style={styles.nameRow}>
                    <UiText style={styles.name} numberOfLines={1}>
                      {displayName}
                    </UiText>
                    {showsVerifiedBadge(profile) ? <VerifiedCreatorBadge compact /> : null}
                  </View>
                  <UiText style={styles.handle}>@{username}</UiText>
                  {profile?.bio ? (
                    <UiText style={styles.bio} numberOfLines={3}>
                      {profile.bio}
                    </UiText>
                  ) : null}
                  <LinkIconRow profile={linkSourceFor(profile)} />
                  {!isOwnProfile && (
                    <View style={styles.actionWrap}>
                      <SoftButton
                        label={userProfileBlocked ? "Unblock" : "Block"}
                        disabled={blockPending}
                        icon={<Ban color={colors.textSecondary} size={15} strokeWidth={2.2} />}
                        onPress={() => (userProfileBlocked ? unblockUser(id) : blockUser(id))}
                      />
                    </View>
                  )}
                </View>
              )}
              <View style={{ height: space.lg }} />
            </View>
          }
          ListEmptyComponent={
            !isLoading ? (
              userProfileBlocked ? (
                <ProfileEmpty
                  icon={<Ban color={colors.textTertiary} size={36} strokeWidth={1.6} />}
                  title="You've blocked this account"
                  body={`Unblock @${username} to see their posts again.`}
                />
              ) : (
                <ProfileEmpty icon={<Trophy color={colors.textTertiary} size={36} strokeWidth={1.6} />} title={EMPTY_OTHER_SURVIVED} />
              )
            ) : null
          }
          renderItem={({ item, index }) => (
            <PostTile
              post={item}
              onPress={() => {
                router.push({ pathname: "/profile-drops", params: { userId: id, initialIndex: String(index) } } as never);
              }}
            />
          )}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  safe: { flex: 1 },
  topBar: { flexDirection: "row", justifyContent: "flex-start", paddingHorizontal: SIDE_MARGIN, paddingTop: space.sm },
  loadingWrap: { paddingVertical: space.xxl, alignItems: "center" },
  identity: { alignItems: "center", paddingHorizontal: SIDE_MARGIN, paddingTop: space.xs },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md, maxWidth: "100%" },
  name: { color: colors.text, ...type.name, flexShrink: 1 },
  handle: { color: colors.textSecondary, ...type.handle, marginTop: 2 },
  bio: { color: colors.text, ...type.body, textAlign: "center", marginTop: space.md, maxWidth: 320 },
  actionWrap: { marginTop: space.lg },
});
