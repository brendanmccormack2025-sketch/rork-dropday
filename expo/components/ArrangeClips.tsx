import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ArrowDown, ArrowUp, X } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { moveItem, removeItem, totalDurationMs, type ImportClip } from "@/lib/importSelection";

function label(ms?: number): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A first-frame thumbnail, best effort (the row works without it). */
function useThumb(uri: string): string | null {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { getThumbnailAsync } = await import("expo-video-thumbnails");
        const t = await getThumbnailAsync(uri, { time: 0 });
        if (alive) setThumb(t.uri);
      } catch {
        // no thumbnail
      }
    })();
    return () => {
      alive = false;
    };
  }, [uri]);
  return thumb;
}

function Row({
  clip,
  index,
  count,
  onUp,
  onDown,
  onRemove,
}: {
  clip: ImportClip;
  index: number;
  count: number;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const thumb = useThumb(clip.uri);
  return (
    <View style={styles.row}>
      <UiText style={styles.index}>{index + 1}</UiText>
      <View style={styles.thumb}>{thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}</View>
      <UiText style={styles.duration}>{label(clip.durationMs)}</UiText>
      <View style={styles.actions}>
        <Pressable onPress={onUp} disabled={index === 0} hitSlop={6} style={[styles.btn, index === 0 && styles.off]} accessibilityRole="button" accessibilityLabel={`Move clip ${index + 1} earlier`}>
          <ArrowUp size={18} color={theme.text} />
        </Pressable>
        <Pressable onPress={onDown} disabled={index === count - 1} hitSlop={6} style={[styles.btn, index === count - 1 && styles.off]} accessibilityRole="button" accessibilityLabel={`Move clip ${index + 1} later`}>
          <ArrowDown size={18} color={theme.text} />
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={6} style={styles.btn} accessibilityRole="button" accessibilityLabel={`Remove clip ${index + 1}`}>
          <X size={18} color={theme.accent} />
        </Pressable>
      </View>
    </View>
  );
}

/** "Arrange": the picked videos in the order they will play. Reorder or remove, then Combine. */
export default function ArrangeClips({
  clips,
  onChange,
  onContinue,
  onBack,
}: {
  clips: ImportClip[];
  onChange: (next: ImportClip[]) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <View>
      <UiText weight={800} style={styles.title}>
        Arrange
      </UiText>
      <UiText style={styles.hint}>Videos play in this order. Total {label(totalDurationMs(clips)) || "—"}.</UiText>
      <ScrollView style={styles.list}>
        {clips.map((c, i) => (
          <Row
            key={c.id}
            clip={c}
            index={i}
            count={clips.length}
            onUp={() => onChange(moveItem(clips, i, i - 1))}
            onDown={() => onChange(moveItem(clips, i, i + 1))}
            onRemove={() => onChange(removeItem(clips, i))}
          />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back">
          <UiText style={styles.backText}>Back</UiText>
        </Pressable>
        <Pressable onPress={onContinue} disabled={clips.length === 0} style={[styles.go, clips.length === 0 && styles.off]} accessibilityRole="button" accessibilityLabel="Combine">
          <UiText style={styles.goText}>{clips.length > 1 ? "Combine" : "Continue"}</UiText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 20, color: theme.text },
  hint: { fontSize: 13, color: theme.textDim, marginTop: 2, marginBottom: 8 },
  list: { maxHeight: 340 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  index: { width: 20, color: theme.textDim, fontSize: 14, fontWeight: "800" as const },
  thumb: { width: 36, height: 48, backgroundColor: "#000", overflow: "hidden" },
  duration: { flex: 1, color: theme.text, fontSize: 14, fontWeight: "700" as const },
  actions: { flexDirection: "row", gap: 4 },
  btn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.3 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  backBtn: { minHeight: 48, justifyContent: "center", paddingHorizontal: 8 },
  backText: { color: theme.textDim, fontSize: 15, fontWeight: "700" as const },
  go: { minHeight: 48, paddingHorizontal: 28, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  goText: { color: "#fff", fontSize: 15, fontWeight: "900" as const },
});
