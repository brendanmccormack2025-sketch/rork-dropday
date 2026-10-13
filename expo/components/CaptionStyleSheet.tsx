import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { isLoaded } from "expo-font";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { CaptionStyle } from "@/lib/editModel";
import { hexToRgba, paletteById, paletteFor, type PaletteRole } from "@/lib/palette";
import {
  availableCaptionFonts,
  previewFontFamily,
  resolveCaptionLook,
  type CaptionOutline,
  type EmbeddedFonts,
} from "@/lib/transcription/captionPresets";

export type CaptionLookPatch = {
  fontId?: string;
  textColor?: string;
  backgroundColor?: string;
  uppercase?: boolean;
  shadow?: boolean;
  /** null removes the outline. */
  outline?: CaptionOutline | null;
  outlineColor?: string;
};

type Props = {
  visible: boolean;
  /** The stored style (its look fields may be absent: the Trial look). */
  style: CaptionStyle | null | undefined;
  /** False on a build that cannot render a font: the font row is hidden. */
  supportsFont: boolean;
  /** PostScript names of the Google Fonts this build embeds (none on 1.0.4): only those fonts are offered. */
  embeddedFonts?: EmbeddedFonts;
  /** True only on a build that burns an outline in (1.0.5): the outline controls are hidden otherwise. */
  supportsOutline?: boolean;
  onChange: (patch: CaptionLookPatch) => void;
  onReset: () => void;
  onClose: () => void;
};

type Target = PaletteRole;
const TAB_LABEL: Record<Target, string> = { text: "Text", outline: "Outline", background: "Background" };
const SIZES: CaptionOutline[] = ["thin", "medium", "thick"];
const SIZE_BAR: Record<CaptionOutline, number> = { thin: 2, medium: 4, thick: 7 };

/**
 * Caption style sheet, in the same rounded design as the text editor: font chips labelled in their own font, a row
 * of Text / Outline / Background tabs over the one shared palette, and Outline / Shadow / Background switches that
 * work in any combination. Every tap applies instantly (the live preview follows; the render re-runs after its usual
 * debounce) and is one undo step. The colors are exactly the ones picked: a low contrast only shows a hint.
 */
export default function CaptionStyleSheet({ visible, style, supportsFont, embeddedFonts = [], supportsOutline = false, onChange, onReset, onClose }: Props) {
  const look = resolveCaptionLook(style);
  const [target, setTarget] = useState<Target>("text");
  const [lastBackground, setLastBackground] = useState("black");
  const hasBackground = look.backgroundColorId !== "none";
  const outlineOn = look.outline !== null;
  const active: Target = target === "outline" && !(supportsOutline && outlineOn) ? "text" : target === "background" && !hasBackground ? "text" : target;
  const colors = paletteFor(active);
  const currentId = active === "text" ? look.textColorId : active === "outline" ? (look.outline?.colorId ?? "black") : look.backgroundColorId;
  const tabs: Target[] = supportsOutline ? ["text", "outline", "background"] : ["text", "background"];
  const fonts = availableCaptionFonts(supportsFont, embeddedFonts);

  const pick = (id: string) => {
    if (active === "text") onChange({ textColor: id });
    else if (active === "outline") onChange({ outlineColor: id });
    else {
      setLastBackground(id);
      onChange({ backgroundColor: id });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />
          <UiText weight={800} style={styles.title}>
            Caption style
          </UiText>

          {fonts.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
              {fonts.map((f) => {
                const on = look.fontId === f.id;
                const family = f.fontName ? previewFontFamily(f.fontName) : undefined;
                // a font that is not loaded in JS is drawn in the system font (the chip never fails)
                const usable = family && isLoaded(family) ? family : undefined;
                return (
                  <Pressable
                    key={f.id}
                    onPress={() => onChange({ fontId: f.id })}
                    style={[styles.fontChip, on && styles.chipOn]}
                    accessibilityRole="button"
                    accessibilityLabel={`Font ${f.label}`}
                    accessibilityState={{ selected: on }}
                  >
                    <UiText style={[styles.fontChipText, usable ? { fontFamily: usable } : { fontWeight: "800" }, on && styles.chipTextOn]} numberOfLines={1}>
                      {f.label}
                    </UiText>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.rowBetween}>
            <View style={styles.chipRowPlain}>
              {[
                { id: "normal", label: "Aa", on: !look.uppercase, value: false },
                { id: "caps", label: "AA", on: look.uppercase, value: true },
              ].map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => onChange({ uppercase: c.value })}
                  style={[styles.caseChip, c.on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityLabel={c.value ? "All caps" : "Normal case"}
                  accessibilityState={{ selected: c.on }}
                >
                  <UiText style={[styles.caseText, c.on && styles.chipTextOn]}>{c.label}</UiText>
                </Pressable>
              ))}
            </View>
            {active === "outline" && (
              <View style={styles.chipRowPlain}>
                {SIZES.map((sz) => {
                  const on = look.outline?.size === sz;
                  return (
                    <Pressable
                      key={sz}
                      onPress={() => onChange({ outline: sz })}
                      style={[styles.sizeChip, on && styles.chipOn]}
                      accessibilityRole="button"
                      accessibilityLabel={`Outline ${sz}`}
                      accessibilityState={{ selected: on }}
                    >
                      <View style={[styles.sizeBar, { height: SIZE_BAR[sz] }, on && styles.sizeBarOn]} />
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.tabs}>
            {tabs.map((t) => {
              const enabled = t === "text" || (t === "outline" ? outlineOn : hasBackground);
              const on = active === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setTarget(t)}
                  disabled={!enabled}
                  style={[styles.tab, on && styles.chipOn, !enabled && styles.dimmed]}
                  accessibilityRole="button"
                  accessibilityLabel={`${TAB_LABEL[t]} color`}
                  accessibilityState={{ selected: on, disabled: !enabled }}
                >
                  <UiText style={[styles.tabText, on && styles.chipTextOn]}>{TAB_LABEL[t]}</UiText>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.palette}>
            {colors.map((c) => {
              const on = currentId === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => pick(c.id)}
                  style={styles.swatchHit}
                  accessibilityRole="button"
                  accessibilityLabel={`${TAB_LABEL[active]} ${c.label}`}
                  accessibilityState={{ selected: on }}
                >
                  <View style={[styles.swatch, c.hex.length === 9 && styles.swatchChecker, on && styles.swatchOn]}>
                    <View style={[StyleSheet.absoluteFill, { borderRadius: 16, backgroundColor: hexToRgba(c.hex) }]} />
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.switches}>
            {supportsOutline && (
              <Switch
                label="Outline"
                on={outlineOn}
                onPress={() => {
                  if (outlineOn) {
                    onChange({ outline: null });
                    setTarget("text");
                  } else {
                    onChange({ outline: "thin", outlineColor: paletteById(look.outline?.colorId)?.id ?? "black" });
                    setTarget("outline");
                  }
                }}
              />
            )}
            <Switch label="Shadow" on={look.shadow} onPress={() => onChange({ shadow: !look.shadow })} />
            <Switch
              label="Background"
              on={hasBackground}
              onPress={() => {
                if (hasBackground) {
                  setLastBackground(look.backgroundColorId);
                  onChange({ backgroundColor: "none" });
                  setTarget("text");
                } else {
                  onChange({ backgroundColor: lastBackground });
                  setTarget("background");
                }
              }}
            />
          </View>

          {look.lowContrast && <UiText style={styles.note}>The text and background are close in color. Your colors are kept as picked.</UiText>}

          <View style={styles.actions}>
            <Pressable onPress={onReset} hitSlop={8} style={styles.resetBtn}>
              <UiText style={styles.secondary}>Reset to Trial style</UiText>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={8} style={styles.doneBtn}>
              <UiText style={styles.primary}>Done</UiText>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Switch({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.switchBtn, on && styles.switchOn]} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}>
      <View style={[styles.dot, on && styles.dotOn]} />
      <UiText style={[styles.switchText, on && styles.switchTextOn]}>{label}</UiText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { backgroundColor: theme.bg, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28, gap: 12, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(10,10,10,0.18)" },
  title: { fontSize: 17, color: theme.text },
  chipScroll: { flexGrow: 0, marginHorizontal: -16 },
  chipRow: { paddingHorizontal: 16, gap: 8, alignItems: "center" },
  chipRowPlain: { flexDirection: "row", gap: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fontChip: { height: 40, paddingHorizontal: 16, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  chipOn: { backgroundColor: theme.text, borderColor: theme.text },
  fontChipText: { fontSize: 17, color: theme.text },
  chipTextOn: { color: "#FFFFFF" },
  caseChip: { minWidth: 56, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  caseText: { fontSize: 17, fontWeight: "800" as const, color: theme.text },
  sizeChip: { width: 44, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  sizeBar: { width: 22, borderRadius: 3, backgroundColor: theme.text },
  sizeBarOn: { backgroundColor: "#FFFFFF" },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { height: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  tabText: { fontSize: 13, fontWeight: "700" as const, color: theme.text },
  dimmed: { opacity: 0.35 },
  palette: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  swatchHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: "rgba(10,10,10,0.14)", overflow: "hidden" },
  swatchChecker: { backgroundColor: "#8E8E93" },
  swatchOn: { borderColor: theme.accent, borderWidth: 3 },
  switches: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  switchBtn: { minWidth: 100, height: 40, borderRadius: 20, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  switchOn: { backgroundColor: theme.text },
  switchText: { fontSize: 13, fontWeight: "700" as const, color: theme.text },
  switchTextOn: { color: "#FFFFFF" },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: "rgba(10,10,10,0.35)" },
  dotOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  note: { fontSize: 11, color: theme.textMuted },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  resetBtn: { height: 40, justifyContent: "center" },
  secondary: { fontSize: 14, color: theme.textMuted, fontWeight: "700" as const },
  doneBtn: { height: 40, paddingHorizontal: 22, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.accent },
  primary: { fontSize: 14, color: "#FFFFFF", fontWeight: "800" as const },
});
