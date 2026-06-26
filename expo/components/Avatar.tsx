import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { Image } from "expo-image";

import { resolveAvatarUrl } from "@/providers/PostsProvider";

/**
 * Avatar for feed items (posts, reactions).
 * Uses resolveAvatarUrl to handle storage paths and full URLs.
 * Falls back to the first letter of `name` when no avatar_url exists.
 */
export function FeedAvatar({
  profile,
  name,
}: {
  profile: { avatar_url?: string | null } | null | undefined;
  name: string;
}) {
  const avatarUri = useMemo(
    () => resolveAvatarUrl(profile?.avatar_url ?? null),
    [profile?.avatar_url],
  );

  return (
    <View style={styles.avatarCircle}>
      {avatarUri ? (
        <Image
          source={{ uri: avatarUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={100}
          cachePolicy="memory"
        />
      ) : (
        <UiText style={styles.avatarText}>{name.charAt(0).toUpperCase()}</UiText>
      )}
    </View>
  );
}

/**
 * Avatar for the Profile tab header.
 * Larger size — uses the same resolveAvatarUrl logic.
 */
export function ProfileAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl: string | null | undefined;
  name: string;
}) {
  const avatarUri = useMemo(
    () => resolveAvatarUrl(avatarUrl),
    [avatarUrl],
  );

  return (
    <View style={styles.profileCircle}>
      {avatarUri ? (
        <Image
          source={{ uri: avatarUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={100}
          cachePolicy="memory"
        />
      ) : (
        <UiText style={styles.profileAvatarText}>
          {name.charAt(0).toUpperCase()}
        </UiText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatarCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "800" as const,
    fontSize: 13,
  },
  profileCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  profileAvatarText: {
    color: "#fff",
    fontWeight: "800" as const,
    fontSize: 28,
  },
});
