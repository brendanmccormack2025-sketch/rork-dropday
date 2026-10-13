import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Pause, Play, RotateCcw } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { formatClock, playPressed } from "@/lib/autoEdit/gaplessPlan";

/**
 * Play / pause (replay once the edit has played to its end), a replay button that restarts the whole edit from 0, and
 * the edited time "0:12 / 0:48". Rounded. `floating` is the full-screen editor's version, on the dark video.
 */
export default function PlaybackControls({
  isPlaying,
  ended,
  positionMs,
  totalMs,
  onToggle,
  onReplay,
  floating,
}: {
  isPlaying: boolean;
  ended: boolean;
  positionMs: number;
  totalMs: number;
  onToggle: () => void;
  onReplay: () => void;
  floating?: boolean;
}) {
  const action = playPressed({ isPlaying, ended });
  const ink = floating ? "#FFFFFF" : theme.text;
  const shown = ended ? totalMs : Math.min(Math.max(0, positionMs), totalMs);
  return (
    <View style={[styles.row, floating && styles.rowFloating]} accessibilityRole="toolbar">
      <Pressable
        onPress={onReplay}
        accessibilityRole="button"
        accessibilityLabel="Replay from the start"
        hitSlop={6}
        style={({ pressed }) => [styles.small, floating ? styles.smallFloating : styles.smallQuiet, pressed && styles.pressed]}
      >
        <RotateCcw size={18} color={ink} strokeWidth={2.4} />
      </Pressable>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={action === "pause" ? "Pause" : action === "replay" ? "Replay" : "Play"}
        hitSlop={6}
        style={({ pressed }) => [styles.big, pressed && styles.pressed]}
      >
        {action === "pause" ? (
          <Pause size={26} color="#FFFFFF" fill="#FFFFFF" />
        ) : action === "replay" ? (
          <RotateCcw size={24} color="#FFFFFF" strokeWidth={2.6} />
        ) : (
          <Play size={26} color="#FFFFFF" fill="#FFFFFF" style={{ left: 2 }} />
        )}
      </Pressable>
      <View style={[styles.time, floating && styles.timeFloating]} accessibilityLabel={`${formatClock(shown)} of ${formatClock(totalMs)}`}>
        <UiText style={[styles.timeText, { color: ink }]}>{`${formatClock(shown)} / ${formatClock(totalMs)}`}</UiText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, paddingVertical: 8 },
  rowFloating: { position: "absolute", alignSelf: "center", gap: 12, paddingVertical: 0 },
  big: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  small: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  smallQuiet: { backgroundColor: "rgba(10,10,10,0.08)" },
  smallFloating: { backgroundColor: "rgba(0,0,0,0.45)" },
  pressed: { opacity: 0.7 },
  time: { minWidth: 92, height: 36, borderRadius: 18, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(10,10,10,0.08)" },
  timeFloating: { backgroundColor: "rgba(0,0,0,0.45)" },
  timeText: { fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
});
