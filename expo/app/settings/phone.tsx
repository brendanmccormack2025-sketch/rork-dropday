import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { getPrivacyStatus, removePhone, savePhone } from "@/lib/privacy";
import { PHONE_DETAIL, PHONE_EXPLANATION } from "@/lib/privacyTexts";

/** Settings → Your phone number. Optional; stored only as a hash; used only to keep your trials from your contacts. */
export default function PhoneScreen() {
  const [value, setValue] = useState("");
  const [hasPhone, setHasPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    getPrivacyStatus().then((st) => setHasPhone(!!st?.has_phone));
  }, []);

  const save = async () => {
    setBusy(true);
    const err = await savePhone(value);
    setBusy(false);
    if (err) setMsg({ text: err, error: true });
    else {
      setValue("");
      setHasPhone(true);
      setMsg({ text: "Saved.", error: false });
    }
  };
  const remove = async () => {
    setBusy(true);
    const ok = await removePhone();
    setBusy(false);
    if (ok) setHasPhone(false);
    setMsg(ok ? { text: "Removed.", error: false } : { text: "Couldn't remove it. Try again.", error: true });
  };

  return (
    <SettingsScaffold title="Your phone number">
      <UiText style={s.heading}>{PHONE_EXPLANATION}</UiText>
      <UiText style={s.text}>{PHONE_DETAIL}</UiText>
      <UiText style={s.text}>{hasPhone ? "A number is saved. Enter a new one to replace it." : "Optional, but it helps."}</UiText>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="+1 415 555 2671"
        placeholderTextColor={theme.textDim}
        keyboardType="phone-pad"
        autoComplete="tel"
        style={s.input}
      />
      {msg ? <UiText style={msg.error ? s.error : s.ok}>{msg.text}</UiText> : null}
      <Pressable onPress={save} disabled={busy || value.trim().length === 0} style={[s.button, (busy || !value.trim()) && { opacity: 0.5 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Save</UiText>}
      </Pressable>
      {hasPhone ? (
        <Pressable onPress={remove} disabled={busy} style={s.secondary}>
          <UiText style={s.secondaryText}>Remove my number</UiText>
        </Pressable>
      ) : null}
      <View />
    </SettingsScaffold>
  );
}
