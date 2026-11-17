import React, { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { minutesLabel, usedLabel, MAX_TOTAL_SECONDS, usedSeconds } from "@/lib/footageLimits";
import { footageUploader, pickFootage, recordPickerProblem } from "@/lib/footageRuntime";
import type { UploadItem } from "@/lib/footageUpload";

/** The uploader's list, live. Restores a saved list once (an upload that was running when Tryal closed carries on). */
export function useFootage(): UploadItem[] {
  const [items, setItems] = useState<UploadItem[]>(footageUploader.list());
  useEffect(() => { const off = footageUploader.subscribe(setItems); void footageUploader.restore(); return off; }, []);
  return items;
}

/** What each row says: where the video is, in words. */
export function statusLine(i: UploadItem): string {
  if (i.state === "done") return "Ready";
  if (i.state === "error") return i.error ?? "Something went wrong with this video.";
  if (i.state === "compressing") return `Preparing the video… ${Math.round(i.progress * 300)}%`;
  if (i.state === "uploading") return i.stage === "uploading the video" ? `Uploading… ${Math.round(i.progress * 100)}%` : `${(i.stage ?? "Working").replace(/^./, (c) => c.toUpperCase())}…`;
  return "Waiting…";
}

/** Step 1 of 4: add videos from the camera roll, up to 60 minutes (30 each). Every refusal and failure is written on the screen, never an alert that can be lost. */
export default function FootageStep({ items, link, onLink, linkError }: { items: UploadItem[]; link: string; onLink: (t: string) => void; linkError?: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string[]>([]);
  const add = async () => {
    setBusy(true);
    setNotice([]);
    try {
      const { inputs, message } = await pickFootage();
      if (message) { setNotice([message]); return; }
      if (!inputs.length) return;   // cancelled
      const { added, refused } = footageUploader.add(inputs);
      const lines = refused.map((r) => `${r.name}: ${r.reason}`);
      if (!added.length && !lines.length) lines.push("No video was added.");
      if (lines.length) { setNotice(lines); recordPickerProblem(lines.join(" "), "refused before upload"); }
    } catch (e) {
      const m = `Couldn't add the video: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      setNotice([m]); recordPickerProblem(m, String(e));
    } finally { setBusy(false); }
  };
  const live = items.filter((i) => i.state !== "error");
  const active = items.filter((i) => i.state !== "done" && i.state !== "error").length;
  const full = usedSeconds(live) >= MAX_TOTAL_SECONDS;
  return (
    <View style={{ gap: 12 }}>
      <UiText style={styles.head}>{usedLabel(live)}</UiText>
      <View style={styles.bar}><View style={[styles.fill, { width: `${Math.min(100, (usedSeconds(live) / MAX_TOTAL_SECONDS) * 100)}%` }]} /></View>
      {items.map((i) => (
        <View key={i.localId} style={styles.row}>
          {i.previewUri ? <Image source={{ uri: i.previewUri }} style={styles.thumb} /> : <View style={[styles.thumb, styles.thumbEmpty]} />}
          <View style={{ flex: 1, gap: 2 }}>
            <UiText style={styles.name} numberOfLines={1}>{i.name}</UiText>
            <UiText style={styles.sub}>{i.durationSeconds > 0 ? minutesLabel(i.durationSeconds) : "length unknown yet"}</UiText>
            <UiText style={[styles.sub, i.state === "error" && { color: theme.danger }]}>{statusLine(i)}</UiText>
            {i.state === "compressing" || i.state === "uploading" ? <View style={styles.bar}><View style={[styles.fill, { width: `${Math.round(i.progress * 100)}%` }]} /></View> : null}
          </View>
          <View style={{ gap: 8, alignItems: "flex-end" }}>
            {i.state === "error" ? <Pressable onPress={() => footageUploader.retry(i.localId)} accessibilityRole="button"><UiText style={styles.link}>Retry</UiText></Pressable> : null}
            <Pressable onPress={() => void footageUploader.remove(i.localId)} accessibilityRole="button" accessibilityLabel={`Remove ${i.name}`}><UiText style={styles.link}>Remove</UiText></Pressable>
          </View>
        </View>
      ))}
      {notice.length ? <View style={styles.notice}>{notice.map((n) => <UiText key={n} style={styles.err}>{n}</UiText>)}</View> : null}
      <PrimaryButton label={items.length ? "Add more videos" : "Add videos"} onPress={add} loading={busy} disabled={full} />
      {active > 0 ? <UiText style={styles.sub}>You can carry on to the next step while your videos upload. Keep Tryal open until they are ready. If you close it, come back here to continue.</UiText> : null}
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
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: theme.border },
  thumbEmpty: { opacity: 0.5 },
  name: { color: theme.text, fontSize: 15, fontWeight: "800" as const },
  sub: { color: theme.textMuted, fontSize: 13 },
  notice: { gap: 4, borderRadius: 12, borderWidth: 1, borderColor: theme.danger, padding: 10 },
  alt: { gap: 6, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12, marginTop: 4 },
  altTitle: { color: theme.text, fontSize: 14, fontWeight: "800" as const },
  altInput: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, backgroundColor: theme.card, fontSize: 15 },
  err: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
  link: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
});
