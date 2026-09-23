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
 * Plain-text status pill for the creator's own profile grid.
 * Minimum-scope verdict UI — no animation, no reveal moment.
 */
export function TrialStatusBadge({ status }: { status: Post["status"] }) {
  const badge = BADGES[status ?? "trial"];
  return (
    <View style={[styles.badge, { backgroundColor: badge.color }]}>
      <UiText style={styles.label}>{badge.label}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 0,
  },
  label: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "900" as const,
    letterSpacing: 0.5,
  },
});
