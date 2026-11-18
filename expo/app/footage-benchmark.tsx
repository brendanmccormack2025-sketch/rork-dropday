import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import { getInfoAsync, deleteAsync } from "@/lib/fileSystemCompat";
import { describeProjection, project, type BenchSample } from "@/lib/footageBenchmark";
import { pickFootage } from "@/lib/footageRuntime";
import { renderMerge } from "@/lib/mergeNative";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Owner only. Picks one video and cuts the SAME 60-second slice with the existing renderer at three sizes, timing each, so we know (measured, on this
 * phone) how fast the renderer can make a segment or a low-resolution proxy, how big the result is, and what that means for 60 minutes of footage.
 * Nothing is uploaded; the files are deleted straight away.
 */
const SLICE_SECONDS = 60;
const VARIANTS: Array<{ label: string; maxSide: number }> = [
  { label: "A. a segment as today (1280 px, full quality)", maxSide: 1280 },
  { label: "B. proxy, 640 px", maxSide: 640 },
  { label: "C. proxy, 480 px", maxSide: 480 },
];

export default function FootageBenchmark() {
  const router = useRouter();
  const { user } = useAuth();
  const owner = isDebugOwner(user?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  if (!owner) return <Redirect href="/(tabs)" />;

  const run = async () => {
    setLines([]);
    setBusy("Opening your photos…");
    try {
      const { inputs, message } = await pickFootage();
      if (message) { setLines([message]); return; }
      const v = inputs[0];
      if (!v) return;
      const out: string[] = [`Video: ${v.name}, ${v.durationSeconds > 0 ? `${Math.round(v.durationSeconds)} s` : "length unknown"}, ${v.width}x${v.height}`, `Slice: the first ${SLICE_SECONDS} s`, ""];
      for (const variant of VARIANTS) {
        setBusy(`Cutting ${variant.label}…`);
        const t0 = Date.now();
        try {
          const r = await renderMerge([v.uri], () => {}, undefined, [{ startMs: 0, endMs: SLICE_SECONDS * 1000 }], { maxSide: variant.maxSide });
          const wallMs = Date.now() - t0;
          const info = await getInfoAsync(r.uri, { size: true });
          const bytes = info.exists ? Number((info as { size?: number }).size ?? 0) : 0;
          await deleteAsync(r.uri, { idempotent: true }).catch(() => {});
          const sample: BenchSample = { label: variant.label, maxSide: variant.maxSide, sliceSeconds: Math.min(SLICE_SECONDS, r.durationMs / 1000 || SLICE_SECONDS), wallMs, bytes };
          out.push(...describeProjection(project(sample)), "");
        } catch (e) {
          out.push(`${variant.label}: failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, "");
        }
        setLines([...out]);
      }
      out.push("(Projections assume one cut at a time and an upload of 19 Mbps at 80 %.)");
      setLines([...out]);
    } finally { setBusy(null); }
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}><ChevronLeft color={theme.text} size={22} strokeWidth={2.5} /></Pressable>
          <UiText style={styles.title}>Footage speed test</UiText>
          <View style={styles.back} />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <UiText style={styles.sub}>Pick one video (a minute or longer). Tryal cuts the same 60 seconds at three sizes and times each, then shows what that means for 60 minutes of footage. Nothing is uploaded. Keep Tryal open; it takes about a minute.</UiText>
          <PrimaryButton label="Pick a video and measure" onPress={run} disabled={!!busy} loading={!!busy} />
          {busy ? <View style={styles.row}><ActivityIndicator color={theme.accent} /><UiText style={styles.sub}>{busy}</UiText></View> : null}
          {lines.map((l, i) => <UiText key={i} style={styles.line} selectable>{l}</UiText>)}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 },
  back: { minWidth: 56, height: 32, justifyContent: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  body: { padding: 16, gap: 10 },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  sub: { color: theme.textMuted, fontSize: 13 },
  line: { color: theme.text, fontSize: 13 },
});
