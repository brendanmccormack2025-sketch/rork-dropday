import React, { useState } from "react";
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
            style={styles.back}
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

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe}>
        <Pressable onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.back}>
          <ArrowLeft color={theme.text} size={22} />
        </Pressable>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kb}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}
          >
            <Pressable
              onPress={() => { Keyboard.dismiss(); }}
              style={styles.innerDismiss}
            >
              <View style={styles.header}>
            <Image
              source={require("@/assets/images/trial-wordmark.png")}
              style={styles.brandLogo}
              contentFit="contain"
            />
            <UiText style={styles.title}>Start posting</UiText>
            <UiText style={styles.sub}>Create your account in seconds.</UiText>
          </View>

          <View style={styles.form}>
            <Field
              label="Username"
              value={username}
              onChangeText={setUsername}
              placeholder="dropper"
              autoCapitalize="none"
              maxLength={24}
            />
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@email.com"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="At least 6 characters"
              secureTextEntry
              autoComplete="password-new"
            />
            {error ? <UiText style={styles.error}>{error}</UiText> : null}
            <Pressable
              onPress={() => setAgeConfirmed((v) => !v)}
              style={styles.termsRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ageConfirmed }}
            >
              <View
                style={[styles.checkbox, ageConfirmed && styles.checkboxChecked]}
              >
                {ageConfirmed ? (
                  <Check color="#FFFFFF" size={16} strokeWidth={3} />
                ) : null}
              </View>
              <UiText style={styles.termsText}>
                I confirm that I am 13 years of age or older.
              </UiText>
            </Pressable>
            <Pressable
              onPress={() => setAgreedToTerms((v) => !v)}
              style={styles.termsRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreedToTerms }}
            >
              <View
                style={[
                  styles.checkbox,
                  agreedToTerms && styles.checkboxChecked,
                ]}
              >
                {agreedToTerms ? (
                  <Check color="#FFFFFF" size={16} strokeWidth={3} />
                ) : null}
              </View>
              <UiText style={styles.termsText}>
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
              </UiText>
            </Pressable>
            <PrimaryButton
              label="Create account"
              onPress={onSubmit}
              loading={loading}
              disabled={!agreedToTerms || !ageConfirmed}
            />
            <Pressable
              onPress={() => router.replace("/(auth)/sign-in")}
              style={styles.switch}
            >
              <UiText style={styles.switchText}>
                Already have an account?{" "}
                <UiText style={styles.switchAccent}>Sign in</UiText>
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

function Field(
  props: React.ComponentProps<typeof TextInput> & { label: string }
) {
  const { label, style, ...rest } = props;
  return (
    <View style={styles.fieldWrap}>
      <UiText style={styles.fieldLabel}>{label}</UiText>
      <TextInput
        {...rest}
        placeholderTextColor={theme.textDim}
        style={[styles.input, style]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 24 },
  kb: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 40 },
  innerDismiss: { flex: 1 },
  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
    backgroundColor: theme.card,
    marginTop: 8,
  },
  header: { alignItems: "center", gap: 8, marginTop: 14, marginBottom: 22 },
  brandLogo: { width: 96, height: 34 },
  title: { color: theme.text, fontSize: 26, fontWeight: "900" as const },
  sub: { color: theme.textMuted, fontSize: 15 },
  form: { gap: 14 },
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
    borderRadius: 0,
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
    borderRadius: 0,
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
    borderRadius: 0,
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
    borderRadius: 0,
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
  error: { color: theme.danger, fontSize: 13, fontWeight: "500" as const },
  info: { color: theme.success, fontSize: 13, fontWeight: "500" as const },
  termsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 0,
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
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  termsLink: {
    color: theme.accent,
    fontWeight: "600" as const,
  },
  switch: { alignItems: "center", marginTop: 6 },
  switchText: { color: theme.textMuted, fontSize: 14 },
  switchAccent: { color: theme.accent, fontWeight: "700" as const },
  checkInboxWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingBottom: 60,
  },
  mailIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 0,
    backgroundColor: theme.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  checkInboxTitle: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "900" as const,
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
