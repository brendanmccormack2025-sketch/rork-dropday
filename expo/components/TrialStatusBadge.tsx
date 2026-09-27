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
  archived: { label: "TRIAL FAILED", color: "rgba(10,10,10,0.65)" },
};

/**
 * Status pill for survival verdicts — rounded capsule with a small dot
 * indicator, colored background matching the status. Shared by the feed's
 * top-left badge and the profile grid; the status logic itself is unchanged.
 */
export function TrialStatusBadge({ status }: { status: Post["status"] }) {
  const badge = BADGES[status ?? "trial"];
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
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.95)",
  },
  label: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "900" as const,
    letterSpacing: 0.5,
  },
});
