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
import FootageStep, { useFootage } from "@/components/money/FootageStep";
import { footageUploader } from "@/lib/footageRuntime";
import {
  DEADLINE_DAYS, EMPTY_FORM, PAY_PRESETS, PAYMENT_LABELS, PAYMENT_METHODS, PLATFORMS, PLATFORM_LABELS, WINDOW_DAYS,
  moneyErrorMessage, validateCampaign, workedExample, type CampaignForm, type FormErrors,
} from "@/lib/moneyCampaign";

const STEP_TITLES = ["Add footage", "What to clip", "Pay", "How you pay"] as const;

/** Post a campaign in four short steps (footage, what to clip, pay, how you pay). Every rule is checked again by the database. */
export default function CreateCampaign() {
  const router = useRouter();
  const qc = useQueryClient();
  const { profile } = useMoney();
  const items = useFootage();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<CampaignForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [other, setOther] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const set = <K extends keyof CampaignForm>(k: K, v: CampaignForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const example = workedExample(f);
  const uploading = items.some((i) => i.state === "queued" || i.state === "compressing" || i.state === "uploading");
  const readyIds = items.filter((i) => i.state === "done" && i.footageId).map((i) => i.footageId!);

  if (profile && !(profile.role === "creator" || profile.role === "both")) {
    return (
      <SettingsScaffold title="Post a campaign">
        <UiText style={s.text}>Switch to Creator or Both to post campaigns.</UiText>
        <PrimaryButton label="Change role" onPress={() => router.replace("/money/onboarding" as never)} />
      </SettingsScaffold>
    );
  }

  /** Check only this step's fields (the full form is checked again at the end, and by the database). */
  const stepErrors = (keys: string[], ids: string[] = ["x"]): FormErrors => {
    const filler = { paymentMethod: "paypal" as const, paymentHandle: "ok", agree: true };
    const r = validateCampaign({ ...f, ...filler }, new Date(), ids);
    return r.ok ? {} : (Object.fromEntries(Object.entries(r.errors).filter(([k]) => keys.includes(k))) as FormErrors);
  };
  const next = () => {
    setServerError(null);
    let e: FormErrors = {};
    if (step === 0) {
      e = stepErrors(["footage", "footageUrl"], items.some((i) => i.state !== "error") ? ["x"] : []);
      // a video that failed is not "no video": say which, so nobody wonders why Next refuses
      if (e.footage && items.length) e = { ...e, footage: "Your video didn't upload. Tap Retry on it (or remove it and add another), or paste a Google Drive / Dropbox link." };
    }
    if (step === 1) e = stepErrors(["title", "description", "fullVideoUrl"]);
    if (step === 2) e = stepErrors(["ratePer1k", "capPerClip", "totalBudget", "guaranteedPerClip"]);
    if (Object.keys(e).length) { setErrors(e); return; }
    setErrors({});
    setStep(step + 1);
  };

  const submit = async () => {
    setServerError(null);
    const r = validateCampaign(f, new Date(), readyIds);
    if (!r.ok) { setErrors(r.errors); return; }
    if (uploading) { setServerError("Some videos are still uploading. Wait until they finish."); return; }
    setErrors({});
    setBusy(true);
    try {
      const id = await createCampaign(r.args);
      await footageUploader.clear();
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
    <Field label={label} value={String(f[k] ?? "")} onChange={(t) => set(k, t as never)} error={errors[k]} noCaps={k === "fullVideoUrl" || k === "paymentHandle"} {...extra} />
  );
  const isPreset = (PAY_PRESETS as readonly number[]).includes(Number(f.ratePer1k)) && !other;

  return (
    <SettingsScaffold title="Post a campaign">
      <UiText style={styles.step}>Step {step + 1} of 4 · {STEP_TITLES[step]}</UiText>

      {step === 0 ? (
        <>
          <CoachMark id="create_footage" />
          <FootageStep items={items} link={f.footageUrl} onLink={(t) => set("footageUrl", t)} linkError={errors.footageUrl} />
          {errors.footage ? <UiText style={styles.error}>{errors.footage}</UiText> : null}
        </>
      ) : null}

      {step === 1 ? (
        <>
          <CoachMark id="create_basics" />
          {fld("title", "Title", { placeholder: "Clip my podcast", max: 60 })}
          {fld("description", "What to clip", { placeholder: "The vibe, do's and don'ts", multiline: true, max: 1000 })}
          {fld("fullVideoUrl", "Full video link (optional)", { placeholder: "youtube.com/watch?v=…" })}
          <UiText style={s.text}>Clippers can send people to your full video. We count the taps for you.</UiText>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <CoachMark id="create_pay" />
          <UiText style={styles.label}>Pay per 1,000 views</UiText>
          <Chips values={[...PAY_PRESETS, "other" as const]} selected={isPreset ? Number(f.ratePer1k) : other ? "other" : null} label={(v) => (v === "other" ? "Other" : `$${v}`)}
            onPick={(v) => { if (v === "other") { setOther(true); set("ratePer1k", ""); } else { setOther(false); set("ratePer1k", String(v)); } }} />
          {other ? fld("ratePer1k", "Rate per 1,000 views ($)", { placeholder: "1.50", keyboard: "decimal-pad" }) : errors.ratePer1k ? <UiText style={styles.error}>{errors.ratePer1k}</UiText> : null}
          {fld("guaranteedPerClip", "Guaranteed per approved clip ($, optional)", { placeholder: "3", keyboard: "decimal-pad" })}
          {fld("capPerClip", "Most one clip can earn ($)", { placeholder: "20", keyboard: "decimal-pad" })}
          {fld("totalBudget", "Total budget ($)", { placeholder: "200", keyboard: "decimal-pad" })}
          {example ? <UiText style={styles.example}>{example}</UiText> : null}
        </>
      ) : null}

      {step === 3 ? (
        <>
          <CoachMark id="create_where" />
          <UiText style={styles.label}>How you pay (plain text, you pay outside the app)</UiText>
          <Chips values={PAYMENT_METHODS} selected={f.paymentMethod} label={(m) => PAYMENT_LABELS[m]} onPick={(m) => set("paymentMethod", m)} />
          {errors.paymentMethod ? <UiText style={styles.error}>{errors.paymentMethod}</UiText> : null}
          {fld("paymentHandle", "Your handle (email, @name or $cashtag)", { placeholder: "@yourname" })}
          <Pressable onPress={() => setMore(!more)} accessibilityRole="button"><UiText style={styles.link}>{more ? "Hide options" : "More options"}</UiText></Pressable>
          {more ? (
            <View style={{ gap: 10 }}>
              <UiText style={styles.label}>Where clippers post</UiText>
              <Chips values={PLATFORMS} selected={f.platforms} label={(p) => PLATFORM_LABELS[p]} multi onPick={(p) => set("platforms", f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p])} />
              {errors.platforms ? <UiText style={styles.error}>{errors.platforms}</UiText> : null}
              <UiText style={styles.label}>View window (days)</UiText>
              <Chips values={WINDOW_DAYS} selected={f.viewWindowDays} label={(d) => String(d)} onPick={(d) => set("viewWindowDays", d)} />
              <UiText style={styles.label}>Submissions close in (days)</UiText>
              <Chips values={DEADLINE_DAYS} selected={f.deadlineDays} label={(d) => String(d)} onPick={(d) => set("deadlineDays", d)} />
              {fld("maxClips", "Most clips per clipper", { placeholder: "5", keyboard: "number-pad" })}
              {fld("minViews", "Views needed before the per-view rate applies", { placeholder: "1000", keyboard: "number-pad" })}
            </View>
          ) : null}
          <View style={styles.agreement}>
            <UiText style={styles.agTitle}>Campaign Agreement</UiText>
            {CAMPAIGN_AGREEMENT.map((line) => <UiText key={line} style={s.text}>• {line}</UiText>)}
            <Check checked={f.agree} onToggle={() => set("agree", !f.agree)} label="I accept the Campaign Agreement" />
            {errors.agree ? <UiText style={styles.error}>{errors.agree}</UiText> : null}
          </View>
          {errors.footage ? <UiText style={styles.error}>{errors.footage}</UiText> : null}
          {uploading ? <UiText style={s.text}>Wait for your video to finish uploading, then post. You can see its progress on step 1 (Back).</UiText> : null}
          {serverError ? <UiText style={styles.error}>{serverError}</UiText> : null}
        </>
      ) : null}

      <View style={{ gap: 10 }}>
        {step < 3 ? <PrimaryButton label="Next" onPress={next} /> : <PrimaryButton label={uploading ? "Wait for your video to finish uploading" : "Post campaign"} onPress={submit} loading={busy} disabled={uploading} />}
        {step > 0 ? <Pressable onPress={() => { setErrors({}); setStep(step - 1); }} accessibilityRole="button"><UiText style={[styles.link, { textAlign: "center" }]}>Back</UiText></Pressable> : null}
      </View>
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
  step: { color: theme.textMuted, fontSize: 13, fontWeight: "700" as const },
  example: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  link: { color: theme.accent, fontSize: 14, fontWeight: "800" as const },
  error: { color: theme.danger, fontSize: 13, fontWeight: "600" as const },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipOn: { borderColor: theme.accent, backgroundColor: "rgba(232,41,28,0.08)" },
  chipText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  chipTextOn: { color: theme.accent },
  agreement: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 6 },
  agTitle: { color: theme.text, fontSize: 16, fontWeight: "900" as const },
});
