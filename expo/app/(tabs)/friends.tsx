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
import { useFocusEffect, useRouter } from "expo-router";
import {
  Bell,
  Send,
  UserPlus,
  UserCheck,
  Users,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import NotificationItem from "@/components/NotificationItem";
import { usePosts } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import {
  useNotifications,
  type NotificationRow,
} from "@/providers/NotificationsProvider";

type SuggestedUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

const SHARE_MESSAGE =
  "Join me on Trial — share one post a night. It's addictive. 🚀";
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
  } = usePosts();
  const {
    notifications,
    unreadCount,
    isLoading: notifsLoading,
    refetch: refetchNotifs,
    markAllRead,
  } = useNotifications();

  const [followPending, setFollowPending] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Mark all notifications as read when this screen is focused
  useFocusEffect(
    useCallback(() => {
      if (unreadCount > 0) {
        // Small delay so the unread badge is visible briefly before clearing
        const timer = setTimeout(() => markAllRead(), 1200);
        return () => clearTimeout(timer);
      }
    }, [unreadCount, markAllRead]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchSuggested(), refetchNotifs()]);
    setRefreshing(false);
  }, [refetchSuggested, refetchNotifs]);

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

  const handleNotifTap = useCallback(
    (notif: NotificationRow) => {
      if (notif.type === "follow") {
        if (notif.actor_id) {
          router.push(`/user/${notif.actor_id}` as never);
        }
      } else {
        // like / reaction → navigate to the post
        if (notif.post_id) {
          router.push(`/post/${notif.post_id}/reaction-tree` as never);
        }
      }
    },
    [router],
  );

  const followingSet = new Set(following);

  // ── FlatList data: notifications + suggested people as a single scroll ──
  // We render everything in one FlatList for smooth scrolling.
  // Sections are: [0..N-1] = notifications, [N..] = suggested users
  const notifCount = notifications.length;
  const flatData: (NotificationRow | SuggestedUser | "SECTION_SUGGESTED")[] = [
    ...notifications,
    ...(suggestedUsers.length > 0 || suggestedLoading
      ? (["SECTION_SUGGESTED"] as const)
      : []),
    ...suggestedUsers,
  ];

  const renderItem = ({ item, index }: { item: (typeof flatData)[number]; index: number }) => {
    // Section divider for suggested people
    if (item === "SECTION_SUGGESTED") {
      return (
        <View style={styles.sectionHeader}>
          <View style={styles.sectionBadge}>
            <Users color={theme.accent} size={13} strokeWidth={2} />
          </View>
          <UiText style={styles.sectionLabel}>Suggested People</UiText>
        </View>
      );
    }

    // Notification row (shared component; follower types render nothing)
    if (index < notifCount) {
      return <NotificationItem notif={item as NotificationRow} onPress={handleNotifTap} />;
    }

    // Suggested user row
    const suggestedUser = item as SuggestedUser;
    const isFollowing = followingSet.has(suggestedUser.id);
    const pending = followPending.has(suggestedUser.id);
    const displayName = suggestedUser.display_name ?? suggestedUser.username;

    return (
      <Pressable
        onPress={() => {
          if (suggestedUser.id === user?.id) {
            router.push("/(tabs)/profile" as never);
          } else {
            router.push(`/user/${suggestedUser.id}` as never);
          }
        }}
        style={({ pressed }) => [
          styles.userRow,
          pressed && styles.userRowPressed,
        ]}
      >
        <View style={styles.avatar}>
          <FeedAvatar profile={suggestedUser} name={displayName} />
        </View>
        <View style={styles.userInfo}>
          <UiText style={styles.userName} numberOfLines={1}>
            {displayName}
          </UiText>
          <UiText style={styles.userHandle} numberOfLines={1}>
            @{suggestedUser.username}
          </UiText>
        </View>
        <Pressable
          onPress={() => handleToggleFollow(suggestedUser.id, isFollowing)}
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
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <FlatList
          data={flatData}
          keyExtractor={(item, index) => {
            if (item === "SECTION_SUGGESTED") return "section-suggested";
            if (index < notifCount) return (item as NotificationRow).id;
            return (item as SuggestedUser).id;
          }}
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
              <View style={styles.titleRow}>
                <UiText style={styles.screenTitle}>Friends</UiText>
                {unreadCount > 0 && (
                  <View style={styles.headerBadge}>
                    <UiText style={styles.headerBadgeText}>
                      {unreadCount > 9 ? "9+" : String(unreadCount)}
                    </UiText>
                  </View>
                )}
              </View>

              {/* Compact invite banner */}
              <Pressable
                onPress={handleInvite}
                style={({ pressed }) => [
                  styles.inviteBanner,
                  pressed && styles.inviteBannerPressed,
                ]}
              >
                <View style={styles.inviteBannerIcon}>
                  <Send color={theme.accent} size={16} strokeWidth={2.5} />
                </View>
                <UiText style={styles.inviteBannerText}>Invite Friends</UiText>
                <View style={styles.inviteArrow}>
                  <UiText style={styles.inviteArrowText}>›</UiText>
                </View>
              </Pressable>

              {/* Notifications section header */}
              <View style={styles.sectionHeader}>
                <View style={styles.sectionBadge}>
                  <Bell color={theme.accent} size={13} strokeWidth={2} />
                </View>
                <UiText style={styles.sectionLabel}>Notifications</UiText>
              </View>

              {/* Notifications loading */}
              {notifsLoading && (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={theme.accent} size="small" />
                </View>
              )}

              {/* Notifications empty */}
              {!notifsLoading && notifications.length === 0 && (
                <View style={styles.empty}>
                  <Bell color={theme.textDim} size={28} strokeWidth={1.5} />
                  <UiText style={styles.emptyText}>
                    No notifications yet. When someone likes your post or follows you, it'll show up here.
                  </UiText>
                </View>
              )}

              {/* Suggested loading (if no suggested users yet) */}
              {suggestedLoading && suggestedUsers.length === 0 && !notifsLoading && (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator color={theme.accent} size="small" />
                </View>
              )}

              {/* Suggested empty */}
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
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
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
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  screenTitle: {
    color: theme.text,
    fontSize: 26,
    fontWeight: "900" as const,
    letterSpacing: -0.4,
  },
  headerBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 0,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  headerBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "900" as const,
  },

  /* Compact invite banner */
  inviteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(232,41,28,0.08)",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.15)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 16,
    marginBottom: 20,
  },
  inviteBannerPressed: {
    backgroundColor: "rgba(232,41,28,0.12)",
    transform: [{ scale: 0.99 }],
  },
  inviteBannerIcon: {
    width: 32,
    height: 32,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  inviteBannerText: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
    letterSpacing: -0.1,
  },
  inviteArrow: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  inviteArrowText: {
    color: theme.textMuted,
    fontSize: 22,
    fontWeight: "700" as const,
    lineHeight: 24,
  },

  /* Section header */
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    marginTop: 4,
  },
  sectionBadge: {
    width: 28,
    height: 28,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
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

  /* Separator */
  separator: {
    height: 1,
    backgroundColor: "rgba(10,10,10,0.05)",
    marginHorizontal: 16,
  },

  /* User rows (suggested people) */
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  userRowPressed: {
    backgroundColor: "rgba(10,10,10,0.05)",
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  userInfo: {
    flex: 1,
    gap: 2,
  },
  userName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
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
    borderRadius: 0,
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
    fontSize: 13,
    fontWeight: "700" as const,
  },
  followBtnTextActive: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
});
