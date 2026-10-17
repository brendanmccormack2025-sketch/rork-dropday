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
          <View style={styles.backSpacer} />
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
  heading: { color: theme.text, fontSize: 22, fontWeight: "900" as const, letterSpacing: -0.4, lineHeight: 28 },
  input: {
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.card,
    color: theme.text,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
    fontSize: 17,
  },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 999,
    minHeight: 54,
    paddingHorizontal: 24,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "800" as const, letterSpacing: -0.2 },
  secondary: {
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.card,
    borderRadius: 999,
    minHeight: 54,
    paddingHorizontal: 24,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  secondaryText: { color: theme.text, fontSize: 16, fontWeight: "700" as const },
  /** A soft round badge for a screen's icon (onboarding steps). */
  iconBadge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(232,41,28,0.10)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    alignSelf: "center" as const,
    marginTop: 8,
    marginBottom: 4,
  },
  center: { textAlign: "center" as const },
  error: { color: "#E8291C", fontSize: 13 },
  ok: { color: theme.success, fontSize: 13 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  back: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  backSpacer: { width: 42, height: 42 },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const, letterSpacing: -0.3 },
  body: { padding: 22, gap: 16, paddingBottom: 60 },
});
