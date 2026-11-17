import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import { describeAttempt, type Attempt } from "@/lib/footageAttempts";
import { clearAttempts, loadAttempts } from "@/lib/footageRuntime";
import { useAuth } from "@/providers/AuthProvider";

/** Owner only: the last 20 footage attempts on this phone (stage, error, length, file size). Kept on the phone, never sent anywhere. */
export default function FootageDebugScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const owner = isDebugOwner(user?.id);
  const [list, setList] = useState<Attempt[] | null>(null);
  const refresh = useCallback(() => { void loadAttempts().then(setList); }, []);
  useEffect(() => { if (owner) refresh(); }, [owner, refresh]);
  if (!owner) return <Redirect href="/(tabs)" />;
  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}><ChevronLeft color={theme.text} size={22} strokeWidth={2.5} /></Pressable>
          <UiText style={styles.title}>Footage attempts</UiText>
          <Pressable onPress={refresh} style={styles.back} hitSlop={8}><UiText style={styles.link}>Refresh</UiText></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {list === null ? <UiText style={styles.muted}>Loading…</UiText> : list.length === 0 ? <UiText style={styles.muted}>No attempts yet. Pick a video on the Add footage step.</UiText> : list.map((a) => (
            <View key={a.id} style={[styles.card, a.state === "error" && { borderColor: theme.danger }]}>
              <UiText style={styles.cardTitle}>{a.name}</UiText>
              <UiText style={styles.muted}>{new Date(a.at).toLocaleString()}</UiText>
              {describeAttempt(a).map((l) => <UiText key={l} style={styles.line} selectable>{l}</UiText>)}
            </View>
          ))}
          {list && list.length ? <Pressable onPress={() => { void clearAttempts().then(refresh); }} accessibilityRole="button"><UiText style={styles.link}>Clear the list</UiText></Pressable> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 },
  back: { minWidth: 56, height: 32, justifyContent: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  body: { padding: 16, gap: 12 },
  card: { backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 3 },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: "800" as const },
  line: { color: theme.text, fontSize: 13 },
  muted: { color: theme.textMuted, fontSize: 13 },
  link: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
});
