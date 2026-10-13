import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { RotateCcw } from "lucide-react-native";

import UiText from "@/components/UiText";
import { E_PROGRESS, E_TRANSPORT, transportRects } from "@/lib/editorChrome";
import { formatClock } from "@/lib/autoEdit/gaplessPlan";

const SCRUB_EVERY_MS = 70;
const THUMB = 14;

/**
 * The bottom of the full-screen editor, TikTok style: one slim draggable progress bar across the width (scrubbing seeks
 * the edited time), and above it on the left a small replay icon and the time "0:03 / 0:48". Transform and opacity only
 * on the UI thread; the gestures run on the JS thread.
 */
export default function EditorTransport({
  screenW,
  screenH,
  insetBottom,
  positionMs,
  totalMs,
  isPlaying,
  getPositionMs,
  onSeek,
  onResume,
  onReplay,
}: {
  screenW: number;
  screenH: number;
  insetBottom: number;
  positionMs: number;
  totalMs: number;
  isPlaying: boolean;
  /** The player's own edited time, read every frame while playing. */
  getPositionMs?: () => number | null;
  onSeek: (ms: number) => void;
  /** After a scrub that interrupted playback, play on. */
  onResume: () => void;
  onReplay: () => void;
}) {
  const rects = transportRects({ w: screenW, h: screenH, insetBottom });
  const barW = rects.progress.w - 0;
  const frac = useSharedValue(0);
  const scrubbing = useRef(false);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const live = useRef({ totalMs, onSeek, onResume, getPositionMs, barW, wasPlaying: false, lastSeekAt: 0 });
  live.current = { ...live.current, totalMs, onSeek, onResume, getPositionMs, barW };

  const fractionOf = (ms: number) => (totalMs > 0 ? Math.min(1, Math.max(0, ms / totalMs)) : 0);

  // paused (or between events): the bar shows the reported position
  useEffect(() => {
    if (!scrubbing.current) frac.value = fractionOf(positionMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionMs, totalMs]);

  // playing: read the player every frame, so the bar moves continuously
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (!scrubbing.current) {
        const ms = live.current.getPositionMs?.();
        if (typeof ms === "number" && Number.isFinite(ms)) frac.value = live.current.totalMs > 0 ? Math.min(1, Math.max(0, ms / live.current.totalMs)) : 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [isPlaying, frac]);

  const seekTo = useCallback(
    (x: number, force: boolean) => {
      const l = live.current;
      const f = Math.min(1, Math.max(0, x / Math.max(1, l.barW)));
      frac.value = f;
      const ms = f * l.totalMs;
      setScrubMs(ms);
      const now = Date.now();
      if (force || now - l.lastSeekAt >= SCRUB_EVERY_MS) {
        l.lastSeekAt = now;
        l.onSeek(ms);
      }
    },
    [frac],
  );
  const wasPlayingRef = useRef(false);
  wasPlayingRef.current = isPlaying;

  const scrub = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      scrubbing.current = true;
      live.current.wasPlaying = wasPlayingRef.current;
      seekTo(e.x, true);
    })
    .onUpdate((e) => seekTo(e.x, false))
    .onFinalize((e) => {
      if (!scrubbing.current) return;
      seekTo(e.x, true);
      scrubbing.current = false;
      setScrubMs(null);
      if (live.current.wasPlaying) live.current.onResume();
    });

  const fill = useAnimatedStyle(() => ({ transform: [{ translateX: (frac.value - 1) * barW * 0.5 }, { scaleX: Math.max(0.0001, frac.value) }] }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: frac.value * barW - THUMB / 2 }] }));

  const shown = scrubMs ?? positionMs;
  return (
    <>
      <View pointerEvents="box-none" style={[styles.row, { left: rects.replay.x, top: rects.replay.y, height: E_TRANSPORT.rowHeight }]}>
        <Pressable
          onPress={onReplay}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Replay from the start"
          style={({ pressed }) => [styles.replay, pressed && { opacity: 0.6 }]}
        >
          <RotateCcw size={16} color="#FFFFFF" strokeWidth={2.6} />
        </Pressable>
        <View pointerEvents="none" style={styles.time} accessibilityLabel={`${formatClock(shown)} of ${formatClock(totalMs)}`}>
          <UiText style={styles.timeText} numberOfLines={1}>{`${formatClock(shown)} / ${formatClock(totalMs)}`}</UiText>
        </View>
      </View>
      <GestureDetector gesture={scrub}>
        <View
          collapsable={false}
          accessibilityRole="adjustable"
          accessibilityLabel="Video progress"
          style={[styles.bar, { left: rects.progress.x, top: rects.progress.y, width: rects.progress.w, height: E_PROGRESS.height }]}
        >
          <View pointerEvents="none" style={styles.track} />
          <Animated.View pointerEvents="none" style={[styles.fill, { width: barW }, fill]} />
          <Animated.View pointerEvents="none" style={[styles.thumb, thumb]} />
        </View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({
  row: { position: "absolute", flexDirection: "row", alignItems: "center", gap: E_TRANSPORT.gap },
  replay: { width: E_TRANSPORT.replay, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  time: { height: 24, borderRadius: 12, paddingHorizontal: 9, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  timeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  bar: { position: "absolute", justifyContent: "center" },
  track: { position: "absolute", left: 0, right: 0, top: (E_PROGRESS.height - E_PROGRESS.track) / 2, height: E_PROGRESS.track, borderRadius: E_PROGRESS.track / 2, backgroundColor: "rgba(255,255,255,0.3)" },
  fill: { position: "absolute", left: 0, top: (E_PROGRESS.height - E_PROGRESS.track) / 2, height: E_PROGRESS.track, borderRadius: E_PROGRESS.track / 2, backgroundColor: "#FFFFFF" },
  thumb: { position: "absolute", left: 0, top: (E_PROGRESS.height - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: "#FFFFFF" },
});
