import React from "react";
import { Modal, Pressable, StyleSheet, Switch, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { CategoryRow } from "@/lib/autoEdit/editPanel";

type Props = {
  visible: boolean;
  rows: CategoryRow[];
  canUndo: boolean;
  canRedo: boolean;
  onToggle: (row: CategoryRow, value: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onOriginal: () => void;
  /** Owner only; the button is hidden when this is undefined. */
  onShareDebug?: () => void;
  onClose: () => void;
};

/** Every AI edit by category, each with its own switch, plus undo/redo and the two resets. */
export default function AiEditsSheet({
  visible,
  rows,
  canUndo,
  canRedo,
  onToggle,
  onUndo,
  onRedo,
  onReset,
  onOriginal,
  onShareDebug,
  onClose,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <UiText style={styles.title}>AI edits</UiText>
            <View style={styles.undoRow}>
              <Pressable onPress={onUndo} disabled={!canUndo} hitSlop={8}>
                <UiText style={[styles.undo, !canUndo && styles.undoOff]}>Undo</UiText>
              </Pressable>
              <Pressable onPress={onRedo} disabled={!canRedo} hitSlop={8}>
                <UiText style={[styles.undo, !canRedo && styles.undoOff]}>Redo</UiText>
              </Pressable>
            </View>
          </View>

          {rows.map((row) => (
            <View key={row.id} style={styles.row}>
              <UiText style={styles.rowText}>
                {row.label}
                {"  ·  "}
                {row.count}
              </UiText>
              <Switch
                value={row.enabled}
                onValueChange={(v) => onToggle(row, v)}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor="#fff"
                ios_backgroundColor={theme.border}
              />
            </View>
          ))}

          <View style={styles.actions}>
            <Pressable onPress={onOriginal} hitSlop={8}>
              <UiText style={styles.actionSecondary}>Original video</UiText>
            </Pressable>
            <Pressable onPress={onReset} hitSlop={8}>
              <UiText style={styles.actionPrimary}>Reset to AI edit</UiText>
            </Pressable>
          </View>

          {onShareDebug && (
            <Pressable onPress={onShareDebug} hitSlop={8} style={styles.debugBtn}>
              <UiText style={styles.actionSecondary}>Share AI debug</UiText>
            </Pressable>
          )}

          <Pressable onPress={onClose} hitSlop={8} style={styles.doneBtn}>
            <UiText style={styles.actionPrimary}>Done</UiText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: theme.card,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  undoRow: { flexDirection: "row", gap: 16 },
  undo: { color: theme.accent, fontSize: 14, fontWeight: "900" as const },
  undoOff: { color: theme.textDim },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  rowText: { color: theme.text, fontSize: 14, fontWeight: "600" as const },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  actionSecondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  actionPrimary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
  debugBtn: { marginTop: 16 },
  doneBtn: { marginTop: 16, alignSelf: "flex-end" },
});
