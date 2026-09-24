import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Image } from "expo-image";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Mail } from "lucide-react-native";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";

export default function WelcomeScreen() {
  const floatAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 3000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 3000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: 2200,
          useNativeDriver: true,
        }),
        Animated.timing(glowAnim, {
          toValue: 0,
          duration: 2200,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [floatAnim, glowAnim]);

  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -8],
  });

  const ringOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.06],
  });
  const ringScale = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.55],
  });

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        {/* Hero */}
        <View style={styles.hero}>
          {/* Pulsing ring */}
          <Animated.View
            style={[
              styles.ring,
              {
                opacity: ringOpacity,
                transform: [{ scale: ringScale }],
              },
            ]}
          />
          {/* Logo */}
          <Animated.View style={{ transform: [{ translateY }] }}>
            <Image
              source={require("@/assets/images/trial-wordmark.png")}
              style={styles.brandLogo}
              contentFit="contain"
            />
          </Animated.View>
          <UiText style={styles.tagline}>Just try.</UiText>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <PrimaryButton
            label="Continue with Email"
            icon={<Mail color="#fff" size={18} />}
            onPress={() => router.push("/(auth)/sign-up")}
          />

          <UiText style={styles.legal}>
            By continuing you agree to just try.
          </UiText>
          <Pressable
            onPress={() => router.push("/(auth)/sign-in")}
            style={styles.switch}
          >
            <UiText style={styles.switchText}>
              Already have an account?{" "}
              <UiText style={styles.switchAccent}>Sign in</UiText>
            </UiText>
          </Pressable>
        </View>
      </SafeAreaView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 24 },
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  ring: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 0,
    borderWidth: 1.5,
    borderColor: theme.accent,
  },
  brandLogo: { width: 190, height: 68 },
  tagline: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: "500" as const,
  },
  actions: { gap: 12, paddingBottom: 8 },
  legal: {
    color: theme.textDim,
    fontSize: 11,
    textAlign: "center",
    marginTop: 4,
  },
  switch: { alignItems: "center", marginTop: 6 },
  switchText: { color: theme.textMuted, fontSize: 14 },
  switchAccent: { color: theme.accent, fontWeight: "700" as const },
});
