import React, { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dimensions,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Globe,
  Heart,
  Instagram,
  LogOut,
  Music2,
  Pencil,
  Sparkles,
  Video,
  Save,
  Users,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { ProfileAvatar } from "@/components/Avatar";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, type MyProfile, type Post, type DraftProject } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

const { width: SCREEN_W } = Dimensions.get("window");
const GAP = 4;
const COL_WIDTH = (SCREEN_W - 32 - GAP) / 2;

type TabKey = "drops" | "drafts";

function TabBar({ tab, onTab, isOwnProfile }: { tab: TabKey; onTab: (t: TabKey) => void; isOwnProfile: boolean }) {
  return (
    <View style={styles.tabRow}>
      <Pressable
        onPress={() => onTab("drops")}
        style={[styles.tab, tab === "drops" && styles.tabActive]}
      >
        <Video
          color={tab === "drops" ? theme.accent : theme.textDim}
          size={14}
          strokeWidth={2}
        />
        <UiText
          style={[styles.tabLabel, tab === "drops" && styles.tabLabelActive]}
        >
          Drops
        </UiText>
      </Pressable>
      {isOwnProfile && (
        <Pressable
          onPress={() => onTab("drafts")}
          style={[styles.tab, tab === "drafts" && styles.tabActive]}
        >
          <Save
            color={tab === "drafts" ? theme.accent : theme.textDim}
            size={14}
            strokeWidth={2}
          />
          <UiText
            style={[
              styles.tabLabel,
              tab === "drafts" && styles.tabLabelActive,
            ]}
          >
            Drafts
          </UiText>
        </Pressable>
      )}
    </View>
  );
}

function ProfileHeader({
  displayName,
  username,
  myProfile,
  drops,
  tab,
  onTab,
  onEditProfile,
  onSignOut,
  isOwnProfile,
  followersCount,
  followingCount,
  onFollowersTap,
  onFollowingTap,
}: {
  displayName: string;
  username: string;
  myProfile: MyProfile | null;
  drops: Post[];
  tab: TabKey;
  onTab: (t: TabKey) => void;
  onEditProfile: () => void;
  onSignOut: () => void;
  isOwnProfile: boolean;
  followersCount: number;
  followingCount: number;
  onFollowersTap: () => void;
  onFollowingTap: () => void;
}) {
  const hasLinks = !!(
    myProfile?.website ||
    myProfile?.instagram_handle ||
    myProfile?.tiktok_handle
  );

  return (
    <View style={styles.header}>
      {/* Profile row */}
      <View style={styles.profileRow}>
        <View style={styles.avatar}>
          <ProfileAvatar
            avatarUrl={myProfile?.avatar_url}
            name={displayName}
          />
        </View>
        <View style={styles.profileInfo}>
          <UiText style={styles.displayName} numberOfLines={1}>
            {displayName}
          </UiText>
          <UiText style={styles.username}>@{username}</UiText>
        </View>
        <Pressable onPress={onSignOut} style={styles.signOutBtn} hitSlop={8}>
          <LogOut color={theme.textDim} size={16} strokeWidth={2} />
        </Pressable>
      </View>

      {/* Edit Profile button */}
      <Pressable
        onPress={onEditProfile}
        style={styles.editProfileBtn}
      >
        <Pencil color={theme.accent} size={16} strokeWidth={2} />
        <UiText style={styles.editProfileBtnText}>Edit Profile</UiText>
      </Pressable>

      {/* Bio */}
      {myProfile?.bio ? (
        <UiText style={styles.bio}>{myProfile.bio}</UiText>
      ) : null}

      {/* Links row */}
      {hasLinks ? (
        <View style={styles.linksRow}>
          {myProfile?.website ? (
            <Pressable
              style={styles.linkPill}
              onPress={() => {
                const url = myProfile.website!.startsWith("http")
                  ? myProfile.website!
                  : `https://${myProfile.website!}`;
                Linking.openURL(url).catch(() => {});
              }}
            >
              <Globe color={theme.accent} size={12} strokeWidth={2} />
              <UiText style={styles.linkText} numberOfLines={1}>
                {myProfile.website!
                  .replace(/^https?:\/\//, "")
                  .replace(/\/$/, "")}
              </UiText>
            </Pressable>
          ) : null}
          {myProfile?.instagram_handle ? (
            <Pressable
              style={styles.linkPill}
              onPress={() => {
                Linking.openURL(
                  `https://instagram.com/${myProfile.instagram_handle}`,
                ).catch(() => {});
              }}
            >
              <Instagram color="#E1306C" size={12} strokeWidth={2} />
              <UiText style={styles.linkText} numberOfLines={1}>
                {myProfile.instagram_handle}
              </UiText>
            </Pressable>
          ) : null}
          {myProfile?.tiktok_handle ? (
            <Pressable
              style={styles.linkPill}
              onPress={() => {
                Linking.openURL(
                  `https://tiktok.com/@${myProfile.tiktok_handle}`,
                ).catch(() => {});
              }}
            >
              <Music2 color={theme.text} size={12} strokeWidth={2} />
              <UiText style={styles.linkText} numberOfLines={1}>
                {myProfile.tiktok_handle}
              </UiText>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Stats row */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <UiText style={styles.statNum}>{drops.length}</UiText>
          <UiText style={styles.statLabel}>Drops</UiText>
        </View>
        <View style={styles.statDivider} />
        <Pressable style={styles.stat} onPress={onFollowersTap}>
          <UiText style={styles.statNum}>{followersCount}</UiText>
          <UiText style={styles.statLabel}>Followers</UiText>
        </Pressable>
        <View style={styles.statDivider} />
        <Pressable style={styles.stat} onPress={onFollowingTap}>
          <UiText style={styles.statNum}>{followingCount}</UiText>
          <UiText style={styles.statLabel}>Following</UiText>
        </Pressable>
      </View>

      {/* Tab switcher */}
      <TabBar tab={tab} onTab={onTab} isOwnProfile={isOwnProfile} />
    </View>
  );
}

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { myPosts, myProfile, draftProjects, refetchMyPosts, refetchProfile, following } = usePosts();
  const qc = useQueryClient();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("drops");
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Currently only self-profile; draft privacy is gated on this flag
  const isOwnProfile = true;

  // ── Followers count ──────────────────────────────────────────
  const { data: followersCount = 0 } = useQuery({
    queryKey: ["followers-count", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<number> => {
      if (!user?.id) return 0;
      const { count, error } = await supabase
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("followee_id", user.id);
      if (error) return 0;
      return count ?? 0;
    },
  });

  const followingCount = following.length;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    qc.invalidateQueries({ queryKey: ["profile"] });
    qc.invalidateQueries({ queryKey: ["posts", "mine"] });
    await Promise.all([refetchMyPosts(), refetchProfile()]);
    setRefreshing(false);
  }, [qc, refetchMyPosts, refetchProfile]);

  // Refetch on tab focus — ensures the avatar and profile data are fresh
  // when returning from edit-profile without needing a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      refetchMyPosts();
      refetchProfile();
    }, [refetchMyPosts, refetchProfile])
  );

  const displayName = useMemo(
    () =>
      myProfile?.display_name ??
      myProfile?.username ??
      "dropper",
    [myProfile],
  );
  const username = useMemo(
    () => myProfile?.username ?? "dropper",
    [myProfile],
  );

  const drops = useMemo(
    () => myPosts.filter((p) => !p.parent_post_id),
    [myPosts],
  );
  const activePosts = tab === "drops" ? drops : [];
  const isGridTab = tab === "drafts";

  const handleFollowersTap = useCallback(() => {
    if (!user?.id) return;
    router.push({
      pathname: "/follow-list",
      params: {
        userId: user.id,
        type: "followers",
        title: "Followers",
      },
    } as never);
  }, [router, user?.id]);

  const handleFollowingTap = useCallback(() => {
    if (!user?.id) return;
    router.push({
      pathname: "/follow-list",
      params: {
        userId: user.id,
        type: "following",
        title: "Following",
      },
    } as never);
  }, [router, user?.id]);

  const headerNode = (
    <ProfileHeader
      displayName={displayName}
      username={username}
      myProfile={myProfile}
      drops={drops}
      tab={tab}
      onTab={setTab}
      onEditProfile={() => router.push("/edit-profile")}
      onSignOut={signOut}
      isOwnProfile={isOwnProfile}
      followersCount={followersCount}
      followingCount={followingCount}
      onFollowersTap={handleFollowersTap}
      onFollowingTap={handleFollowingTap}
    />
  );

  const renderDraftItem = ({ item }: { item: DraftProject }) => (
    <DraftTile
      draft={item}
      onPress={() => {
        router.push({
          pathname: "/edit",
          params: { draftId: item.id },
        });
      }}
    />
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        {isGridTab ? (
          <FlatList
            data={draftProjects}
            keyExtractor={(d) => d.id}
            numColumns={2}
            columnWrapperStyle={
              draftProjects.length > 0 ? styles.row : undefined
            }
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
              <>
                {headerNode}
                {tab === "drafts" && draftProjects.length === 0 && (
                  <View style={styles.empty}>
                    <Save color={theme.textDim} size={40} strokeWidth={1.5} />
                    <UiText style={styles.emptyTitle}>No drafts</UiText>
                    <UiText style={styles.emptySub}>
                      Saved drafts will appear here. Record something and tap
                      "Save draft" to keep it.
                    </UiText>
                  </View>
                )}
              </>
            }
            renderItem={renderDraftItem}
          />
        ) : (
          <FlatList
            data={activePosts}
            keyExtractor={(p) => p.id}
            numColumns={2}
            columnWrapperStyle={
              activePosts.length > 0 ? styles.row : undefined
            }
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
              <>
                {headerNode}
                {activePosts.length === 0 && (
                  <View style={styles.empty}>
                    <Video
                      color={theme.textDim}
                      size={40}
                      strokeWidth={1.5}
                    />
                    <UiText style={styles.emptyTitle}>No drops yet</UiText>
                    <UiText style={styles.emptySub}>
                      Your drops from tonight will appear here.
                    </UiText>
                  </View>
                )}
              </>
            }
            renderItem={({ item }) => <ProfileTile post={item} />}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

function ProfileTile({ post }: { post: Post }) {
  const coverUri = post.thumbnail_url ?? post.media_url;
  return (
    <View style={styles.tile}>
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
        {post.parent_post_id && (
          <View style={styles.reactionTag}>
            <Sparkles color={theme.accent} size={9} />
            <UiText style={styles.reactionTagText}>Reaction</UiText>
          </View>
        )}
      </View>
    </View>
  );
}

function DraftTile({
  draft,
  onPress,
}: {
  draft: DraftProject;
  onPress: () => void;
}) {
  const firstClip = draft.clips[0];
  const durationMs = draft.clips.reduce((sum, c) => {
    if (c.type === "video") {
      const start = c.trimStartMs ?? 0;
      const end = c.trimEndMs ?? c.durationMs ?? 0;
      return sum + Math.max(0, end - start);
    }
    return sum + 3000;
  }, 0);

  const formatDuration = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const timeSince = (ts: number): string => {
    const diff = Date.now() - ts;
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return "Just now";
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const coverUri = draft.coverThumbnailUri ?? firstClip?.uri ?? "";
  return (
    <Pressable onPress={onPress} style={styles.tile}>
      <Image
        source={{ uri: coverUri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={100}
      />
      {/* Draft badge */}
      <View style={styles.draftBadge}>
        <Save color="#fff" size={10} />
        <UiText style={styles.draftBadgeText}>Draft</UiText>
      </View>
      {/* Clip count badge */}
      {draft.clips.length > 1 && (
        <View style={styles.videoBadge}>
          <UiText style={styles.videoBadgeText}>{draft.clips.length}</UiText>
        </View>
      )}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.7)"]}
        style={styles.tileGrad}
      />
      <View style={styles.tileBottom}>
        <View style={styles.tileStats}>
          <UiText style={styles.tileStatText}>
            {formatDuration(durationMs)}
          </UiText>
        </View>
        <UiText style={styles.tileStatText}>{timeSince(draft.updatedAt)}</UiText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  listContent: { paddingBottom: 120 },

  /* Header */
  header: { paddingHorizontal: 16, paddingTop: 12 },

  /* Profile row */
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 20,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "rgba(10,132,255,0.3)",
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "800" as const,
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  displayName: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  username: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  editProfileBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "rgba(10,132,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.25)",
    marginBottom: 16,
  },
  editProfileBtnText: {
    color: theme.accent,
    fontSize: 15,
    fontWeight: "700" as const,
  },
  signOutBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  /* Bio */
  bio: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "500" as const,
    lineHeight: 20,
    marginBottom: 14,
  },

  /* Links row */
  linksRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  linkPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  linkText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "600" as const,
    maxWidth: 150,
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

  /* Tab switcher */
  tabRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  tabActive: {
    backgroundColor: "rgba(10,132,255,0.1)",
    borderColor: "rgba(10,132,255,0.25)",
  },
  tabLabel: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "700" as const,
  },
  tabLabelActive: {
    color: theme.accent,
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
  videoBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800" as const,
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
  reactionTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(10,132,255,0.15)",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  reactionTagText: {
    color: theme.accent,
    fontSize: 9,
    fontWeight: "700" as const,
    letterSpacing: 0.3,
  },

  /* Draft tile */
  draftBadge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 5,
    backgroundColor: "rgba(139,92,246,0.85)",
  },
  draftBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 0.6,
  },
});
