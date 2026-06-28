import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Send, Users, UserPlus, UserCheck, MessageCircle } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { usePosts } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";

type SuggestedUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

const SHARE_MESSAGE =
  "Join me on DropDay — share one drop a night. It's addictive. 🚀";

const SHARE_URL = "https://dropday.app";

export default function FriendsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    suggestedUsers,
    suggestedLoading,
    followUser,
    unfollowUser,
    following,
    refetchSuggested,
    unreadCount,
  } = usePosts();
  const [followPending, setFollowPending] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchSuggested();
    setRefreshing(false);
  }, [refetchSuggested]);

  const handleInvite = useCallback(async () => {
    try {
      await Share.share({
        message: `${SHARE_MESSAGE}\n${SHARE_URL}`,
      });
    } catch {
      // user cancelled
    }
  }, []);

  const handleToggleFollow = useCallback(
    async (targetId: string, currentlyFollowing: boolean) => {
      setFollowPending((prev) => {
        const next = new Set(prev);
        next.add(targetId);
        return next;
      });
      try {
        if (currentlyFollowing) {
          await unfollowUser.mutateAsync(targetId);
        } else {
          await followUser.mutateAsync(targetId);
        }
      } catch (e) {
        console.warn("[friends] toggle follow error", (e as Error)?.message ?? e);
      } finally {
        setFollowPending((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    },
    [followUser, unfollowUser],
  );

  const followingSet = new Set(following);

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <FlatList
          data={suggestedUsers}
          keyExtractor={(u) => u.id}
          contentContainerStyle={styles.list}
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
              {/* Title */}
              <UiText style={styles.screenTitle}>Friends</UiText>
              <UiText style={styles.screenSub}>
                Grow your circle. More friends = better feed.
              </UiText>

              {/* DM inbox quick access */}
              <Pressable
                onPress={() => router.push("/dm/inbox" as never)}
                style={({ pressed }) => [
                  styles.dmInbox,
                  pressed && styles.dmInboxPressed,
                ]}
              >
                <View style={styles.dmInboxLeft}>
                  <View style={styles.dmIconWrap}>
                    <MessageCircle color={theme.accent} size={20} strokeWidth={2} />
                    {unreadCount > 0 && (
                      <View style={styles.dmBadge}>
                        <UiText style={styles.dmBadgeText}>
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </UiText>
                      </View>
                    )}
                  </View>
                  <View style={styles.dmTextWrap}>
                    <UiText style={styles.dmTitle}>Messages</UiText>
                    <UiText style={styles.dmSub}>
                      {unreadCount > 0
                        ? `${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`
                        : "No new messages"}
                    </UiText>
                  </View>
                </View>
                <MessageCircle color={theme.textMuted} size={16} strokeWidth={2} />
              </Pressable>

              {/* Invite block */}
              <View style={styles.inviteBlock}>
                <View style={styles.inviteIconWrap}>
                  <Send color={theme.accent} size={22} strokeWidth={2} />
                </View>
                <View style={styles.inviteTextWrap}>
                  <UiText style={styles.inviteTitle}>Invite Friends</UiText>
                  <UiText style={styles.inviteSub}>
                    Send your friends a link to join DropDay.
                  </UiText>
                </View>
                <Pressable
                  onPress={handleInvite}
                  style={({ pressed }) => [
                    styles.inviteBtn,
                    pressed && styles.inviteBtnPressed,
                  ]}
                >
                  <Send color="#fff" size={16} strokeWidth={2.5} />
                  <UiText style={styles.inviteBtnText}>Send Invite Link</UiText>
                </Pressable>
              </View>

              {/* Suggested section header */}
              <View style={styles.sectionHeader}>
                <View style={styles.sectionBadge}>
                  <Users color={theme.accent} size={13} strokeWidth={2} />
                </View>
                <UiText style={styles.sectionLabel}>Suggested People</UiText>
              </View>

              {/* Loading */}
              {suggestedLoading && (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={theme.accent} size="small" />
                </View>
              )}

              {/* Empty suggested */}
              {!suggestedLoading && suggestedUsers.length === 0 && (
                <View style={styles.empty}>
                  <Users color={theme.textDim} size={28} strokeWidth={1.5} />
                  <UiText style={styles.emptyText}>
                    No suggestions right now. Invite friends to grow your circle.
                  </UiText>
                </View>
              )}
            </View>
          }
          renderItem={({ item }) => {
            const isFollowing = followingSet.has(item.id);
            const pending = followPending.has(item.id);
            const displayName = item.display_name ?? item.username;
            const initial = displayName.charAt(0).toUpperCase();

            return (
              <Pressable
                onPress={() => {
                  if (item.id === user?.id) {
                    router.push("/(tabs)/profile" as never);
                  } else {
                    router.push(`/user/${item.id}` as never);
                  }
                }}
                style={({ pressed }) => [
                  styles.userRow,
                  pressed && styles.userRowPressed,
                ]}
              >
                <View style={styles.avatar}>
                  <FeedAvatar
                    profile={item}
                    name={displayName}
                  />
                </View>
                <View style={styles.userInfo}>
                  <UiText style={styles.userName} numberOfLines={1}>
                    {displayName}
                  </UiText>
                  <UiText style={styles.userHandle} numberOfLines={1}>
                    @{item.username}
                  </UiText>
                </View>
                <Pressable
                  onPress={() => handleToggleFollow(item.id, isFollowing)}
                  disabled={pending}
                  style={({ pressed }) => [
                    styles.followBtn,
                    isFollowing && styles.followBtnActive,
                    pressed && !isFollowing && styles.followBtnPressed,
                    pressed && isFollowing && styles.followBtnActivePressed,
                  ]}
                >
                  {pending ? (
                    <ActivityIndicator color={isFollowing ? theme.textMuted : "#fff"} size="small" />
                  ) : isFollowing ? (
                    <>
                      <UserCheck color={theme.textMuted} size={14} strokeWidth={2.5} />
                      <UiText style={styles.followBtnTextActive}>Following</UiText>
                    </>
                  ) : (
                    <>
                      <UserPlus color="#fff" size={14} strokeWidth={2.5} />
                      <UiText style={styles.followBtnText}>Follow</UiText>
                    </>
                  )}
                </Pressable>
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  list: { paddingBottom: 120 },
  header: { paddingHorizontal: 16, paddingTop: 8 },

  /* Title */
  screenTitle: {
    color: theme.text,
    fontSize: 26,
    fontWeight: "800" as const,
    letterSpacing: -0.4,
  },
  screenSub: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
    marginTop: 4,
    marginBottom: 20,
  },

  /* DM inbox quick access */
  dmInbox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(10,132,255,0.06)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.12)",
    padding: 16,
    marginBottom: 16,
  },
  dmInboxPressed: {
    backgroundColor: "rgba(10,132,255,0.1)",
  },
  dmInboxLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  dmIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(10,132,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.2)",
  },
  dmBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  dmBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
  },
  dmTextWrap: {
    gap: 2,
  },
  dmTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700" as const,
    letterSpacing: -0.2,
  },
  dmSub: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "500" as const,
  },

  /* Invite block */
  inviteBlock: {
    backgroundColor: "rgba(10,132,255,0.08)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.18)",
    padding: 18,
    gap: 14,
    marginBottom: 24,
  },
  inviteIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(10,132,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.25)",
  },
  inviteTextWrap: {
    gap: 3,
  },
  inviteTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800" as const,
    letterSpacing: -0.2,
  },
  inviteSub: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  inviteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.accent,
    paddingVertical: 13,
    borderRadius: 12,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  inviteBtnPressed: {
    backgroundColor: theme.primaryDeep,
    transform: [{ scale: 0.97 }],
  },
  inviteBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },

  /* Section header */
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  sectionBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "rgba(10,132,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
    letterSpacing: -0.1,
  },

  /* Loading */
  loadingWrap: {
    paddingVertical: 28,
    alignItems: "center",
  },

  /* Empty */
  empty: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },

  /* User rows */
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 2,
  },
  userRowPressed: {
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(10,132,255,0.2)",
  },
  avatarText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800" as const,
  },
  userInfo: {
    flex: 1,
    gap: 2,
  },
  userName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
  },
  userHandle: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "500" as const,
  },
  followBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  followBtnPressed: {
    backgroundColor: theme.primaryDeep,
    transform: [{ scale: 0.96 }],
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
    fontSize: 13,
    fontWeight: "700" as const,
  },
  followBtnTextActive: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
});
