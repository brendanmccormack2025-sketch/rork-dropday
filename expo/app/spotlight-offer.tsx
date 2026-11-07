import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { myOffers, respondToOffer, thumbUri } from "@/lib/spotlight";
import { SPOTLIGHT_ANSWERED_TEXT, SPOTLIGHT_CHOICES, SPOTLIGHT_NO_OFFER_TEXT, SPOTLIGHT_OFFER_TITLE, categoryLabel, type SpotlightChoice } from "@/lib/spotlightText";

/** The creator's decision: full Spotlight, strangers only, or decline. Nothing is shown to anyone before they answer. */
export default function SpotlightOfferScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["spotlight", "offers"], queryFn: myOffers });
  const [busy, setBusy] = useState<string | null>(null);

  const answer = useCallback(
    async (pick: string, choice: SpotlightChoice) => {
      setBusy(pick);
      try {
        await respondToOffer(pick, choice);
        Alert.alert(SPOTLIGHT_ANSWERED_TEXT[choice]);
        await refetch();
        void qc.invalidateQueries({ queryKey: ["spotlight"] });
      } catch (e) {
        Alert.alert("Couldn't save your answer", e instanceof Error ? e.message : undefined);
        await refetch();
      } finally {
        setBusy(null);
      }
    },
    [qc, refetch],
  );

  const offers = (data ?? []).filter((o) => o.status === "offered");
  const live = (data ?? []).filter((o) => o.status !== "offered");
  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Spotlight</UiText>
          <View style={styles.back} />
        </View>
        {isLoading ? (
          <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {offers.length === 0 && live.length === 0 && <UiText style={styles.muted}>{SPOTLIGHT_NO_OFFER_TEXT}</UiText>}
            {offers.map((o) => {
              const uri = thumbUri(o.thumbnail_url);
              return (
                <View key={o.pick_id} style={styles.card}>
                  {uri && <Image source={{ uri }} style={styles.thumb} contentFit="cover" />}
                  <UiText style={styles.offerTitle}>{SPOTLIGHT_OFFER_TITLE}</UiText>
                  <UiText style={styles.category}>{categoryLabel(o.category)}</UiText>
                  {SPOTLIGHT_CHOICES.map((c) => (
                    <Pressable key={c.key} disabled={busy === o.pick_id} onPress={() => void answer(o.pick_id, c.key)} style={({ pressed }) => [styles.choice, c.key === "decline" && styles.choiceQuiet, pressed && { opacity: 0.6 }]} accessibilityRole="button">
                      <UiText style={[styles.choiceTitle, c.key === "decline" && styles.choiceTitleQuiet]}>{c.title}</UiText>
                      <UiText style={styles.choiceBody}>{c.body}</UiText>
                    </Pressable>
                  ))}
                </View>
              );
            })}
            {live.map((o) => (
              <View key={o.pick_id} style={styles.card}>
                <UiText style={styles.offerTitle}>{categoryLabel(o.category)}</UiText>
                <UiText style={styles.muted}>{o.status === "full" ? SPOTLIGHT_ANSWERED_TEXT.full : SPOTLIGHT_ANSWERED_TEXT.strangers}</UiText>
              </View>
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
  body: { padding: 16, gap: 14 },
  muted: { color: theme.textMuted, fontSize: 14 },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 14, gap: 8, borderWidth: 1, borderColor: theme.border },
  thumb: { width: "100%", height: 220, borderRadius: 12, backgroundColor: theme.border },
  offerTitle: { color: theme.text, fontSize: 18, fontWeight: "800" as const },
  category: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
  choice: { borderRadius: 12, borderWidth: 1, borderColor: theme.accent, padding: 12, gap: 4 },
  choiceQuiet: { borderColor: theme.border },
  choiceTitle: { color: theme.accent, fontSize: 15, fontWeight: "800" as const },
  choiceTitleQuiet: { color: theme.text },
  choiceBody: { color: theme.textMuted, fontSize: 13 },
});
