import React, { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import UiText from "@/components/UiText";
import { saveStatus } from "@/lib/exportEdit";
import { SAVE_FAILED_TEXT, SAVE_SAVED_TEXT, SAVE_SAVING_TEXT } from "@/lib/saveToRoll";

/** A small message at the top of the screen for the camera-roll save: saving, saved, or failed with Retry. */
export default function SaveToRollToast() {
  const state = useSyncExternalStore(saveStatus.subscribe, saveStatus.get, saveStatus.get);
  const insets = useSafeAreaInsets();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (state.kind !== "saved") return;
    const t = setTimeout(() => setHidden(true), 2500);
    return () => clearTimeout(t);
  }, [state]);

  if (state.kind === "idle" || hidden) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <View style={styles.pill}>
        {state.kind === "saving" && (
          <>
            <ActivityIndicator size="small" color="#fff" />
            <UiText style={styles.text}>{SAVE_SAVING_TEXT}</UiText>
          </>
        )}
        {state.kind === "saved" && <UiText style={styles.text}>{SAVE_SAVED_TEXT}</UiText>}
        {state.kind === "failed" && (
          <>
            <UiText style={styles.text}>{SAVE_FAILED_TEXT}</UiText>
            <Pressable onPress={state.retry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry saving">
              <UiText style={styles.retry}>Retry</UiText>
            </Pressable>
            <Pressable onPress={() => saveStatus.set({ kind: "idle" })} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
              <UiText style={styles.dismiss}>✕</UiText>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 9999 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(10,10,10,0.88)",
  },
  text: { color: "#fff", fontSize: 13, fontWeight: "600" },
  retry: { color: "#FF6B5E", fontSize: 13, fontWeight: "800" },
  dismiss: { color: "rgba(255,255,255,0.6)", fontSize: 13, fontWeight: "700" },
});
