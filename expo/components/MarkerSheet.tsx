import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { formatFeatures } from "@/lib/autoEdit/classifySound";
import type { TimelineMarker } from "@/lib/autoEdit/markers";

type Props = {
  marker: TimelineMarker | null;
  onRestore: (marker: TimelineMarker) => void;
  onReapply: (marker: TimelineMarker) => void;
  onClose: () => void;
};

/** What a marker stands for: removed footage (Restore), a restored cut (Re-apply) or a debug note. */
export default function MarkerSheet({ marker, onRestore, onReapply, onClose }: Props) {
  const title =
    marker?.kind === "cut"
      ? "Removed here"
      : marker?.kind === "restored"
        ? "Restored here"
        : marker?.kind === "proposal"
          ? "Emphasis moment (not applied)"
          : marker?.kind === "filler2"
            ? "Filler candidate (not applied)"
            : marker?.kind === "laugh"
              ? "Laugh (never cut)"
              : "";
  return (
    <Modal visible={!!marker} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <UiText style={styles.title}>{title}</UiText>
          <ScrollView style={styles.list}>
            {marker?.items.map((item) => (
              <React.Fragment key={item.decisionId}>
                <UiText style={styles.item}>{item.label}</UiText>
                {item.sound && (
                  <>
                    <UiText style={styles.detail}>Class: {item.sound.cls}</UiText>
                    <UiText style={styles.detail}>{formatFeatures(item.sound.features)}</UiText>
                  </>
                )}
              </React.Fragment>
            ))}
            {marker?.detail && (
              <>
                {marker.detail.cls && <UiText style={styles.detail}>Class: {marker.detail.cls}</UiText>}
                {marker.detail.features && (
                  <UiText style={styles.detail}>{formatFeatures(marker.detail.features)}</UiText>
                )}
                {marker.detail.score > 0 && (
                  <UiText style={styles.detail}>Score {marker.detail.score.toFixed(2)}</UiText>
                )}
                {marker.detail.reasons.map((r) => (
                  <UiText key={r} style={styles.detail}>
                    {r}
                  </UiText>
                ))}
              </>
            )}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable onPress={onClose} hitSlop={8}>
              <UiText style={styles.secondary}>Close</UiText>
            </Pressable>
            {marker?.kind === "cut" && (
              <Pressable onPress={() => onRestore(marker)} hitSlop={8}>
                <UiText style={styles.primary}>Restore</UiText>
              </Pressable>
            )}
            {marker?.kind === "restored" && (
              <Pressable onPress={() => onReapply(marker)} hitSlop={8}>
                <UiText style={styles.primary}>Re-apply cut</UiText>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", paddingHorizontal: 32, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: theme.card, padding: 16, borderWidth: 1, borderColor: theme.border },
  title: { color: theme.text, fontSize: 16, fontWeight: "900" as const, marginBottom: 10 },
  list: { maxHeight: 180, flexGrow: 0 },
  item: { color: theme.text, fontSize: 14, fontWeight: "600" as const, paddingVertical: 4 },
  detail: { color: theme.textMuted, fontSize: 13, paddingVertical: 2 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  secondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  primary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
});
