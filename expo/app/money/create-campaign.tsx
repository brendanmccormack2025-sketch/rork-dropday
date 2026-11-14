import React, { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import Check from "@/components/money/Check";
import CoachMark from "@/components/money/CoachMark";
import { theme } from "@/constants/theme";
import { useMoney } from "@/hooks/useMoney";
import { createCampaign } from "@/lib/moneyApi";
import { CAMPAIGN_AGREEMENT } from "@/lib/moneyContent";
import {
  DEADLINE_DAYS, EMPTY_FORM, PAYMENT_LABELS, PAYMENT_METHODS, PLATFORMS, PLATFORM_LABELS, WINDOW_DAYS,
  moneyErrorMessage, validateCampaign, workedExample, type CampaignForm, type FormErrors,
} from "@/lib/moneyCampaign";

/** Post a campaign. Field groups follow the spec; every rule is checked again by the database. */
export default function CreateCampaign() {
  const router = useRouter();
  const qc = useQueryClient();
  const { profile } = useMoney();
  const [f, setF] = useState<CampaignForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const set = <K extends keyof CampaignForm>(k: K, v: CampaignForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const example = workedExample(f);

  if (profile && !(profile.role === "creator" || profile.role === "both")) {
    return (
      <SettingsScaffold title="Post a campaign">
        <UiText style={s.text}>Switch to Creator or Both to post campaigns.</UiText>
        <PrimaryButton label="Change role" onPress={() => router.replace("/money/onboarding" as never)} />
      </SettingsScaffold>
    );
  }

  const submit = async () => {
    setServerError(null);
    const r = validateCampaign(f);
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    setBusy(true);
    try {
      const id = await createCampaign(r.args);
      await qc.invalidateQueries({ queryKey: ["money"] });
      router.replace(`/money/campaign/${id}` as never);
    } catch (e) {
      setServerError(moneyErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  // (Field and Chips are defined below, outside this component: components created inside a render are re-mounted on every keystroke and lose focus.)
  const fld = (k: keyof CampaignForm, label: string, extra: { placeholder?: string; keyboard?: "default" | "decimal-pad" | "number-pad"; multiline?: boolean; max?: number } = {}) => (
    <Field label={label} value={String(f[k] ?? "")} onChange={(t) => set(k, t as never)} error={errors[k]} noCaps={k === "footageUrl" || k === "paymentHandle"} {...extra} />
  );

  return (
    <SettingsScaffold title="Post a campaign">
      <CoachMark id="create_basics" />
      {fld("title", "Title", { placeholder: "Clip my podcast", max: 60 })}
      {fld("description", "What to clip", { placeholder: "The vibe, do's and don'ts", multiline: true, max: 1000 })}
      {fld("footageUrl", "Footage link (Google Drive or Dropbox)", { placeholder: "https://drive.google.com/…" })}

      <CoachMark id="create_pay" />
      {fld("ratePer1k", "Rate per 1,000 views ($)", { placeholder: "1.50", keyboard: "decimal-pad" })}
      {fld("capPerClip", "Most one clip can earn ($)", { placeholder: "20", keyboard: "decimal-pad" })}
      {fld("totalBudget", "Total budget ($)", { placeholder: "200", keyboard: "decimal-pad" })}
      {fld("guaranteedPerClip", "Guaranteed per approved clip ($, optional)", { placeholder: "3", keyboard: "decimal-pad" })}
      {fld("minViews", "Views needed before the per-view rate applies", { placeholder: "1000", keyboard: "number-pad" })}
      {example ? <UiText style={s.text}>Example: {example}</UiText> : null}

      <CoachMark id="create_where" />
      <UiText style={styles.label}>Where clippers post</UiText>
      <Chips values={PLATFORMS} selected={f.platforms} label={(p) => PLATFORM_LABELS[p]} multi onPick={(p) => set("platforms", f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p])} />
      {errors.platforms ? <UiText style={styles.error}>{errors.platforms}</UiText> : null}
      <UiText style={styles.label}>View window (days)</UiText>
      <Chips values={WINDOW_DAYS} selected={f.viewWindowDays} label={(d) => String(d)} onPick={(d) => set("viewWindowDays", d)} />
      <UiText style={styles.label}>How you pay (plain text, you pay outside the app)</UiText>
      <Chips values={PAYMENT_METHODS} selected={f.paymentMethod} label={(m) => PAYMENT_LABELS[m]} onPick={(m) => set("paymentMethod", m)} />
      {errors.paymentMethod ? <UiText style={styles.error}>{errors.paymentMethod}</UiText> : null}
      {fld("paymentHandle", "Your handle (email, @name or $cashtag)", { placeholder: "@yourname" })}

      <CoachMark id="create_limits" />
      <UiText style={styles.label}>Submissions close in (days)</UiText>
      <Chips values={DEADLINE_DAYS} selected={f.deadlineDays} label={(d) => String(d)} onPick={(d) => set("deadlineDays", d)} />
      {fld("maxClips", "Most clips per clipper", { placeholder: "5", keyboard: "number-pad" })}

      <View style={styles.agreement}>
        <UiText style={styles.agTitle}>Campaign Agreement</UiText>
        {CAMPAIGN_AGREEMENT.map((line) => <UiText key={line} style={s.text}>• {line}</UiText>)}
        <Check checked={f.agree} onToggle={() => set("agree", !f.agree)} label="I accept the Campaign Agreement" />
        {errors.agree ? <UiText style={styles.error}>{errors.agree}</UiText> : null}
      </View>
      {serverError ? <UiText style={styles.error}>{serverError}</UiText> : null}
      <PrimaryButton label="Post campaign" onPress={submit} loading={busy} />
    </SettingsScaffold>
  );
}

function Field({ label, value, onChange, error, placeholder, keyboard, multiline, max, noCaps }: { label: string; value: string; onChange: (t: string) => void; error?: string; placeholder?: string; keyboard?: "default" | "decimal-pad" | "number-pad"; multiline?: boolean; max?: number; noCaps?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <UiText style={styles.label}>{label}</UiText>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textDim}
        keyboardType={keyboard ?? "default"}
        multiline={multiline}
        maxLength={max}
        autoCapitalize={noCaps ? "none" : "sentences"}
        autoCorrect={false}
        style={[s.input, multiline && { minHeight: 110, textAlignVertical: "top" }]}
        accessibilityLabel={label}
      />
      {error ? <UiText style={styles.error}>{error}</UiText> : null}
    </View>
  );
}

function Chips<T extends string | number>({ values, selected, label, onPick, multi }: { values: readonly T[]; selected: T[] | T | null; label: (v: T) => string; onPick: (v: T) => void; multi?: boolean }) {
  return (
    <View style={styles.chips}>
      {values.map((v) => {
        const on = multi ? (selected as T[]).includes(v) : selected === v;
        return (
          <Pressable key={String(v)} onPress={() => onPick(v)} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <UiText style={[styles.chipText, on && styles.chipTextOn]}>{label(v)}</UiText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.textMuted, fontSize: 12, fontWeight: "700" as const, letterSpacing: 0.4, textTransform: "uppercase" },
  error: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipOn: { borderColor: theme.accent, backgroundColor: "rgba(232,41,28,0.08)" },
  chipText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  chipTextOn: { color: theme.accent },
  agreement: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 6 },
  agTitle: { color: theme.text, fontSize: 16, fontWeight: "900" as const },
});
