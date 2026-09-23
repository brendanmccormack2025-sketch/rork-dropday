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
import { Image as ExpoImage } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Archive,
  Bell,
  Heart,
  Send,
  Trophy,
  UserPlus,
  UserCheck,
  Users,
  Zap,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { usePosts } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import {
  useNotifications,
  type NotificationRow,
} from "@/providers/NotificationsProvider";
import { supabase } from "@/lib/supabase";

type SuggestedUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

const SHARE_MESSAGE =
  "Join me on Trial — share one post a night. It's addictive. 🚀";
const SHARE_URL = "https://dropday.app";

/** Resolve a post thumbnail_url (storage path or full URL) into a displayable URI. */
function resolveThumbUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length === 0) return null;
  if (raw.startsWith("http")) return raw;
  // Storage path — build public URL via Supabase
  const { data } = supabase.storage.from("drops").getPublicUrl(raw);
  return data?.publicUrl ?? null;
}

/** Format a relative time string like "2h", "5m", "3d" */
function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

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

    // Notification row
    if (index < notifCount) {
      const notif = item as NotificationRow;
      const actorName = notif.actor?.display_name ?? notif.actor?.username ?? "Someone";
      const actorInitial = actorName.charAt(0).toUpperCase();
      const actorProfile = {
        avatar_url: notif.actor?.avatar_url ?? null,
      };
      const thumbUri = resolveThumbUrl(notif.post?.thumbnail_url ?? null);
      const isVerdict =
        notif.type === "verdict_survived" || notif.type === "verdict_archived";

      let icon = <Bell color={theme.textMuted} size={15} strokeWidth={2} />;
      let actionText = "";
      if (notif.type === "like") {
        icon = <Heart color="#E8291C" size={15} strokeWidth={2} fill="#E8291C" />;
        actionText = "liked your post";
      } else if (notif.type === "reaction") {
        icon = <Zap color={theme.accent} size={15} strokeWidth={2} fill={theme.accent} />;
        actionText = "reacted to your post";
      } else if (notif.type === "follow") {
        icon = <UserPlus color={theme.success} size={15} strokeWidth={2} />;
        actionText = "started following you";
      } else if (notif.type === "verdict_survived") {
        icon = <Trophy color={theme.success} size={15} strokeWidth={2} />;
        actionText = "Your post survived Trial 🏆";
      } else if (notif.type === "verdict_archived") {
        icon = <Archive color={theme.textDim} size={15} strokeWidth={2} />;
        actionText = "Your post didn't survive Trial";
      }

      return (
        <Pressable
          onPress={() => handleNotifTap(notif)}
          style={({ pressed }) => [
            styles.notifRow,
            pressed && styles.notifRowPressed,
          ]}
        >
          {/* Unread dot */}
          <View style={styles.notifLeft}>
            {!notif.read && <View style={styles.unreadDot} />}
          </View>

          {/* Actor avatar */}
          <View style={styles.notifAvatarWrap}>
            <FeedAvatar profile={actorProfile} name={actorName} />
            <View style={styles.notifTypeIcon}>{icon}</View>
          </View>

          {/* Text */}
          <View style={styles.notifTextWrap}>
            <UiText style={styles.notifText} numberOfLines={2}>
              {/* Verdict notifications are system verdicts, not another
                  user's action — render without the actor-name prefix */}
              {isVerdict ? (
                <UiText style={styles.notifAction}>{actionText}</UiText>
              ) : (
                <>
                  <UiText style={styles.notifActorName}>{actorName}</UiText>
                  {" "}
                  <UiText style={styles.notifAction}>{actionText}</UiText>
                </>
              )}
            </UiText>
            <UiText style={styles.notifTime}>{formatRelativeTime(notif.created_at)}</UiText>
          </View>

          {/* Post thumbnail for like/reaction */}
          {thumbUri && notif.type !== "follow" && (
            <View style={styles.notifThumbWrap}>
              <ExpoImage
                source={{ uri: thumbUri }}
                style={styles.notifThumb}
                contentFit="cover"
                transition={100}
                cachePolicy="memory"
              />
            </View>
          )}
        </Pressable>
      );
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

  /* Notification rows */
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  notifRowPressed: {
    backgroundColor: "rgba(10,10,10,0.05)",
  },
  notifLeft: {
    width: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 0,
    backgroundColor: theme.accent,
  },
  notifAvatarWrap: {
    position: "relative",
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  notifTypeIcon: {
    position: "absolute",
    bottom: -2,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 0,
    backgroundColor: theme.bgElevated,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: theme.bg,
  },
  notifTextWrap: {
    flex: 1,
    gap: 2,
  },
  notifText: {
    color: theme.text,
    fontSize: 14,
    lineHeight: 19,
  },
  notifActorName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "900" as const,
  },
  notifAction: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "500" as const,
  },
  notifTime: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "600" as const,
  },
  notifThumbWrap: {
    width: 44,
    height: 44,
    borderRadius: 0,
    overflow: "hidden",
    backgroundColor: theme.card,
  },
  notifThumb: {
    width: "100%",
    height: "100%",
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
