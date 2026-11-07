import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { getDmPolicy, setDmPolicy } from "@/lib/safety";
import { DM_POLICIES, WHO_CAN_MESSAGE_TITLE, type DmPolicy } from "@/lib/safetyText";

/** Who can message me (the database enforces it on every message, whatever app sends it). */
export default function WhoCanMessageScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["safety", "dm-policy"], queryFn: getDmPolicy });
  const [saving, setSaving] = useState(false);

  const choose = useCallback(
    async (policy: DmPolicy) => {
      setSaving(true);
      try {
        await setDmPolicy(policy);
        await qc.invalidateQueries({ queryKey: ["safety", "dm-policy"] });
      } catch (e) {
        Alert.alert("Couldn't save", e instanceof Error ? e.message : undefined);
      } finally {
        setSaving(false);
      }
    },
    [qc],
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>{WHO_CAN_MESSAGE_TITLE}</UiText>
          <View style={styles.back} />
        </View>
        {isLoading ? (
          <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {DM_POLICIES.map((p) => (
              <Pressable key={p.key} disabled={saving} onPress={() => void choose(p.key)} style={[styles.row, data === p.key && styles.rowOn]} accessibilityRole="radio" accessibilityState={{ selected: data === p.key }}>
                <View style={{ flex: 1 }}>
                  <UiText style={styles.rowTitle}>{p.title}</UiText>
                  <UiText style={styles.rowBody}>{p.body}</UiText>
                </View>
                {data === p.key && <Check color={theme.accent} size={20} strokeWidth={3} />}
              </Pressable>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, height: 48 },
  back: { width: 36, alignItems: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "700" as const },
  body: { padding: 16, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14 },
  rowOn: { borderColor: theme.accent, borderWidth: 2 },
  rowTitle: { color: theme.text, fontSize: 15, fontWeight: "700" as const },
  rowBody: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
});
