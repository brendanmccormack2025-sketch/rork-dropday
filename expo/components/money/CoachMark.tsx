import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Lightbulb, X } from "lucide-react-native";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { MONEY_TIPS, tipKey, type MoneyTipId } from "@/lib/moneyGuides";

/** A short tip the first time someone reaches a step. Shows once, can be dismissed; storage trouble just means it does not show. */
export default function CoachMark({ id }: { id: MoneyTipId }) {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    AsyncStorage.getItem(tipKey(user.id, id)).then((v) => setVisible(v !== "1")).catch(() => setVisible(false));
  }, [user?.id, id]);
  if (!visible) return null;
  const dismiss = () => {
    setVisible(false);
    if (user?.id) AsyncStorage.setItem(tipKey(user.id, id), "1").catch(() => {});
  };
  return (
    <View style={styles.box} accessibilityRole="alert">
      <Lightbulb color={theme.accent} size={16} />
      <UiText style={styles.text}>{MONEY_TIPS[id]}</UiText>
      <Pressable onPress={dismiss} hitSlop={10} accessibilityLabel="Dismiss tip"><X color={theme.textMuted} size={16} /></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(232,41,28,0.07)", borderRadius: 12, padding: 10 },
  text: { flex: 1, color: theme.text, fontSize: 13, lineHeight: 18 },
});
