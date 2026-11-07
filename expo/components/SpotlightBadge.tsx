import React from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { profileSpotlight } from "@/lib/spotlight";
import { badgeText } from "@/lib/spotlightText";

/** The Spotlight badge on a profile. The database decides whether this viewer may see it (nothing is returned otherwise). */
export function SpotlightBadge({ userId }: { userId: string | null | undefined }) {
  const { data } = useQuery({
    queryKey: ["spotlight", "badge", userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: () => profileSpotlight(userId as string),
  });
  if (!data) return null;
  return (
    <View style={styles.badge} accessibilityLabel={`Spotlight: ${badgeText(data.category, data.active)}`}>
      <Star color={theme.accent} size={12} strokeWidth={2.5} fill={data.active ? theme.accent : "transparent"} />
      <UiText style={styles.text}>{badgeText(data.category, data.active)}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: theme.accent, marginTop: 6 },
  text: { color: theme.accent, fontSize: 12, fontWeight: "700" as const },
});
