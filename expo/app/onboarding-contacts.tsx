import React, { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Users } from "lucide-react-native";
import { theme } from "@/constants/theme";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { contactsPromptKey } from "@/lib/phonePrompt";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { useAuth } from "@/providers/AuthProvider";
import { enableContacts } from "@/lib/contacts";
import { CONTACTS_ONBOARDING_BODY, CONTACTS_ONBOARDING_TITLE } from "@/lib/privacyTexts";

/**
 * Right after the phone step, once per account: contacts are what keeps people you know away from your testing posts,
 * so they are explained here, and Continue ALWAYS shows the system prompt (Apple 5.1.1(iv): no "Not now" and no way to
 * close this message before the prompt). The user says no in the system prompt itself; the app works without contacts.
 */
export default function OnboardingContacts() {
  const router = useRouter();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  const finish = () => {
    if (user?.id) void AsyncStorage.setItem(contactsPromptKey(user.id), "1").catch(() => {});
    router.replace("/(tabs)");
  };
  const allow = async () => {
    if (!user?.id) return finish();
    setBusy(true);
    try {
      await enableContacts(user.id); // the system prompt; a "no" is respected
    } catch {
      // never blocks sign-up
    }
    setBusy(false);
    finish();
  };

  return (
    <SettingsScaffold title="Keep it private" hideBack>
      <View style={s.iconBadge}>
        <Users color={theme.accent} size={32} strokeWidth={2.2} />
      </View>
      <UiText style={[s.heading, s.center]}>{CONTACTS_ONBOARDING_TITLE}</UiText>
      <UiText style={[s.text, s.center]}>{CONTACTS_ONBOARDING_BODY}</UiText>
      <Pressable onPress={allow} disabled={busy} style={[s.button, busy && { opacity: 0.6 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Continue</UiText>}
      </Pressable>
    </SettingsScaffold>
  );
}
