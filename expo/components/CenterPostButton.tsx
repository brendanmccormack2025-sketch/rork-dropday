import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { Plus } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";
import { theme, getDropWindowState } from "@/constants/theme";

type Props = {
  onPress?: () => void;
};

/**
 * Floating center "+" button — a compact outlined circle that
 * pulses during the drop window. Visually distinct from the other
 * tab icons while still reading as the primary action.
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
    const to = isOpen ? 1.12 : 1.05;
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

  const ringOpacity = pulseAnim.interpolate({
    inputRange: [1, isOpen ? 1.12 : 1.05],
    outputRange: [0.25, isOpen ? 0.6 : 0.35],
  });

  const handlePress = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    onPress?.();
  };

  return (
    <Pressable onPress={handlePress} style={styles.container} hitSlop={12}>
      {/* Pulsing outline ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            opacity: ringOpacity,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      />
      {/* Button body — outlined circle */}
      <View style={styles.btnOuter}>
        <View style={styles.btn}>
          <Plus color={theme.accent} size={20} strokeWidth={2.5} />
        </View>
      </View>
    </Pressable>
  );
}

const SIZE = 44;
const RING_SIZE = 56;

const styles = StyleSheet.create({
  container: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -14,
  },
  ring: {
    position: "absolute",
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: 0,
    borderWidth: 1.5,
    borderColor: theme.accent,
  },
  btnOuter: {
    width: SIZE,
    height: SIZE,
    borderRadius: 0,
    borderWidth: 2,
    borderColor: theme.accent,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  btn: {
    width: "100%",
    height: "100%",
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
