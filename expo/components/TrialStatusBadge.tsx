import React from "react";
import { StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { queuedLabel } from "@/lib/trialEngine";
import type { Post } from "@/providers/PostsProvider";

type SurvivalStatus = NonNullable<Post["status"]>;

/** Pill copy + color per survival status. */
// Posts that end or stay incomplete are never shown, so they have no badge.
const BADGES: Partial<Record<SurvivalStatus, { label: string; color: string }>> = {
  trial: { label: "ON TRIAL", color: theme.accent },
  survived: { label: "SURVIVED", color: theme.success },
  expired: { label: "EXPIRED", color: theme.textMuted },
  queued: { label: "QUEUED", color: theme.textMuted },
};

/**
 * Status badge for survival verdicts — small pill with a 6px white dot
 * indicator, colored background matching the status. Shared by the feed's
 * bottom-left block and the profile grid; the status logic itself is unchanged.
 */
export function TrialStatusBadge({
  status,
  distributionExpiresAt,
  queuePosition,
  survivedAt,
}: {
  status: Post["status"];
  /** SURVIVED shows only while this is in the future (or null: survivors with no window yet). */
  distributionExpiresAt?: string | null;
  /** Set once the post survived: a survived post keeps its SURVIVED badge for good (after its 24 h window too). */
  survivedAt?: string | null;
  /** For a queued post: 1 = up next. */
  queuePosition?: number | null;
}) {
  let shown: string = status ?? "trial";
  // A survived post stays SURVIVED on the profile after its window ends (it only leaves the feed).
  if (shown === "expired" && survivedAt) shown = "survived";
  // Unknown statuses render no badge instead of crashing.
  if (!Object.prototype.hasOwnProperty.call(BADGES, shown)) return null;
  const found = BADGES[shown as SurvivalStatus];
  if (!found) return null;
  const badge = shown === "queued" ? { ...found, label: queuedLabel(queuePosition).toUpperCase() } : found;
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
