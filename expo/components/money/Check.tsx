import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check as CheckIcon } from "lucide-react-native";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";

/** A checkbox row (one per agreement rule). */
export default function Check({ checked, onToggle, label, disabled }: { checked: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onToggle} disabled={disabled} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: !!disabled }}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <CheckIcon color="#fff" size={15} strokeWidth={3} /> : null}</View>
      <UiText style={styles.label}>{label}</UiText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 6 },
  box: { width: 24, height: 24, borderRadius: 8, borderWidth: 2, borderColor: theme.border, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  label: { flex: 1, color: theme.text, fontSize: 15, lineHeight: 21 },
});
