import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Play } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { E_PLAY, READY_LABEL_FADE_MS, READY_LABEL_SHOW_MS } from "@/lib/editorChrome";

/** The play icon: a round, semi-transparent circle (no dark square), shown only while paused, fading out on play. */
export function PlayIndicator({ visible }: { visible: boolean }) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: visible ? 120 : 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, opacity]);
  if (!mounted) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.playOverlay, { opacity }]}>
      <View style={styles.playCircle}>
        <Play size={26} color="#fff" fill="#fff" style={{ left: 2 }} />
      </View>
    </Animated.View>
  );
}

/**
 * The preview status label. "Preview ready" shows for about 1.5 s and fades out; progress texts ("Making preview...")
 * stay while they apply. Hidden while any panel, the keyboard or a selection owns the screen.
 */
export function PreviewStatusChip({ text, ready, hidden, style }: { text: string; ready: boolean; hidden: boolean; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) {
      setGone(false);
      opacity.setValue(1);
      return;
    }
    setGone(false);
    opacity.setValue(1);
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: READY_LABEL_FADE_MS, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setGone(true);
      });
    }, READY_LABEL_SHOW_MS);
    return () => clearTimeout(timer);
  }, [ready, opacity]);
  if (hidden || gone) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.chip, style, { opacity }]}>
      <UiText style={styles.chipText}>{text}</UiText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  playOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  playCircle: {
    width: E_PLAY.size,
    height: E_PLAY.size,
    borderRadius: E_PLAY.size / 2,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  chip: { position: "absolute", left: 16, zIndex: 5, backgroundColor: theme.text, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11 },
  chipText: { color: "#fff", fontSize: 11, fontWeight: "700" as const },
});
