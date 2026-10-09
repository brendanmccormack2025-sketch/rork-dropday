import React from "react";
import { StyleSheet, View } from "react-native";
import { GraduationCap } from "lucide-react-native";

import UiText from "@/components/UiText";
import { BADGE_LABEL } from "@/lib/creatorStatus";

/** "Verified Big Creator": a gold cap-and-label pill, unlike the survival status pills (TrialStatusBadge). */
export default function VerifiedCreatorBadge() {
  return (
    <View style={styles.badge} accessible accessibilityRole="text" accessibilityLabel={BADGE_LABEL}>
      <GraduationCap color="#5B4300" size={13} strokeWidth={2.4} />
      <UiText style={styles.text}>{BADGE_LABEL}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 6,
    borderRadius: 999,
    backgroundColor: "#F6C945",
    borderWidth: 1,
    borderColor: "#B88A00",
  },
  text: { color: "#5B4300", fontSize: 11, fontWeight: "800" as const, letterSpacing: 0.3 },
});
