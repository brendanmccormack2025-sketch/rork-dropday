import React from "react";
import { StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { showSurvivedBanner } from "@/lib/postDisplay";
import { queuedLabel } from "@/lib/trialEngine";
import type { Post } from "@/providers/PostsProvider";

type SurvivalStatus = NonNullable<Post["status"]>;

/** Pill copy + color per survival status. */
// Posts that end or stay incomplete are never shown, so they have no badge.
const BADGES: Partial<Record<SurvivalStatus, { label: string; color: string }>> = {
  trial: { label: "ON TRYAL", color: theme.accent },
  survived: { label: "SURVIVED", color: theme.success },
  queued: { label: "QUEUED", color: theme.textMuted },
};

/**
 * Status badge for survival verdicts — a small glass pill whose 6px dot
 * carries the status colour. Shared by the feed's
 * bottom-left block and the profile grid; the status logic itself is unchanged.
 */
export function TrialStatusBadge({
  status,
  distributionExpiresAt,
  queuePosition,
  survivedAt,
}: {
  status: Post["status"];
  /** Kept for callers; the banner window now comes from survivedAt. */
  distributionExpiresAt?: string | null;
  /** When the post survived: SURVIVED shows for the 24 hours after this, then nothing. */
  survivedAt?: string | null;
  /** For a queued post: 1 = up next. */
  queuePosition?: number | null;
}) {
  let shown: string = status ?? "trial";
  // SURVIVED is a 24-hour banner after survived_at; after that (status 'expired' internally) the post carries no badge.
  // "Expired" is never shown.
  if (shown === "expired" || shown === "survived") {
    if (!showSurvivedBanner({ status: shown, survived_at: survivedAt ?? null }, Date.now())) return null;
    shown = "survived";
  }
  // Unknown statuses render no badge instead of crashing.
  if (!Object.prototype.hasOwnProperty.call(BADGES, shown)) return null;
  const found = BADGES[shown as SurvivalStatus];
  if (!found) return null;
  const badge = shown === "queued" ? { ...found, label: queuedLabel(queuePosition).toUpperCase() } : found;
  return (
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: badge.color }]} />
      <UiText style={styles.label}>{badge.label}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  // hugs its text (never a full-width bar): a small glass pill, the status colour on the dot
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "600" as const,
    letterSpacing: 0.7,
  },
});
