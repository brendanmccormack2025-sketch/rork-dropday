import React from "react";
import { StyleSheet, View } from "react-native";
import { theme } from "@/constants/theme";

export default function ScreenBackground({ children }: { children: React.ReactNode }) {
  return <View style={styles.root}>{children}</View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
});
