import React, { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { minutesLabel, usedLabel, MAX_TOTAL_SECONDS, usedSeconds } from "@/lib/footageLimits";
import { footageUploader, pickFootage } from "@/lib/footageRuntime";
import type { UploadItem } from "@/lib/footageUpload";

/** The uploader's list, live. Restores a saved list once (an upload that was running when Tryal closed carries on). */
export function useFootage(): UploadItem[] {
  const [items, setItems] = useState<UploadItem[]>(footageUploader.list());
  useEffect(() => { const off = footageUploader.subscribe(setItems); void footageUploader.restore(); return off; }, []);
  return items;
}

const stateLabel = (i: UploadItem): string =>
  i.state === "done" ? "Ready" : i.state === "error" ? (i.error ?? "Something went wrong") : i.state === "compressing" ? `Preparing… ${Math.round(i.progress * 300)}%`
    : i.state === "uploading" ? `Uploading… ${Math.round(i.progress * 100)}%` : "Waiting…";

/** Step 1 of 4: add videos from the camera roll, up to 60 minutes (30 each). */
export default function FootageStep({ items, link, onLink, linkError }: { items: UploadItem[]; link: string; onLink: (t: string) => void; linkError?: string }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const picked = await pickFootage();
      if (!picked.length) return;
      const { refused } = footageUploader.add(picked);
      if (refused.length) Alert.alert("Some videos weren't added", refused.map((r) => `${r.name}: ${r.reason}`).join("\n"));
    } finally { setBusy(false); }
  };
  const active = items.filter((i) => i.state !== "done" && i.state !== "error").length;
  const full = usedSeconds(items.filter((i) => i.state !== "error")) >= MAX_TOTAL_SECONDS;
  return (
    <View style={{ gap: 12 }}>
      <UiText style={styles.head}>{usedLabel(items.filter((i) => i.state !== "error"))}</UiText>
      <View style={styles.bar}><View style={[styles.fill, { width: `${Math.min(100, (usedSeconds(items.filter((i) => i.state !== "error")) / MAX_TOTAL_SECONDS) * 100)}%` }]} /></View>
      {items.map((i) => (
        <View key={i.localId} style={styles.row}>
          <View style={{ flex: 1, gap: 2 }}>
            <UiText style={styles.name} numberOfLines={1}>{i.name}</UiText>
            <UiText style={[styles.sub, i.state === "error" && { color: theme.danger }]}>{minutesLabel(i.durationSeconds)} · {stateLabel(i)}</UiText>
            {i.state === "compressing" || i.state === "uploading" ? <View style={styles.bar}><View style={[styles.fill, { width: `${Math.round(i.progress * 100)}%` }]} /></View> : null}
          </View>
          {i.state === "error" ? <Pressable onPress={() => footageUploader.retry(i.localId)} accessibilityRole="button"><UiText style={styles.link}>Retry</UiText></Pressable> : null}
          <Pressable onPress={() => void footageUploader.remove(i.localId)} accessibilityRole="button" accessibilityLabel={`Remove ${i.name}`}><UiText style={styles.link}>Remove</UiText></Pressable>
        </View>
      ))}
      <PrimaryButton label={items.length ? "Add more videos" : "Add videos"} onPress={add} loading={busy} disabled={full} />
      {active > 0 ? <UiText style={styles.sub}>Keep Tryal open while your videos upload. If you close it, tap Add videos or come back here to continue.</UiText> : null}
      <UiText style={styles.sub}>Up to 60 minutes in total, 30 minutes each (2 GB per video). We delete them 14 days after your campaign closes.</UiText>
      <View style={styles.alt}>
        <UiText style={styles.altTitle}>Or paste a Google Drive / Dropbox link (optional)</UiText>
        <TextInput value={link} onChangeText={onLink} placeholder="https://drive.google.com/…" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.altInput} accessibilityLabel="Google Drive or Dropbox link" />
        <UiText style={styles.sub}>Use this mainly for footage longer than the upload limit. Only clippers who join see the link. Uploading is the main way.</UiText>
        {linkError ? <UiText style={styles.err}>{linkError}</UiText> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { color: theme.text, fontSize: 18, fontWeight: "900" as const },
  bar: { height: 6, borderRadius: 3, backgroundColor: theme.border, overflow: "hidden" },
  fill: { height: 6, backgroundColor: theme.accent },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 },
  name: { color: theme.text, fontSize: 15, fontWeight: "800" as const },
  sub: { color: theme.textMuted, fontSize: 13 },
  alt: { gap: 6, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12, marginTop: 4 },
  altTitle: { color: theme.text, fontSize: 14, fontWeight: "800" as const },
  altInput: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, backgroundColor: theme.card, fontSize: 15 },
  err: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
  link: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
});
