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
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import { detectSilences, type SilenceDetectionResult } from "@/lib/silenceDetection";
import { getLoudnessAsync } from "@/modules/audio-loudness";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Hidden developer screen: pick a video, read its loudness on-device, and show
 * the silences the detector would propose. No editor, no posting, no upload.
 * Reachable only by long-pressing a row in Settings, as the owner user.
 */

const WINDOW_MS = 50;
const BAR_COUNT = 100;
const BAR_AREA_HEIGHT = 90;
/** dB range drawn by the bar view. */
const BAR_MIN_DB = -80;
const BAR_MAX_DB = 0;

type Report = {
  fileName: string;
  durationMs: number;
  analysisMs: number;
  windowCount: number;
  windows: number[];
  detection: SilenceDetectionResult;
};

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildText(r: Report): string {
  const d = r.detection;
  const lines: string[] = [];
  lines.push(`file: ${r.fileName}`);
  lines.push(`duration: ${sec(r.durationMs)}  windows: ${r.windowCount} x ${WINDOW_MS} ms  analysis time: ${r.analysisMs} ms`);
  lines.push(`noise floor: ${d.noiseFloorDb.toFixed(1)} dB  threshold: ${d.thresholdDb.toFixed(1)} dB  skip: ${d.skipReason ?? "none"}`);
  lines.push(`time saved: ${sec(d.savedMs)}  cuts: ${d.cuts.length}`);
  lines.push("");
  lines.push("silences (start - end, length):");
  if (d.silences.length === 0) lines.push("  none");
  for (const s of d.silences) {
    lines.push(`  ${sec(s.startMs)} - ${sec(s.endMs)}  ${sec(s.lengthMs)}  ${s.cut ? "CUT" : "not cut"}`);
  }
  lines.push("");
  lines.push("keep ranges:");
  for (const k of d.keepRanges) {
    lines.push(`  ${sec(k.startMs)} - ${sec(k.endMs)}  ${sec(k.lengthMs)}`);
  }
  lines.push("");
  const perHalfSecond = Math.max(1, Math.round(500 / WINDOW_MS));
  const coarse: string[] = [];
  for (let i = 0; i < r.windows.length; i += perHalfSecond) {
    let max = -Infinity;
    for (let j = i; j < Math.min(r.windows.length, i + perHalfSecond); j++) {
      max = Math.max(max, r.windows[j]!);
    }
    coarse.push(max.toFixed(0));
  }
  lines.push("loudness dB, max per 0.5 s:");
  lines.push(coarse.join(","));
  return lines.join("\n");
}

function LoudnessBars({ report }: { report: Report }) {
  const { windows, durationMs, detection } = report;
  const perBar = Math.max(1, Math.ceil(windows.length / BAR_COUNT));
  const barCount = Math.ceil(windows.length / perBar);
  const range = BAR_MAX_DB - BAR_MIN_DB;
  const thresholdPct = Math.min(1, Math.max(0, (detection.thresholdDb - BAR_MIN_DB) / range));

  const bars: React.ReactNode[] = [];
  for (let b = 0; b < barCount; b++) {
    let max = -Infinity;
    for (let j = b * perBar; j < Math.min(windows.length, (b + 1) * perBar); j++) {
      max = Math.max(max, windows[j]!);
    }
    const centerMs = (b * perBar + perBar / 2) * WINDOW_MS;
    const inCut = detection.cuts.some((c) => centerMs >= c.startMs && centerMs <= c.endMs);
    const quiet = max < detection.thresholdDb;
    const pct = Math.min(1, Math.max(0.02, (max - BAR_MIN_DB) / range));
    bars.push(
      <View
        key={b}
        style={{
          flex: 1,
          height: `${pct * 100}%`,
          marginHorizontal: 0.5,
          backgroundColor: inCut ? theme.accent : quiet ? theme.textDim : theme.text,
        }}
      />,
    );
  }

  return (
    <View>
      <View style={styles.barArea}>
        {bars}
        <View
          pointerEvents="none"
          style={[styles.thresholdLine, { bottom: `${thresholdPct * 100}%` }]}
        />
      </View>
      <View style={styles.barLabels}>
        <UiText style={styles.muted}>0s</UiText>
        <UiText style={styles.muted}>{sec(durationMs)}</UiText>
      </View>
      <UiText style={styles.muted}>
        Red = proposed cut. Grey = below threshold. Line = threshold ({detection.thresholdDb.toFixed(1)} dB).
        Bars span {BAR_MIN_DB} to {BAR_MAX_DB} dB.
      </UiText>
    </View>
  );
}

export default function DebugSilenceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [busy, setBusy] = useState<"picking" | "analyzing" | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const pickAndAnalyze = useCallback(async () => {
    if (busy) return;
    setError(null);
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

      setBusy("analyzing");
      const startedAt = Date.now();
      const loudness = await getLoudnessAsync(asset.uri, WINDOW_MS);
      const analysisMs = Date.now() - startedAt;

      if (!loudness) {
        setError(
          Platform.OS === "ios"
            ? "No audio track in this video."
            : "Loudness analysis only exists in iOS builds (returned null).",
        );
        return;
      }

      const detection = detectSilences(loudness.windows, WINDOW_MS, {
        durationMs: loudness.durationMs,
      });
      setReport({
        fileName: asset.fileName ?? asset.uri.split("/").pop() ?? asset.uri,
        durationMs: loudness.durationMs,
        analysisMs,
        windowCount: loudness.windows.length,
        windows: loudness.windows,
        detection,
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

  const d = report?.detection;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>Silence debug</UiText>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            onPress={pickAndAnalyze}
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
              {busy === "picking" ? "Waiting for the picker…" : "Reading audio…"}
              {retryNote ? ` ${retryNote}` : ""}
            </UiText>
          ) : null}

          {error ? <UiText style={styles.error}>{error}</UiText> : null}

          {report && d ? (
            <>
              <UiText style={styles.sectionLabel}>Summary</UiText>
              <View style={styles.card}>
                <UiText style={styles.line}>File: {report.fileName}</UiText>
                <UiText style={styles.line}>Duration: {sec(report.durationMs)}</UiText>
                <UiText style={styles.line}>
                  Analysis: {report.analysisMs} ms ({report.windowCount} windows of {WINDOW_MS} ms)
                </UiText>
                <UiText style={styles.line}>Noise floor: {d.noiseFloorDb.toFixed(1)} dB</UiText>
                <UiText style={styles.line}>Threshold: {d.thresholdDb.toFixed(1)} dB</UiText>
                <UiText style={styles.line}>
                  Time saved: {sec(d.savedMs)} ({d.cuts.length} cut{d.cuts.length === 1 ? "" : "s"})
                </UiText>
                {d.skipReason ? (
                  <UiText style={styles.line}>Skipped: {d.skipReason}</UiText>
                ) : d.silences.length === 0 ? (
                  <UiText style={styles.line}>Nothing worth changing was found.</UiText>
                ) : null}
              </View>

              <UiText style={styles.sectionLabel}>Loudness over time</UiText>
              <View style={styles.card}>
                <LoudnessBars report={report} />
              </View>

              <UiText style={styles.sectionLabel}>Silences</UiText>
              <View style={styles.card}>
                {d.silences.length === 0 ? (
                  <UiText style={styles.line}>None</UiText>
                ) : (
                  d.silences.map((s) => (
                    <UiText key={s.startMs} style={styles.line}>
                      {sec(s.startMs)} – {sec(s.endMs)}  ({sec(s.lengthMs)})  {s.cut ? "CUT" : "not cut"}
                    </UiText>
                  ))
                )}
              </View>

              <UiText style={styles.sectionLabel}>Keep ranges</UiText>
              <View style={styles.card}>
                {d.keepRanges.map((k) => (
                  <UiText key={k.startMs} style={styles.line}>
                    {sec(k.startMs)} – {sec(k.endMs)}  ({sec(k.lengthMs)})
                  </UiText>
                ))}
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
  barArea: {
    height: BAR_AREA_HEIGHT,
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: theme.bg,
  },
  thresholdLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: theme.accent,
    opacity: 0.8,
  },
  barLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
});
