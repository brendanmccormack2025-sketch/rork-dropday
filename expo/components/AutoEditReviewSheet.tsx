import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { Sensitivity, TimeRange } from "@/lib/silenceDetection";

const LEVELS: Array<{ id: Sensitivity; label: string }> = [
  { id: "gentle", label: "Gentle" },
  { id: "normal", label: "Normal" },
  { id: "tight", label: "Tight" },
];

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

type Props = {
  visible: boolean;
  cuts: TimeRange[];
  enabled: boolean[];
  sensitivity: Sensitivity;
  onSensitivity: (value: Sensitivity) => void;
  onToggle: (index: number, value: boolean) => void;
  onUseOriginal: () => void;
  onDone: () => void;
};

/** Lists each silence cut with a switch, plus the three-way Sensitivity control. */
export default function AutoEditReviewSheet({
  visible,
  cuts,
  enabled,
  sensitivity,
  onSensitivity,
  onToggle,
  onUseOriginal,
  onDone,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDone}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <UiText style={styles.title}>Review cuts</UiText>

          <UiText style={styles.label}>Sensitivity</UiText>
          <View style={styles.segment}>
            {LEVELS.map((l) => (
              <Pressable
                key={l.id}
                onPress={() => onSensitivity(l.id)}
                style={[styles.segBtn, sensitivity === l.id && styles.segBtnOn]}
              >
                <UiText style={[styles.segText, sensitivity === l.id && styles.segTextOn]}>
                  {l.label}
                </UiText>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.list}>
            {cuts.length === 0 ? (
              <UiText style={styles.empty}>No long pauses found at this setting.</UiText>
            ) : (
              cuts.map((c, i) => (
                <View key={`${c.startMs}`} style={styles.row}>
                  <UiText style={styles.rowText}>
                    {fmt(c.startMs)} – {fmt(c.endMs)}  ·  {(c.lengthMs / 1000).toFixed(1)} s
                  </UiText>
                  <Switch
                    value={enabled[i] ?? false}
                    onValueChange={(v) => onToggle(i, v)}
                    trackColor={{ false: theme.border, true: theme.accent }}
                    thumbColor="#fff"
                    ios_backgroundColor={theme.border}
                  />
                </View>
              ))
            )}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable onPress={onUseOriginal} hitSlop={8}>
              <UiText style={styles.actionSecondary}>Use original</UiText>
            </Pressable>
            <Pressable onPress={onDone} hitSlop={8}>
              <UiText style={styles.actionPrimary}>Done</UiText>
            </Pressable>
          </View>
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
    maxHeight: "70%",
  },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const, marginBottom: 12 },
  label: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "900" as const,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  segment: { flexDirection: "row", borderWidth: 1, borderColor: theme.border, marginBottom: 12 },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center" },
  segBtnOn: { backgroundColor: theme.text },
  segText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  segTextOn: { color: theme.card },
  list: { flexGrow: 0 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  rowText: { color: theme.text, fontSize: 14, fontWeight: "600" as const },
  empty: { color: theme.textDim, fontSize: 14, paddingVertical: 12 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  actionSecondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  actionPrimary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
});
