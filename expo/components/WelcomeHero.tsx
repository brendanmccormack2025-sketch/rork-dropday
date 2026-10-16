import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Check, Play } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";

/**
 * The welcome screen's picture of what Tryal is: three posts fanned out (one testing, one that survived, one being
 * watched), with reactions floating off the front one. Drawn with views only (no images), gently floating.
 */
type CardSpec = {
  colors: [string, string];
  rotate: string;
  x: number;
  y: number;
  z: number;
  chip: React.ReactNode;
  phase: number;
};

const CARD_W = 128;
const STAGE_W = 340;
const STAGE_H = CARD_W * (16 / 9) + 50;

function useFloat(phase: number) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 2600, delay: phase, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, phase]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
}

function Card({ spec, enter }: { spec: CardSpec; enter: Animated.Value }) {
  const float = useFloat(spec.phase);
  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  return (
    <Animated.View
      style={[
        styles.card,
        {
          zIndex: spec.z,
          opacity: enter,
          transform: [{ translateX: spec.x }, { translateY: spec.y }, { translateY: rise }, { translateY: float }, { rotate: spec.rotate }],
        },
      ]}
    >
      <LinearGradient colors={spec.colors} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.cardTop}>
        <View style={styles.avatar} />
        <View style={styles.nameBar} />
      </View>
      <View style={styles.playWrap}>
        <View style={styles.play}>
          <Play color="#fff" fill="#fff" size={16} style={{ marginLeft: 2 }} />
        </View>
      </View>
      <View style={styles.cardBottom}>{spec.chip}</View>
    </Animated.View>
  );
}

function Bubble({ text, style, phase, enter }: { text: string; style: object; phase: number; enter: Animated.Value }) {
  const float = useFloat(phase);
  return (
    <Animated.View style={[styles.bubble, style, { opacity: enter, transform: [{ translateY: float }] }]}>
      <UiText weight={800} style={styles.bubbleText} numberOfLines={1}>
        {text}
      </UiText>
    </Animated.View>
  );
}

export default function WelcomeHero() {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);

  const cards: CardSpec[] = [
    {
      colors: ["#FFB199", "#FF6B5E"],
      rotate: "-11deg",
      x: -96,
      y: 22,
      z: 1,
      phase: 0,
      chip: (
        <View style={[styles.chip, styles.chipLight]}>
          <View style={[styles.dot, { backgroundColor: theme.trending }]} />
          <UiText weight={800} style={styles.chipTextDark}>
            Testing
          </UiText>
        </View>
      ),
    },
    {
      colors: ["#FFD66B", "#FF9F1C"],
      rotate: "10deg",
      x: 96,
      y: 26,
      z: 1,
      phase: 900,
      chip: (
        <View style={[styles.chip, styles.chipLight]}>
          <UiText weight={800} style={styles.chipTextDark}>
            👀 32 watching
          </UiText>
        </View>
      ),
    },
    {
      colors: ["#2A2522", "#0A0A0A"],
      rotate: "0deg",
      x: 0,
      y: 0,
      z: 2,
      phase: 450,
      chip: (
        <View style={[styles.chip, { backgroundColor: theme.accent }]}>
          <Check color="#fff" size={12} strokeWidth={3.5} />
          <UiText weight={800} style={styles.chipText}>
            Survived
          </UiText>
        </View>
      ),
    },
  ];

  // Smaller phones (iPhone SE / mini): the whole stack is drawn smaller so the headline and buttons keep their room.
  const { height } = useWindowDimensions();
  const scale = height < 700 ? 0.74 : height < 800 ? 0.88 : 1;

  return (
    <View style={[styles.stage, { height: STAGE_H * scale }]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.inner, { transform: [{ scale }] }]}>
        {cards.map((c, i) => (
          <Card key={i} spec={c} enter={enter} />
        ))}
        <Bubble text="😂 24" style={{ top: 4, left: 222, zIndex: 3 }} phase={300} enter={enter} />
        <Bubble text="🔥 12" style={{ top: 96, left: 8, zIndex: 3 }} phase={1300} enter={enter} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { width: "100%", alignItems: "center", justifyContent: "center" },
  inner: { width: STAGE_W, height: STAGE_H, alignItems: "center", justifyContent: "center" },
  card: {
    position: "absolute",
    width: CARD_W,
    aspectRatio: 9 / 16,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 3,
    borderColor: "#fff",
    backgroundColor: "#222",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10 },
  avatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(255,255,255,0.85)" },
  nameBar: { width: 46, height: 7, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.7)" },
  playWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  play: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.25)", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.75)", alignItems: "center", justifyContent: "center" },
  cardBottom: { padding: 10 },
  chip: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999 },
  chipLight: { backgroundColor: "rgba(255,255,255,0.92)" },
  chipText: { color: "#fff", fontSize: 11 },
  chipTextDark: { color: theme.text, fontSize: 11 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  bubble: {
    position: "absolute",
    flexDirection: "row",
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  bubbleText: { color: theme.text, fontSize: 14, flexShrink: 0 },
});
