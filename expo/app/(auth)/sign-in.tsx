import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useNavigation } from "expo-router";
import { ArrowLeft, FileText } from "lucide-react-native";
import * as Linking from "expo-linking";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import TrialLogo from "@/components/TrialLogo";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";

export default function SignInScreen() {
  const navigation = useNavigation();
  const { signInWithEmail } = useAuth();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kb}
        >
          <Pressable onPress={() => { if (navigation.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.back}>
            <ArrowLeft color={theme.text} size={22} />
          </Pressable>

          <View style={styles.header}>
            <TrialLogo size={48} />
            <UiText style={styles.title}>Welcome back</UiText>
            <UiText style={styles.sub}>Sign in to join the drop.</UiText>
          </View>

          <View style={styles.form}>
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
              placeholder="••••••••"
              secureTextEntry
              autoComplete="password"
            />
            {error ? <UiText style={styles.error}>{error}</UiText> : null}

            <PrimaryButton
              label="Sign in"
              onPress={onSubmit}
              loading={loading}
            />

            <Pressable
              onPress={() => Linking.openURL("https://brendanmccormack2025-sketch.github.io/DropDay-Legal/privacy.html")}
              style={styles.privacyLink}
            >
              <FileText size={14} color={theme.textMuted} />
              <UiText style={styles.privacyText}>Privacy Policy</UiText>
            </Pressable>

          </View>
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
  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
    backgroundColor: theme.card,
    marginTop: 8,
  },
  header: { alignItems: "center", gap: 8, marginTop: 20, marginBottom: 28 },
  title: {
    color: theme.text,
    fontSize: 26,
    fontWeight: "900" as const,
  },
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
  error: {
    color: theme.danger,
    fontSize: 13,
    fontWeight: "500" as const,
  },
  privacyLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  privacyText: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "500" as const,
  },
});
