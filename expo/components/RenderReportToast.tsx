import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { subscribeRenderReport } from "@/lib/renderReport";

/** Small message at the top of the screen for internal testers: what the render path did. */
export default function RenderReportToast() {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => subscribeRenderReport(setMessage), []);
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <UiText style={styles.text}>{message}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 1000,
  },
  text: {
    backgroundColor: theme.text,
    color: "#fff",
    fontSize: 12,
    fontWeight: "700" as const,
    paddingHorizontal: 12,
    paddingVertical: 8,
    overflow: "hidden",
    textAlign: "center",
  },
});
