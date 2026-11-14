import React from "react";
import { View } from "react-native";
import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { FAQ, MONEY_INTRO } from "@/lib/moneyContent";

export default function MoneyFaq() {
  return (
    <SettingsScaffold title="How Money works">
      <UiText style={s.text}>{MONEY_INTRO}</UiText>
      {FAQ.map((f) => (
        <View key={f.q} style={{ gap: 6, marginTop: 8 }}>
          <UiText style={{ color: theme.text, fontSize: 17, fontWeight: "900" }}>{f.q}</UiText>
          <UiText style={s.text}>{f.a}</UiText>
        </View>
      ))}
    </SettingsScaffold>
  );
}
