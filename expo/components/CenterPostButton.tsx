import React, { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet } from "react-native";
import { Plus } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

type Props = {
  onPress?: () => void;
};

/**
 * Center tab-bar "+" button — a 38×38 solid white rounded square with a
 * dark plus glyph. Idle pulse is a subtle scale animation only; press
 * feedback keeps its haptic + squash.
 */
export default function CenterPostButton({ onPress }: Props) {
  // Subtle idle pulse (scale only, no ring/opacity animation).
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pressScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.04,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1600,
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
  }, [pulseAnim]);

  // Press feedback: haptic + squash on press-in, springy release on
  // press-out, multiplied with the idle pulse.
  const handlePressIn = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    Animated.spring(pressScale, {
      toValue: 0.85,
      speed: 60,
      bounciness: 4,
      useNativeDriver: true,
    }).start();
  };
  const handlePressOut = () => {
    Animated.spring(pressScale, {
      toValue: 1,
      speed: 40,
      bounciness: 8,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={styles.container}
      hitSlop={12}
    >
      <Animated.View
        style={[
          styles.btn,
          { transform: [{ scale: Animated.multiply(pressScale, pulseAnim) }] },
        ]}
      >
        <Plus color="#1A1A18" size={20} strokeWidth={2.5} />
      </Animated.View>
    </Pressable>
  );
}

const SIZE = 38;

const styles = StyleSheet.create({
  container: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  btn: {
    width: SIZE,
    height: SIZE,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
});
