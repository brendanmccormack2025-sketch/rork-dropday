import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { supabase } from "@/lib/supabase";
import { HIDE_TRIALS_EXPLAINER } from "@/lib/privacyTexts";

type P = { id: string; username: string };

/** Settings → Hide my trials from…: search usernames, add or remove people. Works without contacts. */
export default function HideTrialsScreen() {
  const { user } = useAuth();
  const [hidden, setHidden] = useState<P[]>([]);
  const [results, setResults] = useState<P[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: rows } = await supabase.from("hide_from_list").select("hidden_user_id");
    const ids = ((rows ?? []) as { hidden_user_id: string }[]).map((r) => r.hidden_user_id);
    if (ids.length === 0) setHidden([]);
    else {
      const { data } = await supabase.from("profiles").select("id, username").in("id", ids);
      setHidden((data ?? []) as P[]);
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const term = q.trim().replace(/^@/, "");
    if (term.length < 2) { setResults([]); return; }
    const id = setTimeout(async () => {
      const { data } = await supabase.from("profiles").select("id, username").ilike("username", `${term}%`).limit(10);
      setResults(((data ?? []) as P[]).filter((p) => p.id !== user?.id));
    }, 250);
    return () => clearTimeout(id);
  }, [q, user?.id]);

  const add = async (p: P) => {
    if (!user?.id) return;
    await supabase.from("hide_from_list").insert({ owner_id: user.id, hidden_user_id: p.id });
    setQ("");
    await load();
  };
  const remove = async (p: P) => {
    await supabase.from("hide_from_list").delete().eq("hidden_user_id", p.id);
    await load();
  };
  const hiddenIds = new Set(hidden.map((h) => h.id));

  return (
    <SettingsScaffold title="Hide my trials from…">
      <UiText style={s.text}>{HIDE_TRIALS_EXPLAINER}</UiText>
      <TextInput value={q} onChangeText={setQ} placeholder="Search usernames" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} style={s.input} />
      {results.filter((r) => !hiddenIds.has(r.id)).map((p) => (
        <Pressable key={p.id} onPress={() => add(p)} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }}>
          <UiText style={{ color: theme.text, fontSize: 15 }}>@{p.username}</UiText>
          <UiText style={{ color: theme.accent, fontWeight: "700" }}>Add</UiText>
        </Pressable>
      ))}
      <UiText style={s.heading}>Hidden from</UiText>
      {loading ? <ActivityIndicator color={theme.accent} /> : hidden.length === 0 ? <UiText style={s.text}>Nobody yet.</UiText> : null}
      {hidden.map((p) => (
        <View key={p.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }}>
          <UiText style={{ color: theme.text, fontSize: 15 }}>@{p.username}</UiText>
          <Pressable onPress={() => remove(p)} hitSlop={8}>
            <UiText style={{ color: theme.textMuted, fontWeight: "700" }}>Remove</UiText>
          </Pressable>
        </View>
      ))}
    </SettingsScaffold>
  );
}
