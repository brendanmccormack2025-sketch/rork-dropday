import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { cleanUpNow, storageReport } from "@/lib/storageCleanup";
import { formatBytes, type StorageReport } from "@/lib/storageCleanupCore";

/** What the rows mean, in the order shown. "Temporary" rows are what Free up space can delete. */
const ROWS: Array<{ key: keyof Omit<StorageReport, "totalBytes">; label: string; temporary: boolean }> = [
  { key: "drafts", label: "Drafts", temporary: false },
  { key: "camera", label: "Camera recordings", temporary: true },
  { key: "picker", label: "Videos picked from your library", temporary: true },
  { key: "renders", label: "Edited and merged videos", temporary: true },
  { key: "uploads", label: "Copies waiting to upload", temporary: true },
  { key: "thumbnails", label: "Cover images", temporary: true },
  { key: "tmp", label: "Audio and other work files", temporary: true },
  { key: "otherCache", label: "Image and app cache", temporary: false },
  { key: "otherDocs", label: "Other app data", temporary: false },
];

/** Settings → Storage: how much space Tryal's files take on this phone, and a button to free the temporary ones. */
export default function StorageScreen() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setReport(await storageReport().catch(() => null));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const free = async () => {
    setBusy(true);
    setMessage(null);
    const r = await cleanUpNow();
    await load();
    setBusy(false);
    setMessage(
      r.removedFiles > 0
        ? `Freed ${formatBytes(r.removedBytes)} (${r.removedFiles} file${r.removedFiles === 1 ? "" : "s"}).`
        : "Nothing to free right now.",
    );
  };

  return (
    <SettingsScaffold title="Storage">
      <UiText style={s.text}>
        Space Tryal's files use on this phone. Drafts and posts still uploading are never deleted. Files from the last 15 minutes are kept while you work.
      </UiText>
      {!report ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <View style={{ gap: 10 }}>
          {ROWS.map((r) => (
            <View key={r.key} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
              <UiText style={[s.text, { color: theme.text, flex: 1 }]}>{r.label}</UiText>
              <UiText style={[s.text, { color: theme.text, fontWeight: "700" as const }]}>{formatBytes(report[r.key].bytes)}</UiText>
            </View>
          ))}
          <View style={{ flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderColor: theme.border, paddingTop: 10 }}>
            <UiText style={[s.text, { color: theme.text, fontWeight: "800" as const }]}>Total</UiText>
            <UiText style={[s.text, { color: theme.text, fontWeight: "800" as const }]}>{formatBytes(report.totalBytes)}</UiText>
          </View>
        </View>
      )}
      <Pressable onPress={free} disabled={busy || !report} style={({ pressed }) => [s.button, (pressed || busy) && { opacity: 0.6 }]}>
        {busy ? <ActivityIndicator color="#fff" /> : <UiText style={s.buttonText}>Free up space</UiText>}
      </Pressable>
      {message ? <UiText style={s.ok}>{message}</UiText> : null}
    </SettingsScaffold>
  );
}
