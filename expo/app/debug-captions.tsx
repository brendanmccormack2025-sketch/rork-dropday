import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import { groupWordsIntoLines, type CaptionLine } from "@/lib/captions";
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import { transcribeAsync, type TranscriptionResult } from "@/modules/speech-captions";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Hidden developer screen: pick a video, transcribe it on the phone (Speech
 * framework, on-device only) and show the caption lines it would produce. No
 * editor, no posting, no upload. Reachable only by long-pressing a row in
 * Settings, as the owner user.
 */

type Report = {
  fileName: string;
  transcription: TranscriptionResult;
  transcribeMs: number;
  lines: CaptionLine[];
};

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildText(r: Report): string {
  const t = r.transcription;
  const lines: string[] = [];
  lines.push(`file: ${r.fileName}`);
  lines.push(`locale: ${t.locale}  on-device: ${t.onDevice ? "yes" : "no"}`);
  lines.push(`duration: ${sec(t.durationMs)}  transcription time: ${r.transcribeMs} ms  words: ${t.words.length}`);
  lines.push("");
  lines.push("caption lines (start - end):");
  if (r.lines.length === 0) lines.push("  none");
  for (const l of r.lines) {
    lines.push(`  ${sec(l.startMs)} - ${sec(l.endMs)}  ${l.text}`);
  }
  return lines.join("\n");
}

export default function DebugCaptionsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [busy, setBusy] = useState<"picking" | "transcribing" | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const pickAndTranscribe = useCallback(async () => {
    if (busy) return;
    setError(null);
    setNote(null);
    setReport(null);
    setRetryNote(null);
    setBusy("picking");
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photo library access needed",
          "Allow access to your photo library to pick a video.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                if (Platform.OS === "ios") Linking.openURL("app-settings:").catch(() => {});
                else Linking.openSettings().catch(() => {});
              },
            },
          ],
        );
        return;
      }

      const picked = await launchLibraryWithRetry(
        {
          mediaTypes: ["videos"],
          allowsMultipleSelection: false,
          quality: 1,
          // Same as PostChoiceSheet: iCloud-hosted assets need this.
          shouldDownloadFromNetwork: true,
        },
        (attempt) => setRetryNote(`Still downloading from iCloud (attempt ${attempt})…`),
      );
      const asset = picked.canceled ? undefined : picked.assets[0];
      if (!asset) return;

      setBusy("transcribing");
      const startedAt = Date.now();
      const transcription = await transcribeAsync(asset.uri);
      const transcribeMs = Date.now() - startedAt;

      if (!transcription) {
        setNote(
          Platform.OS === "ios"
            ? "No audio track in this video."
            : "Transcription only exists in iOS builds (returned null).",
        );
        return;
      }

      setReport({
        fileName: asset.fileName ?? asset.uri.split("/").pop() ?? asset.uri,
        transcription,
        transcribeMs,
        lines: groupWordsIntoLines(transcription.words),
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const message = e instanceof Error ? e.message : String(e);
      setError(code ? `${code}: ${message}` : message);
    } finally {
      setBusy(null);
      setRetryNote(null);
    }
  }, [busy]);

  const copyAsText = useCallback(async () => {
    if (!report) return;
    try {
      // The iOS share sheet has a "Copy" action; no clipboard dependency needed.
      await Share.share({ message: buildText(report) });
    } catch {
      // Dismissed or failed — nothing to do.
    }
  }, [report]);

  // Deep links can reach any route, so gate here as well as in settings.
  if (!isDebugOwner(user?.id)) {
    return <Redirect href="/(tabs)" />;
  }

  const t = report?.transcription;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>Captions debug</UiText>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            onPress={pickAndTranscribe}
            disabled={busy !== null}
            style={({ pressed }) => [styles.primaryBtn, (pressed || busy) && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <UiText style={styles.primaryBtnText}>Pick a video</UiText>
            )}
          </Pressable>
          {busy ? (
            <UiText style={styles.muted}>
              {busy === "picking" ? "Waiting for the picker…" : "Transcribing on this phone…"}
              {retryNote ? ` ${retryNote}` : ""}
            </UiText>
          ) : null}

          {error ? <UiText style={styles.error}>{error}</UiText> : null}
          {note ? <UiText style={styles.muted}>{note}</UiText> : null}

          {report && t ? (
            <>
              <UiText style={styles.sectionLabel}>Summary</UiText>
              <View style={styles.card}>
                <UiText style={styles.line}>File: {report.fileName}</UiText>
                <UiText style={styles.line}>Locale: {t.locale}</UiText>
                <UiText style={styles.line}>On-device: {t.onDevice ? "yes" : "no"}</UiText>
                <UiText style={styles.line}>Duration: {sec(t.durationMs)}</UiText>
                <UiText style={styles.line}>Transcription took: {report.transcribeMs} ms</UiText>
                <UiText style={styles.line}>Words: {t.words.length}</UiText>
              </View>

              <UiText style={styles.sectionLabel}>Caption lines</UiText>
              <View style={styles.card}>
                {report.lines.length === 0 ? (
                  <UiText style={styles.line}>No speech found.</UiText>
                ) : (
                  report.lines.map((l) => (
                    <UiText key={l.startMs} style={styles.line}>
                      {sec(l.startMs)} – {sec(l.endMs)}  {l.text}
                    </UiText>
                  ))
                )}
              </View>

              <Pressable
                onPress={copyAsText}
                style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }]}
              >
                <UiText style={styles.secondaryBtnText}>Copy as text</UiText>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  content: { padding: 16, gap: 12 },
  primaryBtn: {
    backgroundColor: theme.accent,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" as const },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryBtnText: { color: theme.text, fontSize: 15, fontWeight: "700" as const },
  sectionLabel: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 4,
  },
  card: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    gap: 6,
  },
  line: { color: theme.text, fontSize: 13 },
  muted: { color: theme.textMuted, fontSize: 12 },
  error: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
});
