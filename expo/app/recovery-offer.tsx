import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { myRecoveryOffer, respondRecovery } from "@/lib/recovery";
import { RECOVERY_ACCEPT, RECOVERY_ANSWERED, RECOVERY_DECLINE, RECOVERY_NO_OFFER_TEXT, RECOVERY_OFFER_BODY, RECOVERY_OFFER_TITLE, recoveryStatusText } from "@/lib/recoveryText";

/** The Recovery Boost offer: optional, names nobody. Accept (the next post is boosted) or not now. */
export default function RecoveryOfferScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["recovery", "offer"], queryFn: myRecoveryOffer });
  const [busy, setBusy] = useState(false);

  const answer = useCallback(
    async (accept: boolean) => {
      if (!data) return;
      setBusy(true);
      try {
        await respondRecovery(data.offer_id, accept);
        Alert.alert(RECOVERY_ANSWERED[accept ? "accepted" : "declined"]);
        await refetch();
        void qc.invalidateQueries({ queryKey: ["recovery"] });
      } catch (e) {
        Alert.alert("Couldn't save your answer", e instanceof Error ? e.message : undefined);
        await refetch();
      } finally {
        setBusy(false);
      }
    },
    [data, qc, refetch],
  );

  const statusText = recoveryStatusText(data?.status);
  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Recovery Boost</UiText>
          <View style={styles.back} />
        </View>
        {isLoading ? (
          <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {!data && <UiText style={styles.muted}>{RECOVERY_NO_OFFER_TEXT}</UiText>}
            {data?.status === "offered" && (
              <View style={styles.card}>
                <UiText style={styles.offerTitle}>{RECOVERY_OFFER_TITLE}</UiText>
                <UiText style={styles.muted}>{RECOVERY_OFFER_BODY}</UiText>
                <Pressable disabled={busy} onPress={() => void answer(true)} style={[styles.accept, busy && { opacity: 0.5 }]} accessibilityRole="button">
                  <UiText style={styles.acceptText}>{RECOVERY_ACCEPT}</UiText>
                </Pressable>
                <Pressable disabled={busy} onPress={() => void answer(false)} style={styles.decline} accessibilityRole="button">
                  <UiText style={styles.declineText}>{RECOVERY_DECLINE}</UiText>
                </Pressable>
              </View>
            )}
            {statusText && (
              <View style={styles.card}>
                <UiText style={styles.offerTitle}>Recovery Boost</UiText>
                <UiText style={styles.muted}>{statusText}</UiText>
              </View>
            )}
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
  body: { padding: 16, gap: 14 },
  muted: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: theme.border },
  offerTitle: { color: theme.text, fontSize: 18, fontWeight: "800" as const },
  accept: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 6 },
  acceptText: { color: "#fff", fontSize: 15, fontWeight: "800" as const },
  decline: { alignItems: "center", paddingVertical: 10 },
  declineText: { color: theme.textMuted, fontSize: 14, fontWeight: "600" as const },
});
