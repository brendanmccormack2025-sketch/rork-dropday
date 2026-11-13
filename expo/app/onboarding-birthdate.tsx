import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { CalendarDays } from "lucide-react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { BIRTHDATE_WHY, parseBirthdate } from "@/lib/birthdate";
import { saveMyBirthdate } from "@/lib/moneyFeatures";

/** Asked once, on the first Money visit (people who signed up before Money have no birthdate). The server stores it once and checks it. */
export default function OnboardingBirthdate() {
  const router = useRouter();
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [year, setYear] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dayRef = useRef<TextInput>(null);
  const yearRef = useRef<TextInput>(null);

  const save = async () => {
    setError(null);
    const parsed = parseBirthdate(month, day, year);
    if (!parsed.ok) { setError(parsed.error); return; }
    setBusy(true);
    const res = await saveMyBirthdate(parsed.iso);
    setBusy(false);
    if ("error" in res) { setError(res.error); return; }
    if (res.tier !== "adult") { setError("Money is only for people 18 and over."); return; }
    router.back();
  };

  const input = [s.input, { flex: 1, textAlign: "center" as const }];
  return (
    <SettingsScaffold title="Your birthdate">
      <View style={s.iconBadge}>
        <CalendarDays color={theme.accent} size={32} strokeWidth={2.2} />
      </View>
      <UiText style={[s.heading, s.center]}>Confirm you're 18 or older</UiText>
      <UiText style={[s.text, s.center]}>{BIRTHDATE_WHY}</UiText>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput value={month} onChangeText={(t) => { setMonth(t.replace(/\D/g, "").slice(0, 2)); if (t.length >= 2) dayRef.current?.focus(); }} placeholder="MM" placeholderTextColor={theme.textDim} keyboardType="number-pad" maxLength={2} style={input} accessibilityLabel="Birth month" />
        <TextInput ref={dayRef} value={day} onChangeText={(t) => { setDay(t.replace(/\D/g, "").slice(0, 2)); if (t.length >= 2) yearRef.current?.focus(); }} placeholder="DD" placeholderTextColor={theme.textDim} keyboardType="number-pad" maxLength={2} style={input} accessibilityLabel="Birth day" />
        <TextInput ref={yearRef} value={year} onChangeText={(t) => setYear(t.replace(/\D/g, "").slice(0, 4))} placeholder="YYYY" placeholderTextColor={theme.textDim} keyboardType="number-pad" maxLength={4} style={[input, { flex: 1.4 }]} accessibilityLabel="Birth year" />
      </View>
      {error ? <UiText style={s.error}>{error}</UiText> : null}
      <Pressable onPress={save} disabled={busy} style={[s.button, busy && { opacity: 0.5 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Save</UiText>}
      </Pressable>
    </SettingsScaffold>
  );
}
