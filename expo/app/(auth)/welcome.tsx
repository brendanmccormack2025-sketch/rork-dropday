import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import WelcomeHero from "@/components/WelcomeHero";
import { theme } from "@/constants/theme";

export default function WelcomeScreen() {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 650, delay: 250, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.top}>
          <Image source={require("@/assets/images/tryal-wordmark.png")} style={styles.brandLogo} contentFit="contain" accessibilityLabel="Tryal" />
        </View>

        <View style={styles.hero}>
          <WelcomeHero />
        </View>

        <Animated.View style={{ opacity: enter, transform: [{ translateY: rise }] }}>
          <UiText weight={800} style={styles.headline} accessibilityRole="header">
            A place where normal people become <UiText weight={800} style={styles.headlineAccent}>content creators</UiText>
          </UiText>
        </Animated.View>

        <Animated.View style={[styles.actions, { opacity: enter }]}>
          <PrimaryButton label="Create account" onPress={() => router.push("/(auth)/sign-up")} />
          <PrimaryButton label="Sign in" variant="outline" onPress={() => router.push("/(auth)/sign-in")} />
          <UiText style={styles.legal}>
            By continuing you agree to the{" "}
            <UiText style={styles.legalLink} onPress={() => router.push("/(auth)/legal?tab=terms" as never)}>
              Terms
            </UiText>{" "}
            and{" "}
            <UiText style={styles.legalLink} onPress={() => router.push("/(auth)/legal?tab=privacy" as never)}>
              Privacy Policy
            </UiText>
            .
          </UiText>
        </Animated.View>
      </SafeAreaView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 24 },
  top: { paddingTop: 8 },
  brandLogo: { width: 86, height: 35 },
  hero: { flex: 1, alignItems: "center", justifyContent: "center" },
  headline: { color: theme.text, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  headlineAccent: { color: theme.accent, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  actions: { gap: 12, paddingTop: 28, paddingBottom: 8 },
  legal: { color: theme.textDim, fontSize: 12, textAlign: "center", marginTop: 4, lineHeight: 17 },
  legalLink: { color: theme.text, fontWeight: "700" as const },
});
