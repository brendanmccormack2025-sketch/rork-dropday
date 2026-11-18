import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { VideoView, useVideoPlayer } from "expo-video";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { wantsEditChoice } from "@/lib/editChoice";
import { cacheDirectory, deleteAsync, downloadAsync } from "@/lib/fileSystemCompat";
import { minutesLabel } from "@/lib/footageLimits";
import { MAX_SECTION_SECONDS, sectionCheck, sectionRanges } from "@/lib/footageSegments";
import { supabaseMediaStore } from "@/lib/mediaStore";
import { renderMerge } from "@/lib/mergeNative";
import { footageManifest } from "@/lib/moneyApi";

/**
 * A clipper's view of one video: it plays segment by segment (each ~1 minute, streamed), you mark where a section starts and ends (at most 3 minutes),
 * and "Make a clip" downloads ONLY the segments that cover the section, trims them on the phone and hands the result to the editor. Parts that are still
 * uploading say so and cannot be chosen yet.
 */
let clipSeq = 0;
const newClipId = () => `clip-${Date.now()}-${++clipSeq}`;
const fmt = (s: number | null) => (s === null ? "—" : minutesLabel(s));

export default function FootageViewer() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const manifest = useQuery({ queryKey: ["money", "manifest", id], queryFn: () => footageManifest(String(id)), refetchInterval: 20_000 });
  const video = manifest.data?.video ?? null;
  const segments = manifest.data?.segments ?? [];
  const [segIdx, setSegIdx] = useState<number | null>(null);
  const [pos, setPos] = useState(0);                       // seconds from the start of the whole video
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const urls = useRef(new Map<number, { url: string; at: number }>());
  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 0.25; });
  const segRef = useRef<number | null>(null);
  segRef.current = segIdx;

  /** A signed read URL for a ready segment (the database signs only for the creator and joined clippers); cached for 50 minutes. */
  const urlFor = useCallback(async (idx: number): Promise<string | null> => {
    const hit = urls.current.get(idx);
    if (hit && Date.now() - hit.at < 50 * 60_000) return hit.url;
    const seg = segments.find((s) => s.idx === idx);
    if (!seg || seg.status !== "ready") return null;
    // sign this one and the next two in one call, so the next part is ready before it is needed
    const want = segments.filter((s) => s.idx >= idx && s.idx <= idx + 2 && s.status === "ready");
    const signed = await supabaseMediaStore.signedUrls(want.map((s) => s.storage_path), 3600);
    want.forEach((s, i) => { const u = signed[i]; if (u) urls.current.set(s.idx, { url: u, at: Date.now() }); });
    return urls.current.get(idx)?.url ?? null;
  }, [segments]);

  const play = useCallback(async (idx: number, seekSeconds = 0) => {
    setMessage(null);
    const seg = segments.find((s) => s.idx === idx);
    if (!seg) return;
    if (seg.status !== "ready") { setMessage(`Part ${idx + 1} is still uploading. Try again in a moment.`); return; }
    const url = await urlFor(idx);
    if (!url) { setMessage(`Couldn't load part ${idx + 1}. Check your connection and try again.`); return; }
    setSegIdx(idx);
    player.replace({ uri: url });
    if (seekSeconds > 0) player.currentTime = seekSeconds;
    player.play();
  }, [segments, urlFor, player]);

  useEffect(() => { if (segIdx === null && segments.some((s) => s.status === "ready")) void play(segments.find((s) => s.status === "ready")!.idx); }, [segments, segIdx, play]);
  // position in the whole video = where this segment starts + how far into it the player is
  useEffect(() => {
    const t = setInterval(() => {
      const cur = segments.find((s) => s.idx === segRef.current);
      if (cur) setPos(Number(cur.start_s) + (player.currentTime || 0));
    }, 250);
    return () => clearInterval(t);
  }, [segments, player]);
  useEffect(() => {
    const sub = player.addListener("playToEnd", () => { const n = (segRef.current ?? -1) + 1; if (segments.some((s) => s.idx === n)) void play(n); });
    return () => sub.remove();
  }, [player, segments, play]);
  useEffect(() => () => { try { player.pause(); } catch { /* already gone */ } }, [player]);

  const jump = (delta: number) => {
    const cur = segments.find((s) => s.idx === segIdx);
    if (!cur) return;
    const target = Math.max(0, Math.min((video ? Number(video.duration_seconds) : 0) - 0.5, pos + delta));
    const into = segments.find((s) => target >= Number(s.start_s) && target < Number(s.end_s));
    if (!into) return;
    if (into.idx === cur.idx) player.currentTime = target - Number(cur.start_s);
    else void play(into.idx, target - Number(into.start_s));
  };

  const duration = video ? Number(video.duration_seconds) : 0;
  const check = sectionCheck(segments, start, end, duration);

  const makeClip = async () => {
    if (!check.ok || start === null || end === null) { setMessage(check.ok ? null : check.reason); return; }
    setMessage(null);
    const ranges = sectionRanges(segments, start, end);
    const files: string[] = [];
    try {
      player.pause();
      // 1. download only the segments that cover the section
      for (let i = 0; i < ranges.length; i++) {
        setBusy(`Downloading part ${ranges[i].segment.idx + 1} (${i + 1} of ${ranges.length})…`);
        const signed = (await supabaseMediaStore.signedUrls([ranges[i].segment.storage_path], 600))[0];
        if (!signed) throw new Error(`part ${ranges[i].segment.idx + 1} could not be opened`);
        const dest = `${cacheDirectory}section_${String(id).slice(0, 8)}_${ranges[i].segment.idx}.mp4`;
        const res = await downloadAsync(signed, dest);
        if (!res || res.status < 200 || res.status >= 300) throw new Error(`part ${ranges[i].segment.idx + 1} could not be downloaded (${res?.status ?? "no answer"})`);
        files.push(res.uri);
      }
      // 2. trim and join them on the phone
      setBusy("Cutting your section…");
      const out = await renderMerge(files, () => {}, undefined, ranges.map((r) => ({ startMs: r.startMs, endMs: r.endMs })));
      const clip = { id: newClipId(), uri: out.uri, type: "video" as const, durationMs: out.durationMs };
      router.push({ pathname: wantsEditChoice({ clips: [clip] }) ? "/edit-choice" : "/edit", params: { clips: JSON.stringify([clip]) } } as never);
    } catch (e) {
      setMessage(`Couldn't make the clip: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      for (const f of files) await deleteAsync(f, { idempotent: true }).catch(() => {});
      setBusy(null);
    }
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}><ChevronLeft color={theme.text} size={22} strokeWidth={2.5} /></Pressable>
          <UiText style={styles.title}>Pick a section</UiText>
          <View style={styles.back} />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {manifest.isLoading ? <ActivityIndicator color={theme.accent} /> : null}
          {manifest.error ? <UiText style={styles.err}>Couldn't load this video. Check your connection.</UiText> : null}
          {video ? (
            <>
              <View style={styles.player}>
                <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls />
              </View>
              <UiText style={styles.sub}>{fmt(pos)} of {fmt(duration)} · part {(segIdx ?? 0) + 1} of {video.segment_count}</UiText>
              {video.segments_ready < video.segment_count ? <UiText style={styles.sub}>{video.stalled_at ? "The creator's upload stopped before the end. " : "Still uploading: "}{video.segments_ready} of {video.segment_count} parts are ready. Parts that are not ready can't be chosen yet.</UiText> : null}
              <View style={styles.row}>
                <Pressable onPress={() => jump(-15)} style={styles.chip} accessibilityRole="button"><UiText style={styles.chipText}>−15 s</UiText></Pressable>
                <Pressable onPress={() => jump(15)} style={styles.chip} accessibilityRole="button"><UiText style={styles.chipText}>+15 s</UiText></Pressable>
              </View>
              <UiText style={styles.label}>Parts</UiText>
              <View style={styles.parts}>
                {segments.map((s) => (
                  <Pressable key={s.idx} onPress={() => void play(s.idx)} style={[styles.part, s.status !== "ready" && styles.partOff, segIdx === s.idx && styles.partOn]} accessibilityRole="button" accessibilityLabel={`Part ${s.idx + 1}${s.status !== "ready" ? ", still uploading" : ""}`}>
                    <UiText style={[styles.partText, segIdx === s.idx && { color: theme.accent }]}>{s.idx + 1}{s.status !== "ready" ? " ⏳" : ""}</UiText>
                  </Pressable>
                ))}
              </View>
              <UiText style={styles.label}>Your section (up to {MAX_SECTION_SECONDS / 60} minutes)</UiText>
              <View style={styles.row}>
                <Pressable onPress={() => { setStart(pos); if (end !== null && end <= pos) setEnd(null); }} style={styles.mark} accessibilityRole="button"><UiText style={styles.markText}>Start here · {fmt(start)}</UiText></Pressable>
                <Pressable onPress={() => setEnd(pos)} style={styles.mark} accessibilityRole="button"><UiText style={styles.markText}>End here · {fmt(end)}</UiText></Pressable>
              </View>
              <UiText style={[styles.sub, !check.ok && start !== null && end !== null && { color: theme.danger }]}>
                {start !== null && end !== null ? (check.ok ? `Section: ${fmt(check.seconds)}. Only the parts it needs are downloaded.` : check.reason) : "Play to where you want to start, tap Start here, then play to the end and tap End here."}
              </UiText>
              {busy ? <View style={styles.row}><ActivityIndicator color={theme.accent} /><UiText style={styles.sub}>{busy}</UiText></View> : null}
              {message ? <UiText style={styles.err}>{message}</UiText> : null}
              <PrimaryButton label="Make a clip" onPress={makeClip} disabled={!check.ok || !!busy} loading={!!busy} />
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
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 },
  back: { minWidth: 56, height: 32, justifyContent: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  body: { padding: 16, gap: 12 },
  player: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", borderRadius: 12, overflow: "hidden" },
  sub: { color: theme.textMuted, fontSize: 13 },
  label: { color: theme.textMuted, fontSize: 12, fontWeight: "700" as const, letterSpacing: 0.4, textTransform: "uppercase" },
  err: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
  row: { flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  parts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  part: { minWidth: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card, alignItems: "center" },
  partOff: { opacity: 0.45 },
  partOn: { borderColor: theme.accent },
  partText: { color: theme.text, fontSize: 13, fontWeight: "700" as const },
  mark: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.accent, alignItems: "center", backgroundColor: "rgba(232,41,28,0.08)" },
  markText: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
});
