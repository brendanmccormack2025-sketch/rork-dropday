import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";

type Props = { visible: boolean; onContinue: () => void; onNotNow: () => void };

/** Shown once, before the first transcription, ahead of the system speech permission prompt. */
export default function CaptionsExplainer({ visible, onContinue, onNotNow }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onNotNow}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <UiText weight={800} style={styles.title}>
            Editing, on your phone
          </UiText>
          <UiText style={styles.body}>
            Trial analyzes your speech on your phone to edit your video. Nothing is uploaded.
          </UiText>
          <Pressable onPress={onContinue} style={styles.primary}>
            <UiText weight={700} style={styles.primaryText}>
              Continue
            </UiText>
          </Pressable>
          <Pressable onPress={onNotNow} hitSlop={8} style={styles.secondary}>
            <UiText weight={700} style={styles.secondaryText}>
              Not now
            </UiText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,10,10,0.6)",
    paddingHorizontal: 32,
  },
  card: {
    width: "100%",
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 24,
    gap: 14,
  },
  title: { fontSize: 20, color: theme.text },
  body: { fontSize: 15, lineHeight: 21, color: theme.textMuted },
  primary: { backgroundColor: theme.accent, paddingVertical: 14, alignItems: "center", marginTop: 6 },
  primaryText: { color: "#fff", fontSize: 15 },
  secondary: { alignItems: "center", paddingVertical: 6 },
  secondaryText: { color: theme.textMuted, fontSize: 14 },
});
