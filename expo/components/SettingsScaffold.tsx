import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";

import { theme } from "@/constants/theme";
import UiText from "@/components/UiText";

/** Header with a back button + a scrolling body, for the small settings screens. */
export function SettingsScaffold({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const navigation = useNavigation();
  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Pressable
            onPress={() => {
              if (navigation.canGoBack()) router.back();
              else router.replace("/settings");
            }}
            style={styles.back}
            hitSlop={8}
          >
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>{title}</UiText>
          <View style={styles.back} />
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

export const settingsStyles = StyleSheet.create({
  text: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },
  heading: { color: theme.text, fontSize: 18, fontWeight: "900" as const },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
    color: theme.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: { backgroundColor: theme.accent, paddingVertical: 13, alignItems: "center" as const },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "700" as const },
  secondary: { borderWidth: 1, borderColor: theme.border, paddingVertical: 13, alignItems: "center" as const },
  secondaryText: { color: theme.text, fontSize: 15, fontWeight: "600" as const },
  error: { color: "#E8291C", fontSize: 13 },
  ok: { color: theme.success, fontSize: 13 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 10 },
  back: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const, letterSpacing: -0.3 },
  body: { padding: 20, gap: 14, paddingBottom: 60 },
});
