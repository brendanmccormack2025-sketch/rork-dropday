import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Film, Megaphone, Users } from "lucide-react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { MONEY_INTRO, type MoneyRole } from "@/lib/moneyContent";

/** First open of Money, step 1 and 2: the intro, then Creator / Clipper / Both. The walkthrough and the agreement come next. */
export default function MoneyOnboarding() {
  const router = useRouter();
  const pick = (role: MoneyRole) => router.push({ pathname: "/money/walkthrough", params: { role } } as never);
  const options: Array<{ role: MoneyRole; title: string; body: string; icon: React.ReactNode }> = [
    { role: "creator", title: "Creator", body: "I have footage and want clips made.", icon: <Megaphone color={theme.accent} size={22} /> },
    { role: "clipper", title: "Clipper", body: "I want to make clips and get paid for views.", icon: <Film color={theme.accent} size={22} /> },
    { role: "both", title: "Both", body: "I do both. You can change this later.", icon: <Users color={theme.accent} size={22} /> },
  ];
  return (
    <SettingsScaffold title="Money">
      <UiText style={[s.heading, s.center]}>Welcome to Money</UiText>
      <UiText style={[s.text, s.center]}>{MONEY_INTRO}</UiText>
      <UiText style={styles.pick}>What do you want to do?</UiText>
      {options.map((o) => (
        <Pressable key={o.role} onPress={() => pick(o.role)} style={({ pressed }) => [styles.option, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`I am a ${o.title}`}>
          <View style={styles.icon}>{o.icon}</View>
          <View style={{ flex: 1 }}>
            <UiText style={styles.optTitle}>{o.title}</UiText>
            <UiText style={s.text}>{o.body}</UiText>
          </View>
        </Pressable>
      ))}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create({
  pick: { color: theme.text, fontSize: 16, fontWeight: "800" as const, marginTop: 8 },
  option: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: theme.card, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 16 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(232,41,28,0.10)", alignItems: "center", justifyContent: "center" },
  optTitle: { color: theme.text, fontSize: 18, fontWeight: "900" as const },
});
