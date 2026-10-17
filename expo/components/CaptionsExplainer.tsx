import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";

/** No "Not now": Apple (5.1.1(iv)) requires a message before a permission prompt to always lead to the prompt. */
type Props = { visible: boolean; onContinue: () => void; onNotNow?: () => void };

/** Shown once, before the first transcription, ahead of the system speech permission prompt. */
export default function CaptionsExplainer({ visible, onContinue }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <UiText weight={800} style={styles.title}>
            Editing, on your phone
          </UiText>
          <UiText style={styles.body}>
            Tryal analyzes your speech on your phone to edit your video. Nothing is uploaded.
          </UiText>
          <Pressable onPress={onContinue} style={styles.primary}>
            <UiText weight={700} style={styles.primaryText}>
              Continue
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
    borderRadius: 28,
    padding: 24,
    gap: 14,
  },
  title: { fontSize: 20, color: theme.text },
  body: { fontSize: 15, lineHeight: 21, color: theme.textMuted },
  primary: { backgroundColor: theme.accent, borderRadius: 999, minHeight: 52, justifyContent: "center", alignItems: "center", marginTop: 6 },
  primaryText: { color: "#fff", fontSize: 15 },
});
