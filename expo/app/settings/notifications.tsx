import React, { useEffect, useState } from "react";
import { ActivityIndicator, Switch, View } from "react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { getPushPrefs, registerForPush, setPushPrefs } from "@/lib/push";
import { DEFAULT_PUSH_PREFS, PUSH_PREF_ROWS, type PushPrefs } from "@/lib/pushCore";
import { useAuth } from "@/providers/AuthProvider";

/** Settings → Notifications: what Tryal may send to this phone. */
export default function NotificationSettingsScreen() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PUSH_PREFS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushPrefs()
      .then(setPrefs)
      .catch(() => setError("Couldn't load your settings."))
      .finally(() => setLoading(false));
  }, []);

  const change = async (patch: Partial<PushPrefs>) => {
    const before = prefs;
    setPrefs({ ...prefs, ...patch });
    setError(null);
    try {
      await setPushPrefs(patch);
      if (patch.enabled && user?.id) void registerForPush(user.id);
    } catch {
      setPrefs(before);
      setError("Couldn't save that. Try again.");
    }
  };

  const row = (label: string, value: boolean, onChange: (v: boolean) => void, disabled = false, hint?: string) => (
    <View key={label} style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", opacity: disabled ? 0.4 : 1 }}>
        <UiText style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>{label}</UiText>
        <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ false: theme.border, true: theme.accent }} thumbColor="#fff" accessibilityLabel={label} />
      </View>
      {hint ? <UiText style={s.text}>{hint}</UiText> : null}
    </View>
  );

  return (
    <SettingsScaffold title="Notifications">
      {loading ? <ActivityIndicator color={theme.accent} /> : null}
      {row("Push notifications", prefs.enabled, (v) => void change({ enabled: v }))}
      {PUSH_PREF_ROWS.map((r) => row(r.label, prefs[r.key], (v) => void change({ [r.key]: v } as Partial<PushPrefs>), !prefs.enabled, r.hint))}
      {error ? <UiText style={s.error}>{error}</UiText> : null}
      <UiText style={s.text}>Also allow notifications for Tryal in your phone's Settings.</UiText>
    </SettingsScaffold>
  );
}
