import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Pencil, Save, Settings, Trophy, Video } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { SIDE_MARGIN, colors, space, type } from "@/constants/design";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, type DraftProject, type MyProfile, type Post } from "@/providers/PostsProvider";
import VerifiedCreatorBadge from "@/components/VerifiedCreatorBadge";
import {
  DraftTileView,
  LinkIconRow,
  PostTile,
  ProfileEmpty,
  ProfileTabs,
  RoundAvatar,
  RoundIconButton,
  SoftButton,
  gridStyles,
} from "@/components/profile/ProfileParts";
import { linkSourceFor, showsVerifiedBadge } from "@/lib/creatorStatus";
import { isOnOwnProfilePost } from "@/lib/profileVisibility";
import { EMPTY_OWN_SURVIVED_BODY, EMPTY_OWN_SURVIVED_TITLE, GRID_COLUMNS, OWN_TABS, initialOwnTab, postsForTab, type OwnTab } from "@/lib/profileUi";

type Item = { kind: "post"; post: Post } | { kind: "draft"; draft: DraftProject };

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function draftLabel(draft: DraftProject): string {
  const ms = draft.clips.reduce((sum, c) => {
    if (c.type === "video") return sum + Math.max(0, (c.trimEndMs ?? c.durationMs ?? 0) - (c.trimStartMs ?? 0));
    return sum + 3000;
  }, 0);
  return formatDuration(ms);
}

export default function ProfileScreen() {
  const { user } = useAuth();
  const { myPosts, myProfile, draftProjects, refetchMyPosts, refetchProfile } = usePosts();
  const qc = useQueryClient();
  const router = useRouter();
  const [tab, setTab] = useState<OwnTab>("survived");
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    qc.invalidateQueries({ queryKey: ["profile"] });
    qc.invalidateQueries({ queryKey: ["posts", "mine"] });
    await Promise.all([refetchMyPosts(), refetchProfile()]);
    setRefreshing(false);
  }, [qc, refetchMyPosts, refetchProfile]);

  // Refetch on tab focus: the avatar and profile data are fresh when returning from edit-profile.
  useFocusEffect(
    useCallback(() => {
      refetchMyPosts();
      refetchProfile();
    }, [refetchMyPosts, refetchProfile]),
  );

  const displayName = myProfile?.display_name ?? myProfile?.username ?? "dropper";
  const username = myProfile?.username ?? "dropper";

  // What the creator may see of their own posts: survived (forever), testing and queued. Nothing else exists for anyone.
  const own = useMemo(() => myPosts.filter((p) => !p.parent_post_id && isOnOwnProfilePost(p)), [myPosts]);

  // Open on Survived, unless nothing survived yet and something is on trial (once, when the posts first arrive).
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || own.length === 0) return;
    picked.current = true;
    setTab(initialOwnTab(own));
  }, [own]);

  const tabPosts = useMemo(() => postsForTab(own, tab), [own, tab]);
  const items: Item[] = useMemo(
    () => (tab === "drafts" ? draftProjects.map((draft) => ({ kind: "draft" as const, draft })) : tabPosts.map((post) => ({ kind: "post" as const, post }))),
    [tab, tabPosts, draftProjects],
  );

  const openPost = (index: number) => {
    if (!user?.id) return;
    router.push({ pathname: "/profile-drops", params: { userId: user.id, initialIndex: String(index), tab } } as never);
  };

  const header = (
    <ProfileHeader
      displayName={displayName}
      username={username}
      profile={myProfile}
      onEdit={() => router.push("/edit-profile")}
      onSettings={() => router.push("/settings")}
      tab={tab}
      onTab={setTab}
    />
  );

  const empty =
    tab === "drafts" ? (
      <ProfileEmpty icon={<Save color={colors.textTertiary} size={36} strokeWidth={1.6} />} title="No drafts" body='Record something and tap "Save draft" to keep it.' />
    ) : tab === "survived" ? (
      <ProfileEmpty
        icon={<Trophy color={colors.textTertiary} size={36} strokeWidth={1.6} />}
        title={EMPTY_OWN_SURVIVED_TITLE}
        body={EMPTY_OWN_SURVIVED_BODY}
        actionLabel="Put it on Trial"
        onAction={() => router.push("/camera")}
      />
    ) : (
      <ProfileEmpty
        icon={<Video color={colors.textTertiary} size={36} strokeWidth={1.6} />}
        title="Nothing on Trial right now"
        body="Put something on Trial."
        actionLabel="Put it on Trial"
        onAction={() => router.push("/camera")}
      />
    );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <FlatList
          data={items}
          key={`grid-${GRID_COLUMNS}`}
          numColumns={GRID_COLUMNS}
          keyExtractor={(it) => (it.kind === "post" ? it.post.id : it.draft.id)}
          columnWrapperStyle={items.length > 0 ? gridStyles.row : undefined}
          contentContainerStyle={gridStyles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} progressBackgroundColor={theme.card} />}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          renderItem={({ item, index }) =>
            item.kind === "post" ? (
              <PostTile post={item.post} queued={item.post.status === "queued"} onPress={() => openPost(index)} />
            ) : (
              <DraftTileView
                cover={item.draft.coverThumbnailUri ?? item.draft.clips[0]?.uri ?? ""}
                label={draftLabel(item.draft)}
                onPress={() => router.push({ pathname: "/edit", params: { draftId: item.draft.id } })}
              />
            )
          }
        />
      </SafeAreaView>
    </View>
  );
}

function ProfileHeader({
  displayName,
  username,
  profile,
  onEdit,
  onSettings,
  tab,
  onTab,
}: {
  displayName: string;
  username: string;
  profile: MyProfile | null;
  onEdit: () => void;
  onSettings: () => void;
  tab: OwnTab;
  onTab: (t: OwnTab) => void;
}) {
  return (
    <View>
      <View style={styles.topBar}>
        <RoundIconButton label="Settings" onPress={onSettings}>
          <Settings color={colors.text} size={18} strokeWidth={2} />
        </RoundIconButton>
      </View>
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
        <View style={styles.editWrap}>
          <SoftButton label="Edit profile" onPress={onEdit} icon={<Pencil color={colors.text} size={15} strokeWidth={2.2} />} />
        </View>
      </View>
      <ProfileTabs tabs={OWN_TABS} active={tab} onChange={onTab} />
      <View style={{ height: space.sm }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  safe: { flex: 1 },
  topBar: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: SIDE_MARGIN, paddingTop: space.sm },
  identity: { alignItems: "center", paddingHorizontal: SIDE_MARGIN, paddingTop: space.xs },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md, maxWidth: "100%" },
  name: { color: colors.text, ...type.name, flexShrink: 1 },
  handle: { color: colors.textSecondary, ...type.handle, marginTop: 2 },
  bio: { color: colors.text, ...type.body, textAlign: "center", marginTop: space.md, maxWidth: 320 },
  editWrap: { marginTop: space.lg },
});
