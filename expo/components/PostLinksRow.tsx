import React from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { parseVideoLink } from "@/lib/creatorLinks";

export type LinksMode = "socials" | "video";

type Props = { mode: LinksMode; onMode: (m: LinksMode) => void; text: string; onText: (t: string) => void };

/** The composer's "Links" row: "My socials" (the default: your profile's links, as today) or "A specific video" (one link). */
export default function PostLinksRow({ mode, onMode, text, onText }: Props) {
  const parsed = mode === "video" && text.trim() ? parseVideoLink(text) : null;
  return (
    <View style={styles.wrap}>
      <UiText style={styles.label}>Links</UiText>
      <View style={styles.choices}>
        {([["socials", "My socials"], ["video", "A specific video"]] as Array<[LinksMode, string]>).map(([k, label]) => (
          <Pressable key={k} onPress={() => onMode(k)} style={[styles.chip, mode === k && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: mode === k }}>
            <UiText style={[styles.chipText, mode === k && styles.chipTextOn]}>{label}</UiText>
          </Pressable>
        ))}
      </View>
      {mode === "socials" ? <UiText style={styles.hint}>Shows the links on your profile.</UiText> : (
        <>
          <TextInput
            value={text}
            onChangeText={onText}
            placeholder="Paste a YouTube, TikTok, Instagram, X, Twitch or Spotify link"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            accessibilityLabel="Video link"
          />
          {parsed && !parsed.ok ? <UiText style={styles.error}>{parsed.error}</UiText> : parsed && parsed.ok ? <UiText style={styles.hint}>Your post will show "Watch on {parsed.label}".</UiText> : <UiText style={styles.hint}>Taps on the button are counted. We never see who tapped.</UiText>}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingVertical: 8 },
  label: { color: theme.text, fontSize: 15, fontWeight: "700" as const },
  choices: { flexDirection: "row", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipOn: { borderColor: theme.accent, backgroundColor: "rgba(232,41,28,0.08)" },
  chipText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  chipTextOn: { color: theme.accent },
  input: { borderWidth: 1.5, borderColor: theme.border, backgroundColor: theme.card, color: theme.text, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  hint: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
  error: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
});
