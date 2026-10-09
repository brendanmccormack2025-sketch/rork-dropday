import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Archive, Bell, Heart, Trophy, Zap } from "lucide-react-native";

import UiText from "@/components/UiText";
import { FeedAvatar } from "@/components/Avatar";
import { theme } from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import { TRIAL_INCOMPLETE_NOTIFICATION } from "@/lib/trialEngine";
import type { NotificationRow } from "@/providers/NotificationsProvider";

/**
 * One notification row (moved out of friends.tsx unchanged apart from the
 * follower types). Only these types are shown; follower types (follow,
 * follow_request, follow_accept, followed_post_survived) and anything unknown
 * render nothing.
 */
const DISPLAYED_TYPES: string[] = ["like", "reaction", "verdict_survived", "verdict_archived", "verdict_incomplete"];

export function isDisplayedNotification(notif: { type: string }): boolean {
  return DISPLAYED_TYPES.includes(notif.type);
}

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

export default function NotificationItem({
  notif,
  onPress,
}: {
  notif: NotificationRow;
  onPress: (notif: NotificationRow) => void;
}) {
  if (!isDisplayedNotification(notif)) return null;

  const actorName = notif.actor?.display_name ?? notif.actor?.username ?? "Someone";
  const actorProfile = {
    avatar_url: notif.actor?.avatar_url ?? null,
  };
  const thumbUri = resolveThumbUrl(notif.post?.thumbnail_url ?? null);
  const isVerdict =
    notif.type === "verdict_survived" || notif.type === "verdict_archived" || notif.type === "verdict_incomplete";

  let icon = <Bell color={theme.textMuted} size={15} strokeWidth={2} />;
  let actionText = "";
  if (notif.type === "like") {
    icon = <Heart color="#E8291C" size={15} strokeWidth={2} fill="#E8291C" />;
    // Like-collapse: one row per post; N = other likers beyond the displayed actor
    const others = notif.extra_count ?? 0;
    actionText =
      others > 0
        ? `and ${others} ${others === 1 ? "other" : "others"} liked your post`
        : "liked your post";
  } else if (notif.type === "reaction") {
    icon = <Zap color={theme.accent} size={15} strokeWidth={2} fill={theme.accent} />;
    actionText = "reacted to your post";
  } else if (notif.type === "verdict_survived") {
    icon = <Trophy color={theme.success} size={15} strokeWidth={2} />;
    actionText = "Your post survived Trial 🏆";
  } else if (notif.type === "verdict_archived") {
    icon = <Archive color={theme.textDim} size={15} strokeWidth={2} />;
    actionText = "Your trial ended. Your post didn't earn enough engagement to survive. Try again!";
  } else if (notif.type === "verdict_incomplete") {
    icon = <Archive color={theme.textDim} size={15} strokeWidth={2} />;
    actionText = TRIAL_INCOMPLETE_NOTIFICATION;
  }

  return (
    <Pressable
      onPress={() => onPress(notif)}
      style={({ pressed }) => [styles.notifRow, pressed && styles.notifRowPressed]}
    >
      {/* Unread dot */}
      <View style={styles.notifLeft}>{!notif.read && <View style={styles.unreadDot} />}</View>

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

      {/* Post thumbnail */}
      {thumbUri && (
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

const styles = StyleSheet.create({
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
});
