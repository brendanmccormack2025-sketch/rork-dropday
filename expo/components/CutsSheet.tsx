import React from "react";
import { Modal, Pressable, StyleSheet, Switch, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { CutsRow } from "@/lib/autoEdit/editPanel";
import type { Sensitivity } from "@/lib/silenceDetection";

const LEVELS: Array<{ id: Sensitivity; label: string }> = [
  { id: "gentle", label: "Gentle" },
  { id: "normal", label: "Normal" },
  { id: "tight", label: "Tight" },
];

type Props = {
  visible: boolean;
  /** "15 cuts · saved 35.2 s" */
  summary: string;
  rows: CutsRow[];
  /** Undefined: there was no silence analysis for this clip, so there is no sensitivity to set. */
  sensitivity?: Sensitivity;
  onSensitivity: (value: Sensitivity) => void;
  canUndo: boolean;
  canRedo: boolean;
  onToggle: (row: CutsRow, value: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Reset to AI edit. */
  onReset: () => void;
  /** Restore all: the original video. */
  onRestoreAll: () => void;
  /** Owner only; hidden when undefined. */
  onShareDebug?: () => void;
  onClearCache?: () => void;
  onClose: () => void;
};

/**
 * One sheet for every cut: the summary, how tight the silence cuts are, a switch for each kind of cut,
 * Restore all (the original video), Reset to AI edit and undo / redo. (The old Review sheet and AI edits
 * panel in one.) The owner's debug actions live at the bottom.
 */
export default function CutsSheet({
  visible,
  summary,
  rows,
  sensitivity,
  onSensitivity,
  canUndo,
  canRedo,
  onToggle,
  onUndo,
  onRedo,
  onReset,
  onRestoreAll,
  onShareDebug,
  onClearCache,
  onClose,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <View>
              <UiText style={styles.title}>Cuts</UiText>
              <UiText style={styles.summary}>{summary}</UiText>
            </View>
            <View style={styles.undoRow}>
              <Pressable onPress={onUndo} disabled={!canUndo} hitSlop={8} style={styles.target}>
                <UiText style={[styles.undo, !canUndo && styles.undoOff]}>Undo</UiText>
              </Pressable>
              <Pressable onPress={onRedo} disabled={!canRedo} hitSlop={8} style={styles.target}>
                <UiText style={[styles.undo, !canRedo && styles.undoOff]}>Redo</UiText>
              </Pressable>
            </View>
          </View>

          {sensitivity !== undefined && (
            <>
              <UiText style={styles.label}>Sensitivity</UiText>
              <View style={styles.segment}>
                {LEVELS.map((l) => (
                  <Pressable
                    key={l.id}
                    onPress={() => onSensitivity(l.id)}
                    style={[styles.segBtn, sensitivity === l.id && styles.segBtnOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sensitivity === l.id }}
                  >
                    <UiText style={[styles.segText, sensitivity === l.id && styles.segTextOn]}>{l.label}</UiText>
                  </Pressable>
                ))}
              </View>
            </>
          )}

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
            <Pressable onPress={onRestoreAll} hitSlop={8} style={styles.target}>
              <UiText style={styles.actionSecondary}>Restore all</UiText>
            </Pressable>
            <Pressable onPress={onReset} hitSlop={8} style={styles.target}>
              <UiText style={styles.actionPrimary}>Reset to AI edit</UiText>
            </Pressable>
          </View>

          {onShareDebug && (
            <Pressable onPress={onShareDebug} hitSlop={8} style={styles.target}>
              <UiText style={styles.actionSecondary}>Share AI debug</UiText>
            </Pressable>
          )}
          {onClearCache && (
            <Pressable onPress={onClearCache} hitSlop={8} style={styles.target}>
              <UiText style={styles.actionSecondary}>Clear analysis cache for this clip</UiText>
            </Pressable>
          )}

          <Pressable onPress={onClose} hitSlop={8} style={[styles.target, styles.doneBtn]}>
            <UiText style={styles.actionPrimary}>Done</UiText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: theme.card, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  summary: { color: theme.textMuted, fontSize: 13, fontWeight: "600" as const, marginTop: 2 },
  undoRow: { flexDirection: "row", gap: 16 },
  undo: { color: theme.accent, fontSize: 14, fontWeight: "900" as const },
  undoOff: { color: theme.textDim },
  label: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "900" as const,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 6,
  },
  segment: { flexDirection: "row", borderWidth: 1, borderColor: theme.border, marginBottom: 8 },
  segBtn: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center" },
  segBtnOn: { backgroundColor: theme.text },
  segText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  segTextOn: { color: theme.card },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  rowText: { color: theme.text, fontSize: 14, fontWeight: "600" as const },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  target: { minHeight: 44, justifyContent: "center" },
  actionSecondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  actionPrimary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
  doneBtn: { alignSelf: "flex-end" },
});
