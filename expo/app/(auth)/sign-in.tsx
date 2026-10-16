import React, { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useNavigation } from "expo-router";
import { ArrowLeft, FileText } from "lucide-react-native";
import * as Linking from "expo-linking";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import AuthField from "@/components/AuthField";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";

export default function SignInScreen() {
  const navigation = useNavigation();
  const { signInWithEmail } = useAuth();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  const onSubmit = async () => {
    setError(null);
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      await signInWithEmail(email, password);
    } catch (e: any) {
      const msg: string = e?.message ?? "Sign-in failed.";
      if (/invalid login credentials/i.test(msg)) {
        setError("That email and password don't match.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.kb}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <View style={styles.topRow}>
              <Pressable
                onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
                style={styles.back}
                hitSlop={8}
                accessibilityLabel="Back"
              >
                <ArrowLeft color={theme.text} size={22} />
              </Pressable>
              <Image source={require("@/assets/images/tryal-wordmark.png")} style={styles.brandLogo} contentFit="contain" accessibilityLabel="Tryal" />
              <View style={styles.backSpacer} />
            </View>

            <View style={styles.header}>
              <UiText weight={800} style={styles.title} accessibilityRole="header">
                Welcome back<UiText weight={800} style={styles.dot}>.</UiText>
              </UiText>
              <UiText style={styles.sub}>Sign in to start posting.</UiText>
            </View>

            <View style={styles.form}>
              <AuthField
                label="Email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@email.com"
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
              />
              <AuthField
                ref={passwordRef}
                label="Password"
                value={password}
                onChangeText={setPassword}
                placeholder="Your password"
                secureTextEntry
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={() => void onSubmit()}
              />
              {error ? (
                <View style={styles.errorBox}>
                  <UiText style={styles.error}>{error}</UiText>
                </View>
              ) : null}

              <PrimaryButton label="Sign in" onPress={onSubmit} loading={loading} style={{ marginTop: 6 }} />

              <Pressable onPress={() => router.replace("/(auth)/sign-up")} style={styles.switch} hitSlop={6}>
                <UiText style={styles.switchText}>
                  New to Tryal? <UiText weight={800} style={styles.switchAccent}>Create an account</UiText>
                </UiText>
              </Pressable>
            </View>

            <Pressable
              onPress={() => Linking.openURL("https://brendanmccormack2025-sketch.github.io/DropDay-Legal/privacy.html")}
              style={styles.privacyLink}
            >
              <FileText size={14} color={theme.textDim} />
              <UiText style={styles.privacyText}>Privacy Policy</UiText>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 24 },
  kb: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: 24 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
  },
  backSpacer: { width: 44 },
  brandLogo: { width: 66, height: 27 },
  header: { gap: 8, marginTop: 36, marginBottom: 28 },
  title: { color: theme.text, fontSize: 36, lineHeight: 42, letterSpacing: -0.8 },
  dot: { color: theme.accent, fontSize: 36, lineHeight: 42 },
  sub: { color: theme.textMuted, fontSize: 16 },
  form: { gap: 16 },
  errorBox: { backgroundColor: "rgba(232,41,28,0.08)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  error: { color: theme.danger, fontSize: 14, fontWeight: "600" as const },
  switch: { alignItems: "center", marginTop: 4, paddingVertical: 6 },
  switchText: { color: theme.textMuted, fontSize: 15 },
  switchAccent: { color: theme.accent },
  privacyLink: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center", marginTop: "auto", paddingTop: 24, paddingVertical: 8, paddingHorizontal: 12 },
  privacyText: { color: theme.textDim, fontSize: 13, fontWeight: "500" as const },
});
