import React, { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { AlertCircle, Check, Plus, UsersRound, X } from "lucide-react-native";

import DropletLogo from "@/components/DropletLogo";
import { FeedListView } from "@/components/FeedListView";
import { theme } from "@/constants/theme";
import { usePosts } from "@/providers/PostsProvider";
import { useGroups, type GroupInvite } from "@/providers/GroupsProvider";

/**
 * Groups tab — vertical swipe feed of group videos from ALL groups,
 * ranked by likes then recency. Pending group invites surface as
 * banners above the feed; each video links to its group page.
 */
export default function TrybeScreen() {
  const router = useRouter();
  const {
    trybeFeed,
    trybeFeedLoading,
    refetchTrybeFeed,
  } = usePosts();
  const { myInvites, myGroups, respondToInvite } = useGroups();

  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [pendingInviteId, setPendingInviteId] = useState<string | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchTrybeFeed()]);
    setRefreshing(false);
  }, [refetchTrybeFeed]);

  const acceptedGroup = useMemo(() => myGroups[0] ?? null, [myGroups]);

  const handleAccept = useCallback(
    (invite: GroupInvite) => {
      // One accepted group per user — confirm the swap when already in a group
      if (acceptedGroup) {
        Alert.alert(
          "Leave your current group?",
          `You are already in ${acceptedGroup.name}. Would you like to leave to join ${invite.name}?`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Switch Groups",
              onPress: () => respondToInvite.mutate({ groupId: invite.group_id, accept: true }),
            },
          ],
        );
        return;
      }
      respondToInvite.mutate({ groupId: invite.group_id, accept: true });
    },
    [acceptedGroup, respondToInvite],
  );

  const handleDecline = useCallback(
    (invite: GroupInvite) => {
      respondToInvite.mutate({ groupId: invite.group_id, accept: false });
    },
    [respondToInvite],
  );

  const renderInviteBanner = useCallback(
    (invite: GroupInvite) => {
      const busy = pendingInviteId === invite.group_id;
      return (
        <View style={styles.inviteBanner} pointerEvents="auto" key={invite.group_id}>
          <View style={styles.inviteIcon}>
            <UsersRound color={theme.accent} size={16} strokeWidth={2.2} />
          </View>
          <View style={styles.inviteInfo}>
            <UiText style={styles.inviteTitle} numberOfLines={1}>
              Invited to {invite.name}
            </UiText>
            <UiText style={styles.inviteSub}>
              {acceptedGroup
                ? `Accepting switches you out of ${acceptedGroup.name}`
                : "You've been invited to join this group"}
            </UiText>
          </View>
          <Pressable
            onPress={() => {
              setPendingInviteId(invite.group_id);
              handleAccept(invite);
              setTimeout(() => setPendingInviteId(null), 1500);
            }}
            disabled={busy}
            style={({ pressed }) => [
              styles.inviteAcceptBtn,
              pressed && !busy && styles.inviteBtnPressed,
            ]}
          >
            <Check color="#fff" size={14} strokeWidth={3} />
          </Pressable>
          <Pressable
            onPress={() => handleDecline(invite)}
            disabled={busy}
            style={({ pressed }) => [
              styles.inviteDeclineBtn,
              pressed && !busy && styles.inviteBtnPressed,
            ]}
          >
            <X color={theme.textMuted} size={14} strokeWidth={3} />
          </Pressable>
        </View>
      );
    },
    [handleAccept, handleDecline, pendingInviteId, acceptedGroup],
  );

  return (
    <View style={styles.root}>
      <FeedListView
        posts={trybeFeed}
        isLoading={trybeFeedLoading}
        onRefresh={onRefresh}
        isRefreshing={refreshing}
        initialIndex={0}
        onSharePost={(post) => {
          router.push(`/post/${post.id}/reaction-tree` as never);
        }}
        onReactionsPost={(post) => {
          router.push(`/post/${post.id}/reaction-tree` as never);
        }}
        headerComponent={
          <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.headerWrap}>
            <View style={styles.headerRow} pointerEvents="box-none">
              <View style={styles.brandRow}>
                <DropletLogo size={22} />
                <UiText style={styles.brand}>Groups</UiText>
              </View>
              <Pressable
                onPress={() => router.push("/group/new" as never)}
                style={({ pressed }) => [
                  styles.newGroupBtn,
                  pressed && styles.newGroupBtnPressed,
                ]}
                pointerEvents="auto"
              >
                <Plus color={theme.accent} size={16} strokeWidth={2.5} />
                <UiText style={styles.newGroupText}>Group</UiText>
              </Pressable>
            </View>
            {myInvites.length > 0 && (
              <View style={styles.inviteStack} pointerEvents="box-none">
                {myInvites.slice(0, 2).map(renderInviteBanner)}
              </View>
            )}
          </SafeAreaView>
        }
        emptyComponent={<TrybeEmptyState />}
      />
    </View>
  );
}

function TrybeEmptyState() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.emptyWrap}>
      <AlertCircle color={theme.textMuted} size={44} strokeWidth={1.5} />
      <UiText style={styles.emptyTitle}>No group videos yet</UiText>
      <UiText style={styles.emptySub}>
        Create a group with up to 10 people and post videos from your camera roll —
        the most-liked ones rise to the top.
      </UiText>
      <Pressable
        onPress={() => router.push("/group/new" as never)}
        style={({ pressed }) => [styles.emptyBtn, pressed && styles.emptyBtnPressed]}
      >
        <Plus color="#fff" size={16} />
        <UiText style={styles.emptyBtnText}>Create a group</UiText>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  /* Header overlay */
  headerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  newGroupBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  newGroupBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  newGroupText: {
    color: theme.text,
    fontSize: 12,
    fontWeight: "700" as const,
  },

  /* Invite banners */
  inviteStack: {
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  inviteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(15,15,20,0.85)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.35)",
  },
  inviteIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(10,132,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  inviteInfo: {
    flex: 1,
    gap: 1,
  },
  inviteTitle: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700" as const,
  },
  inviteSub: {
    color: theme.textMuted,
    fontSize: 11,
  },
  inviteAcceptBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  inviteDeclineBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  inviteBtnPressed: {
    transform: [{ scale: 0.92 }],
  },

  /* Empty state */
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
    lineHeight: 19,
  },
  emptyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
  emptyBtnPressed: {
    transform: [{ scale: 0.97 }],
  },
  emptyBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },
});
