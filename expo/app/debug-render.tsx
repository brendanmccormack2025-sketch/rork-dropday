import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import { Asset } from "expo-asset";
import * as ImagePicker from "expo-image-picker";
import { VideoView, useVideoPlayer } from "expo-video";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import type { EditInstructions } from "@/lib/editModel";
import { toRenderJson } from "@/lib/editStyles";
import { saveToLibraryAsync, useMediaLibraryPermissions } from "@/lib/mediaLibraryCompat";
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import {
  addRenderProgressListener,
  cancelRender,
  renderAsync,
  type RenderOptions,
  type RenderResult,
} from "@/modules/video-render";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Hidden developer screen: pick a video, render a built-in sample edit (two
 * cuts, a caption, a Hook text, an image, a sound effect) into one mp4 on this
 * phone, and play the result. Nothing is posted or uploaded. Reachable only by
 * long-pressing a row in Settings, as the owner user.
 */

type Picked = { fileName: string; uri: string; durationMs: number };
type Outcome = { result: RenderResult; renderMs: number };

const SAMPLE_PNG = require("../assets/debug/test-overlay.png") as number;
const SAMPLE_WAV = require("../assets/debug/test-sfx.wav") as number;

async function localUri(module: number): Promise<string> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  return asset.localUri ?? asset.uri;
}

/** Two cuts of the picked video, plus one overlay of every kind. */
async function buildSample(picked: Picked): Promise<EditInstructions> {
  const d = picked.durationMs;
  const len = Math.max(500, Math.min(3000, Math.floor(d * 0.4)));
  const secondStart = Math.max(len, Math.floor(d * 0.5));
  const secondEnd = Math.min(d, secondStart + len);
  const total = len + (secondEnd - secondStart);
  return {
    version: 1,
    clips: [
      { uri: picked.uri, trimStartMs: 0, trimEndMs: len },
      { uri: picked.uri, trimStartMs: secondStart, trimEndMs: secondEnd },
    ],
    overlays: [
      { kind: "caption", text: "This is a caption test", style: "clean", startMs: 200, endMs: Math.max(400, total - 200) },
      { kind: "text", text: "Hook text", style: "hook", startMs: 0, endMs: Math.min(1800, total) },
      { kind: "image", uri: await localUri(SAMPLE_PNG), startMs: Math.min(500, total), endMs: total },
      { kind: "sfx", uri: await localUri(SAMPLE_WAV), startMs: len, volume: 0.8 },
    ],
  };
}

function ResultPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.loop = true;
    p.play();
  });
  return <VideoView player={player} style={styles.video} contentFit="contain" nativeControls />;
}

export default function DebugRenderScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [, requestLibraryPermission] = useMediaLibraryPermissions({ get: false });
  const [punchIn, setPunchIn] = useState(false);
  const [uploadSize, setUploadSize] = useState(false);
  const [busy, setBusy] = useState<"picking" | "rendering" | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    const sub = addRenderProgressListener((e) => setProgress(e.progress));
    return () => sub.remove();
  }, []);

  const pickAndRender = useCallback(async () => {
    if (busy) return;
    setError(null);
    setOutcome(null);
    setSaveNote(null);
    setRetryNote(null);
    setProgress(0);
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

      const result = await launchLibraryWithRetry(
        {
          mediaTypes: ["videos"],
          allowsMultipleSelection: false,
          quality: 1,
          // Same as PostChoiceSheet: iCloud-hosted assets need this.
          shouldDownloadFromNetwork: true,
        },
        (attempt) => setRetryNote(`Still downloading from iCloud (attempt ${attempt})…`),
      );
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset) return;
      const picked: Picked = {
        fileName: asset.fileName ?? asset.uri.split("/").pop() ?? asset.uri,
        uri: asset.uri,
        durationMs: Math.round(asset.duration ?? 0),
      };
      if (picked.durationMs < 1500) {
        setError("The sample needs a video of at least 1.5 seconds.");
        return;
      }

      setBusy("rendering");
      const options: RenderOptions = uploadSize
        ? { width: 720, height: 1280, bitrate: 3_500_000, punchIn }
        : { punchIn };
      const startedAt = Date.now();
      const rendered = await renderAsync(toRenderJson(await buildSample(picked)), options);
      setOutcome({ result: rendered, renderMs: Date.now() - startedAt });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const message = e instanceof Error ? e.message : String(e);
      setError(code ? `${code}: ${message}` : message);
    } finally {
      setBusy(null);
      setRetryNote(null);
    }
  }, [busy, punchIn, uploadSize]);

  const saveToCameraRoll = useCallback(async () => {
    if (!outcome) return;
    try {
      const permission = await requestLibraryPermission();
      if (!permission.granted) {
        setSaveNote("Photo library permission was not granted.");
        return;
      }
      await saveToLibraryAsync(outcome.result.uri);
      setSaveNote("Saved to your camera roll.");
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : "Could not save.");
    }
  }, [outcome, requestLibraryPermission]);

  // Deep links can reach any route, so gate here as well as in settings.
  if (!isDebugOwner(user?.id)) {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>Render debug</UiText>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <UiText style={styles.line}>Punch in (108% on every second segment)</UiText>
              <Switch
                value={punchIn}
                onValueChange={setPunchIn}
                disabled={busy !== null}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor="#fff"
                ios_backgroundColor={theme.border}
              />
            </View>
            <View style={styles.switchRow}>
              <UiText style={styles.line}>Upload size (720x1280, 3.5 Mbps)</UiText>
              <Switch
                value={uploadSize}
                onValueChange={setUploadSize}
                disabled={busy !== null}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor="#fff"
                ios_backgroundColor={theme.border}
              />
            </View>
          </View>

          <Pressable
            onPress={pickAndRender}
            disabled={busy !== null}
            style={({ pressed }) => [styles.primaryBtn, (pressed || busy) && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <UiText style={styles.primaryBtnText}>Pick a video and render the sample</UiText>
            )}
          </Pressable>
          {busy ? (
            <>
              <UiText style={styles.muted}>
                {busy === "picking"
                  ? "Waiting for the picker…"
                  : `Rendering on this phone… ${Math.round(progress * 100)}%`}
                {retryNote ? ` ${retryNote}` : ""}
              </UiText>
              {busy === "rendering" ? (
                <Pressable
                  onPress={cancelRender}
                  style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }]}
                >
                  <UiText style={styles.secondaryBtnText}>Cancel render</UiText>
                </Pressable>
              ) : null}
            </>
          ) : null}

          {error ? <UiText style={styles.error}>{error}</UiText> : null}

          {outcome ? (
            <>
              <UiText style={styles.sectionLabel}>Result</UiText>
              <ResultPlayer uri={outcome.result.uri} />
              <View style={styles.card}>
                <UiText style={styles.line}>
                  Duration: expected {(outcome.result.durationMs / 1000).toFixed(2)}s, actual{" "}
                  {(outcome.result.actualDurationMs / 1000).toFixed(2)}s
                </UiText>
                <UiText style={styles.line}>
                  File size: {(outcome.result.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                </UiText>
                <UiText style={styles.line}>
                  Actual bitrate:{" "}
                  {outcome.result.actualDurationMs > 0
                    ? ((outcome.result.sizeBytes * 8) / outcome.result.actualDurationMs / 1000).toFixed(2)
                    : "?"}{" "}
                  Mbps (the bitrate option is advisory)
                </UiText>
                <UiText style={styles.line}>Render time: {(outcome.renderMs / 1000).toFixed(1)}s</UiText>
              </View>
              <Pressable
                onPress={saveToCameraRoll}
                style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }]}
              >
                <UiText style={styles.secondaryBtnText}>Save to camera roll</UiText>
              </Pressable>
              {saveNote ? <UiText style={styles.muted}>{saveNote}</UiText> : null}
              <UiText style={styles.muted}>
                Note: an iPhone HDR video may look dim or washed out after the render.
              </UiText>
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
    gap: 8,
  },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  video: { width: "100%", aspectRatio: 9 / 16, backgroundColor: "#000" },
  line: { flex: 1, color: theme.text, fontSize: 13 },
  muted: { color: theme.textMuted, fontSize: 12 },
  error: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
});
