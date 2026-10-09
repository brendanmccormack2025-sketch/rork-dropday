import React, { useState } from "react";
import { ActivityIndicator, Pressable, TextInput } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { savePhone } from "@/lib/privacy";
import { PHONE_DETAIL, PHONE_EXPLANATION } from "@/lib/privacyTexts";
import { phonePromptKey } from "@/lib/phonePrompt";

/** One-time optional step after signing up: add your phone number (or skip). */
export default function OnboardingPhone() {
  const router = useRouter();
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = async () => {
    if (user?.id) await AsyncStorage.setItem(phonePromptKey(user.id), "1").catch(() => {});
    router.replace("/(tabs)");
  };
  const save = async () => {
    setBusy(true);
    const err = await savePhone(value);
    setBusy(false);
    if (err) setError(err);
    else await done();
  };

  return (
    <SettingsScaffold title="Almost there">
      <UiText style={s.heading}>{PHONE_EXPLANATION}</UiText>
      <UiText style={s.text}>{PHONE_DETAIL}</UiText>
      <TextInput value={value} onChangeText={setValue} placeholder="+1 415 555 2671" placeholderTextColor={theme.textDim} keyboardType="phone-pad" autoComplete="tel" style={s.input} />
      {error ? <UiText style={s.error}>{error}</UiText> : null}
      <Pressable onPress={save} disabled={busy || !value.trim()} style={[s.button, (busy || !value.trim()) && { opacity: 0.5 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Save</UiText>}
      </Pressable>
      <Pressable onPress={done} style={s.secondary}>
        <UiText style={s.secondaryText}>Skip for now</UiText>
      </Pressable>
    </SettingsScaffold>
  );
}
