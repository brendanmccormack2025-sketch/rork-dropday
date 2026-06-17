import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Plus } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";
import { theme, getDropWindowState } from "@/constants/theme";

type Props = {
  onPress?: () => void;
};

/**
 * Floating center "+" button — pulses during the drop window.
 * Elevated above the tab bar with an electric-blue glow.
 */
export default function CenterPostButton({ onPress }: Props) {
  const [now, setNow] = useState<Date>(new Date());
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1500);
    return () => clearInterval(id);
  }, []);

  const isOpen = useMemo(() => getDropWindowState(now).isOpen, [now]);

  useEffect(() => {
    const to = isOpen ? 1.1 : 1.04;
    const dur = isOpen ? 1000 : 2800;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: to,
          duration: dur,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: dur,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      pulseAnim.setValue(1);
    };
  }, [isOpen, pulseAnim]);

  const glowOpacity = pulseAnim.interpolate({
    inputRange: [1, isOpen ? 1.1 : 1.04],
    outputRange: [0.18, isOpen ? 0.55 : 0.28],
  });

  const handlePress = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    }
    onPress?.();
  };

  return (
    <Pressable onPress={handlePress} style={styles.container} hitSlop={12}>
      {/* Pulsing glow ring */}
      <Animated.View
        style={[
          styles.glow,
          {
            opacity: glowOpacity,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      >
        <LinearGradient
          colors={
            isOpen
              ? ["#3B9EFF", "#0A84FF", "#8B5CF6"]
              : ["#0A84FF", "#0055CC"]
          }
          style={styles.glowFill}
        />
      </Animated.View>
      {/* Button body */}
      <View style={styles.btnOuter}>
        <LinearGradient
          colors={["#0A84FF", "#0055CC"]}
          style={styles.btn}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        >
          <Plus color="#FFFFFF" size={26} strokeWidth={2.5} />
        </LinearGradient>
      </View>
    </Pressable>
  );
}

const SIZE = 58;
const GLOW_SIZE = 76;

const styles = StyleSheet.create({
  container: {
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -22,
  },
  glow: {
    position: "absolute",
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    borderRadius: GLOW_SIZE / 2,
    overflow: "hidden",
  },
  glowFill: {
    width: "100%",
    height: "100%",
    borderRadius: GLOW_SIZE / 2,
    opacity: 0.7,
  },
  btnOuter: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: "hidden",
    shadowColor: "#0A84FF",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  btn: {
    width: "100%",
    height: "100%",
    borderRadius: SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
