import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ShieldAlert } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { SANCTION_CONTACT, SANCTION_SIGN_OUT, sanctionMessage, sanctionTitle, type Sanction } from "@/lib/sanctionText";

/** Shown at sign-in instead of the app while the account is suspended or banned. */
export default function SanctionScreen({ sanction, onSignOut }: { sanction: Sanction; onSignOut: () => void }) {
  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe}>
        <ShieldAlert color={theme.accent} size={44} strokeWidth={2} />
        <UiText style={styles.title}>{sanctionTitle(sanction)}</UiText>
        <UiText style={styles.body}>{sanctionMessage(sanction)}</UiText>
        <UiText style={styles.contact}>{SANCTION_CONTACT}</UiText>
        <Pressable onPress={onSignOut} style={styles.btn} accessibilityRole="button">
          <UiText style={styles.btnText}>{SANCTION_SIGN_OUT}</UiText>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, gap: 14 },
  title: { color: theme.text, fontSize: 22, fontWeight: "800" as const, textAlign: "center" },
  body: { color: theme.text, fontSize: 15, lineHeight: 22, textAlign: "center" },
  contact: { color: theme.textMuted, fontSize: 13, textAlign: "center" },
  btn: { marginTop: 10, backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 28 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" as const },
});
