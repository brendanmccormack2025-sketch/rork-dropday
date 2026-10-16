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
  }, [floatAnim]);

  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -8],
  });


  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        {/* Hero */}
        <View style={styles.hero}>
          {/* Logo */}
          <Animated.View style={{ transform: [{ translateY }] }}>
            <Image
              source={require("@/assets/images/tryal-wordmark.png")}
              style={styles.brandLogo}
              contentFit="contain"
            />
          </Animated.View>
          <UiText style={styles.tagline}>A safe place to create and grow your audience</UiText>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <PrimaryButton
            label="Continue with Email"
            icon={<Mail color="#fff" size={18} />}
            onPress={() => router.push("/(auth)/sign-up")}
          />

          <UiText style={styles.legal}>
            By continuing you agree to the{" "}
            <UiText
              style={styles.legalLink}
              onPress={() => router.push("/(auth)/legal?tab=terms" as never)}
            >
              Terms
            </UiText>{" "}
            and{" "}
            <UiText
              style={styles.legalLink}
              onPress={() => router.push("/(auth)/legal?tab=privacy" as never)}
            >
              Privacy Policy
            </UiText>.
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
  brandLogo: { width: 140, height: 56 },
  tagline: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: "500" as const,
    textAlign: "center" as const,
    maxWidth: 280,
  },
  actions: { gap: 12, paddingBottom: 8 },
  legal: {
    color: theme.textDim,
    fontSize: 11,
    textAlign: "center",
    marginTop: 4,
  },
  legalLink: { color: theme.accent },
  switch: { alignItems: "center", marginTop: 6 },
  switchText: { color: theme.textMuted, fontSize: 14 },
  switchAccent: { color: theme.accent, fontWeight: "700" as const },
});
