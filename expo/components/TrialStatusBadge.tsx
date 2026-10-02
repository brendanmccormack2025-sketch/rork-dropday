import React from "react";
import { StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { Post } from "@/providers/PostsProvider";

type SurvivalStatus = NonNullable<Post["status"]>;

/** Pill copy + color per survival status. `incomplete` shares the ON TRIAL
 *  look — an underexposed post is still being judged, not failed. */
const BADGES: Record<SurvivalStatus, { label: string; color: string }> = {
  trial: { label: "ON TRIAL", color: theme.accent },
  incomplete: { label: "ON TRIAL", color: theme.accent },
  survived: { label: "SURVIVED", color: theme.success },
  archived: { label: "TRIAL ENDED", color: "rgba(10,10,10,0.65)" },
  expired: { label: "EXPIRED", color: theme.textMuted },
};

/**
 * Status badge for survival verdicts — small pill with a 6px white dot
 * indicator, colored background matching the status. Shared by the feed's
 * bottom-left block and the profile grid; the status logic itself is unchanged.
 */
export function TrialStatusBadge({
  status,
  distributionExpiresAt,
}: {
  status: Post["status"];
  /** SURVIVED shows only while this is in the future (or null: survivors with no window yet). */
  distributionExpiresAt?: string | null;
}) {
  let shown: string = status ?? "trial";
  if (shown === "survived" && distributionExpiresAt) {
    const expiresMs = Date.parse(distributionExpiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) shown = "expired";
  }
  // Unknown statuses render no badge instead of crashing.
  if (!Object.prototype.hasOwnProperty.call(BADGES, shown)) return null;
  const badge = BADGES[shown as SurvivalStatus];
  return (
    <View style={[styles.badge, { backgroundColor: badge.color }]}>
      <View style={styles.dot} />
      <UiText style={styles.label}>{badge.label}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FFFFFF",
  },
  label: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "500" as const,
    letterSpacing: 0.6,
  },
});
