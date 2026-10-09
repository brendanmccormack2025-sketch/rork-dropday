import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { PostingBlock } from "@/lib/creatorStatus";

/**
 * What the + / camera entry shows instead of the creation options when posting is not available: a positive
 * "You made it 🎓" for graduated creators, a neutral line for restricted ones.
 */
export default function PostingBlockedView({ block, onClose }: { block: PostingBlock; onClose: () => void }) {
  return (
    <View style={styles.wrap} accessibilityLabel={block.title}>
      <UiText style={[styles.title, block.kind === "restricted" && styles.titleNeutral]}>{block.title}</UiText>
      <UiText style={styles.body}>{block.body}</UiText>
      <Pressable onPress={onClose} style={styles.button} accessibilityRole="button" accessibilityLabel="Close">
        <UiText style={styles.buttonText}>{block.kind === "graduated" ? "Keep exploring" : "OK"}</UiText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 12, paddingVertical: 24, paddingHorizontal: 20 },
  title: { color: theme.text, fontSize: 26, fontWeight: "900" as const, textAlign: "center" },
  titleNeutral: { fontSize: 18, fontWeight: "800" as const },
  body: { color: theme.textMuted, fontSize: 15, lineHeight: 21, textAlign: "center" },
  button: {
    marginTop: 8,
    minHeight: 48,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    backgroundColor: theme.accent,
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "800" as const },
});
