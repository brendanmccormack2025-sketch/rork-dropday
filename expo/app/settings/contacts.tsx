import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable } from "react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { useAuth } from "@/providers/AuthProvider";
import { enableContacts, isContactsAvailable, isContactsEnabled, removeContactsData } from "@/lib/contacts";
import { CONTACTS_EXPLAINER_BODY, CONTACTS_EXPLAINER_TITLE } from "@/lib/privacyTexts";

/** Settings → Contacts: explainer first, then the system prompt. Fully optional; "Remove my contacts data" undoes it. */
export default function ContactsScreen() {
  const { user } = useAuth();
  const available = isContactsAvailable();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id) isContactsEnabled(user.id).then(setEnabled);
  }, [user?.id]);

  if (!available) {
    return (
      <SettingsScaffold title="Contacts">
        <UiText style={s.text}>Contacts matching isn't available in this version of the app. Update Trial to use it.</UiText>
      </SettingsScaffold>
    );
  }

  const allow = async () => {
    if (!user?.id) return;
    setBusy(true);
    const r = await enableContacts(user.id);
    setBusy(false);
    setEnabled(r === "granted");
    setMsg(r === "granted" ? "Done. Your contacts are checked in the background." : r === "denied" ? "No problem. Trial works fully without it." : "Not available in this version.");
  };
  const remove = () => {
    Alert.alert("Remove my contacts data", "This deletes the contact hashes Trial stored for you.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          if (!user?.id) return;
          setBusy(true);
          const ok = await removeContactsData(user.id);
          setBusy(false);
          setEnabled(false);
          setMsg(ok ? "Your contacts data was removed." : "Couldn't remove it. Try again.");
        },
      },
    ]);
  };

  return (
    <SettingsScaffold title="Contacts">
      <UiText style={s.heading}>{CONTACTS_EXPLAINER_TITLE}</UiText>
      <UiText style={s.text}>{CONTACTS_EXPLAINER_BODY}</UiText>
      {msg ? <UiText style={s.ok}>{msg}</UiText> : null}
      {!enabled ? (
        <Pressable onPress={allow} disabled={busy} style={[s.button, busy && { opacity: 0.5 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Continue</UiText>}
        </Pressable>
      ) : null}
      <Pressable onPress={remove} disabled={busy} style={s.secondary}>
        <UiText style={s.secondaryText}>Remove my contacts data</UiText>
      </Pressable>
    </SettingsScaffold>
  );
}
