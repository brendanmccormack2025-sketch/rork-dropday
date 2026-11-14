import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { FeedAvatar } from "@/components/Avatar";
import { theme } from "@/constants/theme";
import { cardModel } from "@/lib/moneyCampaign";
import type { CampaignWithCreator } from "@/lib/moneyApi";

/** A campaign in Browse / My Clips. Payment is plain text ("Pays via PayPal"): nothing here is tappable except the card itself. */
export default function CampaignCard({ item, onPress }: { item: CampaignWithCreator; onPress: () => void }) {
  const m = cardModel(item.row, item.stats);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={`Campaign ${m.title}`}>
      <View style={styles.top}>
        <FeedAvatar profile={item.creator} name={item.creator?.username ?? "?"} size={36} />
        <View style={{ flex: 1 }}>
          <UiText style={styles.creator}>{item.creator ? `@${item.creator.username}` : "Creator"}</UiText>
          <UiText style={styles.sub}>{m.rating} · {m.record}</UiText>
        </View>
      </View>
      <UiText style={styles.title}>{m.title}</UiText>
      <UiText style={styles.pay}>{m.rate}, {m.cap}</UiText>
      {m.guarantee ? <UiText style={styles.sub}>{m.guarantee}</UiText> : null}
      <UiText style={styles.sub}>{m.budgetLeft} · {m.platforms}</UiText>
      <View style={styles.foot}>
        <UiText style={styles.sub}>{m.payVia}</UiText>
        <UiText style={styles.deadline}>{m.deadline}</UiText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.card, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 4 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  creator: { color: theme.text, fontSize: 14, fontWeight: "800" as const },
  title: { color: theme.text, fontSize: 18, fontWeight: "900" as const, letterSpacing: -0.3 },
  pay: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
  sub: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
  foot: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  deadline: { color: theme.text, fontSize: 13, fontWeight: "700" as const },
});
