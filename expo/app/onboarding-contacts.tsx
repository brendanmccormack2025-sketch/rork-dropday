import React, { useState } from "react";
import { ActivityIndicator, Pressable } from "react-native";
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
 * so they are asked for here, plainly and prominently. Apple requires the app to work without them, so "Not now" stays.
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
    <SettingsScaffold title="Keep it private">
      <UiText style={s.heading}>{CONTACTS_ONBOARDING_TITLE}</UiText>
      <UiText style={s.text}>{CONTACTS_ONBOARDING_BODY}</UiText>
      <Pressable onPress={allow} disabled={busy} style={[s.button, busy && { opacity: 0.6 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Allow contacts</UiText>}
      </Pressable>
      <Pressable onPress={finish} hitSlop={8} style={{ alignItems: "center", paddingVertical: 10 }}>
        <UiText style={s.text}>Not now</UiText>
      </Pressable>
    </SettingsScaffold>
  );
}
