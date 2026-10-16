import React, { useRef, useState } from "react";
import {
  Keyboard,
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
import { ArrowLeft, Check, Mail } from "lucide-react-native";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import AuthField from "@/components/AuthField";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";

export default function SignUpScreen() {
  const navigation = useNavigation();
  const { signUpWithEmail } = useAuth();
  const [username, setUsername] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showCheckInbox, setShowCheckInbox] = useState<boolean>(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  // Self-reported 13+ age confirmation
  const [ageConfirmed, setAgeConfirmed] = useState<boolean>(false);

  // Terms acceptance
  const [agreedToTerms, setAgreedToTerms] = useState<boolean>(false);

  const onSubmit = async () => {
    setError(null);
    if (!username.trim() || !email || !password) {
      setError("Pick a username, email, and password.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (!ageConfirmed) {
      setError("You must confirm you are 13 or older to continue.");
      return;
    }
    if (!agreedToTerms) {
      setError("Please agree to the Terms of Use and Privacy Policy to continue.");
      return;
    }
    setLoading(true);
    try {
      await signUpWithEmail(email, password, username, undefined, agreedToTerms, ageConfirmed);
    } catch (e: any) {
      const msg: string = e?.message ?? "Sign-up failed.";
      const code: string = (e as any)?.code ?? "";
      if (/email not confirmed/i.test(msg) || code === "email_not_confirmed") {
        setShowCheckInbox(true);
        return;
      }
      if (/user already registered/i.test(msg)) {
        setError("That email is already registered. Try signing in.");
      } else if (/rate limit/i.test(msg) || /too many/i.test(msg)) {
        setError(
          "Email rate limit reached. Wait ~1 hour, or disable email confirmation in Supabase."
        );
      } else if (/invalid/i.test(msg) && /email/i.test(msg)) {
        setError("That email address isn't accepted. Try another.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  if (showCheckInbox) {
    return (
      <ScreenBackground>
        <SafeAreaView style={styles.safe}>
          <Pressable
            onPress={() => setShowCheckInbox(false)}
            style={[styles.back, { marginTop: 8 }]}
            accessibilityLabel="Back"
          >
            <ArrowLeft color={theme.text} size={22} />
          </Pressable>

          <View style={styles.checkInboxWrap}>
            <View style={styles.mailIconWrap}>
              <Mail color={theme.accent} size={40} />
            </View>
            <UiText style={styles.checkInboxTitle}>Check your inbox!</UiText>
            <UiText style={styles.checkInboxBody}>
              We sent a confirmation link to{" "}
              <UiText style={styles.checkInboxEmail}>{email}</UiText>.
              Tap it, then come back here and sign in.
            </UiText>
            <PrimaryButton
              label="Go to sign in"
              onPress={() => router.replace("/(auth)/sign-in")}
            />
          </View>
        </SafeAreaView>
      </ScreenBackground>
    );
  }

  const checkbox = (checked: boolean, toggle: () => void, children: React.ReactNode) => (
    <Pressable onPress={toggle} style={styles.termsRow} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked ? <Check color="#FFFFFF" size={15} strokeWidth={3} /> : null}</View>
      <UiText style={styles.termsText}>{children}</UiText>
    </Pressable>
  );

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.kb}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Pressable onPress={() => Keyboard.dismiss()} style={styles.innerDismiss} accessible={false}>
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
                  Start posting<UiText weight={800} style={styles.dot}>.</UiText>
                </UiText>
                <UiText style={styles.sub}>Create your account in seconds.</UiText>
              </View>

              <View style={styles.form}>
                <AuthField
                  label="Username"
                  value={username}
                  onChangeText={setUsername}
                  placeholder="yourname"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={24}
                  textContentType="username"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                />
                <AuthField
                  ref={emailRef}
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
                  placeholder="At least 6 characters"
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  returnKeyType="done"
                />
                {error ? (
                  <View style={styles.errorBox}>
                    <UiText style={styles.error}>{error}</UiText>
                  </View>
                ) : null}
                <View style={styles.checks}>
                  {checkbox(ageConfirmed, () => setAgeConfirmed((v) => !v), "I confirm that I am 13 years of age or older.")}
                  {checkbox(
                    agreedToTerms,
                    () => setAgreedToTerms((v) => !v),
                    <>
                      I agree to the{" "}
                      <UiText
                        style={styles.termsLink}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          router.push("/(auth)/legal?tab=terms");
                        }}
                      >
                        Terms of Use
                      </UiText>
                      {" and "}
                      <UiText
                        style={styles.termsLink}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          router.push("/(auth)/legal?tab=privacy");
                        }}
                      >
                        Privacy Policy
                      </UiText>
                      .
                    </>,
                  )}
                </View>
                <PrimaryButton label="Create account" onPress={onSubmit} loading={loading} disabled={!agreedToTerms || !ageConfirmed} style={{ marginTop: 4 }} />
                <Pressable onPress={() => router.replace("/(auth)/sign-in")} style={styles.switch} hitSlop={6}>
                  <UiText style={styles.switchText}>
                    Already have an account? <UiText weight={800} style={styles.switchAccent}>Sign in</UiText>
                  </UiText>
                </Pressable>
              </View>
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
  scrollContent: { flexGrow: 1, paddingBottom: 32 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  backSpacer: { width: 44 },
  dot: { color: theme.accent, fontSize: 36, lineHeight: 42 },
  checks: { gap: 4 },
  errorBox: { backgroundColor: "rgba(232,41,28,0.08)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  innerDismiss: { flex: 1 },
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
  header: { gap: 8, marginTop: 32, marginBottom: 26 },
  brandLogo: { width: 66, height: 27 },
  title: { color: theme.text, fontSize: 36, lineHeight: 42, letterSpacing: -0.8 },
  sub: { color: theme.textMuted, fontSize: 16 },
  form: { gap: 16 },
  fieldWrap: { gap: 8 },
  fieldLabel: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: theme.text,
    fontSize: 16,
  },
  bdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bdMonthPill: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  bdMonthText: { color: theme.text, fontSize: 16, fontWeight: "600" as const },
  bdMonthPlaceholder: { color: theme.textDim, fontSize: 16 },
  bdPillActive: {
    borderColor: theme.accent,
  },
  yearScroll: {
    flexDirection: "row",
    gap: 6,
    paddingVertical: 4,
  },
  yearChip: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: "center",
  },
  monthGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  monthChip: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 56,
    alignItems: "center",
  },
  monthChipActive: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  monthChipText: { color: theme.textMuted, fontSize: 13, fontWeight: "600" as const },
  monthChipTextActive: { color: "#fff", fontSize: 13, fontWeight: "700" as const },
  error: { color: theme.danger, fontSize: 14, fontWeight: "600" as const },
  info: { color: theme.success, fontSize: 13, fontWeight: "500" as const },
  termsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 4,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  termsText: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
  },
  termsLink: {
    color: theme.accent,
    fontWeight: "600" as const,
  },
  switch: { alignItems: "center", marginTop: 4, paddingVertical: 6 },
  switchText: { color: theme.textMuted, fontSize: 15 },
  switchAccent: { color: theme.accent },
  checkInboxWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingBottom: 60,
  },
  mailIconWrap: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: "rgba(232,41,28,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  checkInboxTitle: {
    color: theme.text,
    fontSize: 30,
    fontWeight: "900" as const,
    letterSpacing: -0.6,
  },
  checkInboxBody: {
    color: theme.textMuted,
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 24,
  },
  checkInboxEmail: {
    color: theme.accent,
    fontWeight: "600" as const,
  },
});
