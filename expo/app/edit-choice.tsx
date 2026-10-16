import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Check, ChevronLeft, Film, SlidersHorizontal, Sparkles } from "lucide-react-native";

import CaptionsExplainer from "@/components/CaptionsExplainer";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { getAutoEditEnabled } from "@/lib/autoEditSettings";
import { recordBreadcrumb } from "@/lib/clientErrors";
import {
  EDIT_FEATURES,
  EDIT_OPTIONS,
  appliesNothing,
  choiceFor,
  encodeEditChoice,
  needsTranscription,
  type EditChoice,
  type EditFeature,
  type EditMode,
} from "@/lib/editChoice";
import { needsSpeechPrimer, primeSpeechPermission, skipSpeechPrimer } from "@/lib/speechPermission";

const ICONS: Record<EditMode, typeof Film> = { original: Film, auto: Sparkles, custom: SlidersHorizontal };

/**
 * Between picking / recording a video and the editor: how should it be edited? Nothing runs on the video here; the
 * editor starts only the edits chosen (lib/editChoice.ts). The source is untouched either way: back from the editor
 * returns here to choose again, and the editor's own "Keep original" and undo still work.
 * Params are passed through to /edit unchanged, plus `edit`.
 */
export default function EditChoiceScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<Record<string, string>>();
  const [mode, setMode] = useState<EditMode | null>(null);
  const [custom, setCustom] = useState<Record<EditFeature, boolean>>({ silence: true, cleanup: true, captions: true });
  const [autoSilence, setAutoSilence] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [primerFor, setPrimerFor] = useState<EditChoice | null>(null);

  useEffect(() => {
    // "Auto-edit my videos" (Settings) stays the default for pause removal in the AI edit and in Customize.
    getAutoEditEnabled()
      .then((on) => {
        setAutoSilence(on);
        setCustom((c) => ({ ...c, silence: on }));
      })
      .catch(() => {});
  }, []);

  // Back from the editor: the screen can be used again (to change the choice).
  useFocusEffect(
    useCallback(() => {
      busyRef.current = false;
      setBusy(false);
    }, []),
  );

  const openEditor = useCallback(
    (choice: EditChoice) => {
      const effective = choice.mode === "custom" && appliesNothing(choice) ? choiceFor("original") : choice;
      recordBreadcrumb("editChoice: open editor", { edit: encodeEditChoice(effective) });
      const { edit: _old, ...pass } = params;
      router.push({ pathname: "/edit", params: { ...pass, edit: encodeEditChoice(effective) } });
    },
    [params, router],
  );

  const onContinue = useCallback(async () => {
    if (!mode || busyRef.current) return; // one request at a time
    busyRef.current = true;
    setBusy(true);
    const choice = choiceFor(mode, custom, autoSilence);
    try {
      // Captions and cleanup need on-device speech recognition: the one-time explainer + system prompt comes here,
      // before the editor, and only when an edit that needs it was chosen.
      if (needsTranscription(choice) && (await needsSpeechPrimer())) {
        setPrimerFor(choice);
        return; // continues in afterPrimer
      }
      openEditor(choice);
    } catch {
      openEditor(choice);
    }
  }, [mode, custom, autoSilence, openEditor]);

  const afterPrimer = useCallback(
    async (allow: boolean) => {
      const choice = primerFor;
      setPrimerFor(null);
      if (allow) await primeSpeechPermission();
      else await skipSpeechPrimer(); // the editor still opens; it works without speech
      if (choice) openEditor(choice);
    },
    [primerFor, openEditor],
  );

  const back = () => {
    if (busyRef.current) return;
    if (navigation.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };

  const customChoice = choiceFor("custom", custom, autoSilence);
  const continueLabel =
    mode === "original" || (mode === "custom" && appliesNothing(customChoice))
      ? "Continue with original"
      : mode
        ? "Start editing"
        : "Choose an option";

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Pressable onPress={back} style={styles.iconBtn} hitSlop={8} accessibilityLabel="Back">
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <UiText weight={800} style={styles.title}>
            How should we edit it<UiText weight={800} style={styles.titleAccent}>?</UiText>
          </UiText>
          <UiText style={styles.subtitle}>Nothing changes until you choose. Your original video is always kept, so you can come back and choose again.</UiText>

          {EDIT_OPTIONS.map((o) => {
            const Icon = ICONS[o.mode];
            const selected = mode === o.mode;
            return (
              <View key={o.mode} style={[styles.option, selected && styles.optionSelected]}>
                <Pressable
                  onPress={() => !busy && setMode(o.mode)}
                  style={styles.optionHead}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: busy }}
                  accessibilityLabel={o.title}
                  accessibilityHint={o.body}
                >
                  <View style={[styles.optionIcon, selected && styles.optionIconSelected]}>
                    <Icon color={selected ? "#fff" : theme.accent} size={22} />
                  </View>
                  <View style={styles.optionCopy}>
                    <UiText weight={700} style={styles.optionTitle}>
                      {o.title}
                    </UiText>
                    <UiText style={styles.optionBody}>{o.body}</UiText>
                  </View>
                  <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <Check color="#fff" size={14} strokeWidth={3} /> : null}</View>
                </Pressable>
                {o.mode === "custom" && selected ? (
                  <View style={styles.features}>
                    {EDIT_FEATURES.map((f) => (
                      <View key={f.key} style={styles.feature}>
                        <View style={{ flex: 1, gap: 2 }}>
                          <UiText weight={700} style={styles.featureTitle}>
                            {f.title}
                          </UiText>
                          <UiText style={styles.featureBody}>{f.body}</UiText>
                        </View>
                        <Switch
                          value={custom[f.key]}
                          onValueChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
                          disabled={busy}
                          trackColor={{ true: theme.accent, false: theme.border }}
                          thumbColor="#fff"
                          ios_backgroundColor={theme.border}
                          accessibilityLabel={f.title}
                        />
                      </View>
                    ))}
                    {appliesNothing(customChoice) ? <UiText style={styles.featureNote}>Nothing selected: your video stays as it is.</UiText> : null}
                  </View>
                ) : null}
              </View>
            );
          })}
          <UiText style={styles.footnote}>Edits happen on your phone. Nothing is uploaded until you post.</UiText>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable
            onPress={() => void onContinue()}
            disabled={!mode || busy}
            style={({ pressed }) => [styles.cta, (!mode || busy) && styles.ctaDisabled, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !mode || busy, busy }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <UiText weight={800} style={styles.ctaText}>{continueLabel}</UiText>}
          </Pressable>
        </View>
      </SafeAreaView>
      <CaptionsExplainer visible={primerFor !== null} onContinue={() => void afterPrimer(true)} onNotNow={() => void afterPrimer(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  title: { fontSize: 30, lineHeight: 36, letterSpacing: -0.8, color: theme.text, marginTop: 4 },
  titleAccent: { color: theme.accent, fontSize: 30, lineHeight: 36 },
  subtitle: { fontSize: 15, lineHeight: 21, color: theme.textMuted, marginBottom: 8 },
  option: { backgroundColor: theme.card, borderRadius: 22, borderWidth: 2, borderColor: "transparent", overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  optionSelected: { borderColor: theme.accent, backgroundColor: "#FFF7F5" },
  optionHead: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, minHeight: 80 },
  optionIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(232,41,28,0.1)", alignItems: "center", justifyContent: "center" },
  optionIconSelected: { backgroundColor: theme.accent },
  optionCopy: { flex: 1, gap: 3 },
  optionTitle: { fontSize: 17, color: theme.text },
  optionBody: { fontSize: 13, lineHeight: 18, color: theme.textMuted },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  radioOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  features: { marginHorizontal: 16, marginBottom: 12, borderRadius: 16, backgroundColor: theme.card, paddingHorizontal: 14, paddingVertical: 2 },
  feature: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  featureTitle: { fontSize: 15, color: theme.text },
  featureBody: { fontSize: 13, lineHeight: 18, color: theme.textMuted },
  featureNote: { fontSize: 13, color: theme.textDim, paddingBottom: 10 },
  footnote: { fontSize: 12, color: theme.textDim, textAlign: "center", marginTop: 4 },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 },
  cta: { backgroundColor: theme.accent, borderRadius: 28, minHeight: 54, alignItems: "center", justifyContent: "center" },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: "#fff", fontSize: 16 },
});
