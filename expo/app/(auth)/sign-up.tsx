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
import { router } from "expo-router";
import { ArrowLeft, Check, Mail } from "lucide-react-native";

import ScreenBackground from "@/components/ScreenBackground";
import PrimaryButton from "@/components/PrimaryButton";
import DropletLogo from "@/components/DropletLogo";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";

/** Compute age in years from a YYYY-MM-DD string. Returns NaN on bad input. */
function ageFromBirthdate(bd: string): number {
  const d = new Date(bd);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const hadBirthday =
    now.getMonth() > d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() >= d.getDate());
  if (!hadBirthday) age -= 1;
  return age;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function MonthPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (m: number) => void;
}) {
  return (
    <View style={styles.monthGrid}>
      {MONTHS.map((name, i) => {
        const idx = String(i + 1);
        const active = selected === idx;
        return (
          <Pressable
            key={name}
            onPress={() => onSelect(i + 1)}
            style={({ pressed }) => [
              styles.monthChip,
              active && styles.monthChipActive,
              pressed && { opacity: 0.6 },
            ]}
          >
            <UiText
              style={active ? styles.monthChipTextActive : styles.monthChipText}
            >
              {name.slice(0, 3)}
            </UiText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Build the list of days for the selected month/year (1-based). */
function daysInMonth(year: number, month1: number): number {
  if (!year || !month1) return 31;
  return new Date(year, month1, 0).getDate();
}

export default function SignUpScreen() {
  const { signUpWithEmail } = useAuth();
  const [username, setUsername] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showCheckInbox, setShowCheckInbox] = useState<boolean>(false);

  // Birthdate state (day/month/year)
  const [bdYear, setBdYear] = useState<string>("");
  const [bdMonth, setBdMonth] = useState<string>(""); // 1-12
  const [bdDay, setBdDay] = useState<string>("");

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
    // Validate birthdate BEFORE any auth user is created.
    const yNum = parseInt(bdYear, 10);
    const mNum = parseInt(bdMonth, 10);
    const dNum = parseInt(bdDay, 10);
    if (
      !bdYear || !bdMonth || !bdDay ||
      Number.isNaN(yNum) || Number.isNaN(mNum) || Number.isNaN(dNum) ||
      mNum < 1 || mNum > 12 || dNum < 1 || dNum > daysInMonth(yNum, mNum) ||
      yNum < 1900 || yNum > new Date().getFullYear()
    ) {
      setError("Please enter your full birthdate (day, month, year).");
      return;
    }
    const paddedMonth = String(mNum).padStart(2, "0");
    const paddedDay = String(dNum).padStart(2, "0");
    const birthdate = `${yNum}-${paddedMonth}-${paddedDay}`;
    const age = ageFromBirthdate(birthdate);
    if (Number.isNaN(age)) {
      setError("That birthdate doesn't look right. Try again.");
      return;
    }
    if (age < 13) {
      setError("You must be at least 13 to use DropDay.");
      return;
    }
    if (!agreedToTerms) {
      setError("Please agree to the Terms of Use and Privacy Policy to continue.");
      return;
    }
    setLoading(true);
    try {
      await signUpWithEmail(email, password, username, birthdate, true);
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
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kb}
        >
          <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.back}>
            <ArrowLeft color={theme.text} size={22} />
          </Pressable>

          <View style={styles.header}>
            <DropletLogo size={48} />
            <UiText style={styles.title}>Join the drop</UiText>
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
              placeholder="you@dropday.app"
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
            <View style={styles.fieldWrap}>
              <UiText style={styles.fieldLabel}>Birthdate</UiText>
              <View style={styles.bdRow}>
                <TextInput
                  style={styles.bdDay}
                  value={bdDay}
                  onChangeText={(t) => setBdDay(t.replace(/[^0-9]/g, "").slice(0, 2))}
                  placeholder="DD"
                  placeholderTextColor={theme.textDim}
                  keyboardType="number-pad"
                  maxLength={2}
                />
                <View style={styles.bdMonthWrap}>
                  {bdMonth ? (
                    <Pressable
                      onPress={() => setBdMonth("")}
                      style={styles.bdMonthPill}
                    >
                      <UiText style={styles.bdMonthText}>
                        {MONTHS[(parseInt(bdMonth, 10) || 1) - 1]}
                      </UiText>
                    </Pressable>
                  ) : (
                    <View style={styles.bdMonthPill}>
                      <UiText style={styles.bdMonthPlaceholder}>Month</UiText>
                    </View>
                  )}
                </View>
                <TextInput
                  style={styles.bdYear}
                  value={bdYear}
                  onChangeText={(t) => setBdYear(t.replace(/[^0-9]/g, "").slice(0, 4))}
                  placeholder="YYYY"
                  placeholderTextColor={theme.textDim}
                  keyboardType="number-pad"
                  maxLength={4}
                />
              </View>
              {bdMonth ? null : (
                <MonthPicker
                  selected={bdMonth}
                  onSelect={(m) => setBdMonth(String(m))}
                />
              )}
            </View>
            {error ? <UiText style={styles.error}>{error}</UiText> : null}
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
              disabled={!agreedToTerms}
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
    borderRadius: 20,
    backgroundColor: theme.card,
    marginTop: 8,
  },
  header: { alignItems: "center", gap: 8, marginTop: 14, marginBottom: 22 },
  title: { color: theme.text, fontSize: 26, fontWeight: "800" as const },
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
    borderRadius: 14,
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
  bdDay: {
    flex: 0.7,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    color: theme.text,
    fontSize: 16,
    textAlign: "center",
  },
  bdMonthWrap: { flex: 1.6 },
  bdMonthPill: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  bdMonthText: { color: theme.text, fontSize: 16, fontWeight: "600" as const },
  bdMonthPlaceholder: { color: theme.textDim, fontSize: 16 },
  bdYear: {
    flex: 1,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    color: theme.text,
    fontSize: 16,
    textAlign: "center",
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
    borderRadius: 10,
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
    borderRadius: 6,
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
    borderRadius: 36,
    backgroundColor: theme.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  checkInboxTitle: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "800" as const,
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
