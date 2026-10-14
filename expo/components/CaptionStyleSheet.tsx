import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { isLoaded } from "expo-font";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { CaptionStyle } from "@/lib/editModel";
import { hexToRgba } from "@/lib/palette";
import { STYLE_TABS, TAB_LABEL, captionPick, captionSelected, swatchesFor, type StyleSwatch, type StyleTab } from "@/lib/styleTabs";
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
  /** The sheet's height when it is shown, so the editor can lift the video clear of it (the caption stays visible while styling). */
  onHeight?: (height: number) => void;
  onChange: (patch: CaptionLookPatch) => void;
  onReset: () => void;
  onClose: () => void;
};

type Target = StyleTab;
const SIZES: CaptionOutline[] = ["thin", "medium", "thick"];
const SIZE_BAR: Record<CaptionOutline, number> = { thin: 2, medium: 4, thick: 7 };

/**
 * Caption style sheet, in the same rounded design as the text editor: font chips labelled in their own font, a row
 * of Text / Outline / Background tabs over the one shared palette, and Outline / Shadow / Background switches that
 * work in any combination. Every tap applies instantly (the live preview follows; the render re-runs after its usual
 * debounce) and is one undo step. The colors are exactly the ones picked: a low contrast only shows a hint.
 */
export default function CaptionStyleSheet({ visible, style, supportsFont, embeddedFonts = [], supportsOutline = false, onHeight, onChange, onReset, onClose }: Props) {
  const look = resolveCaptionLook(style);
  const [target, setTarget] = useState<Target>("text");
  const outlineOn = look.outline !== null;
  // one control set, never disabled (Outline only where the build can burn an outline in)
  const tabs: Target[] = supportsOutline ? STYLE_TABS : STYLE_TABS.filter((t) => t !== "outline");
  const active: Target = tabs.includes(target) ? target : "text";
  const swatches = swatchesFor(active);
  const selectedId = captionSelected(look, active);
  const fonts = availableCaptionFonts(supportsFont, embeddedFonts);

  const pick = (sw: StyleSwatch) => onChange(captionPick(active, sw, look));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
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
              const on = active === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setTarget(t)}
                  style={[styles.tab, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`${TAB_LABEL[t]} color`}
                  accessibilityState={{ selected: on }}
                >
                  <UiText style={[styles.tabText, on && styles.chipTextOn]}>{TAB_LABEL[t]}</UiText>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => onChange({ shadow: !look.shadow })}
              style={[styles.shadowBtn, look.shadow && styles.chipOn]}
              accessibilityRole="switch"
              accessibilityState={{ checked: look.shadow }}
              accessibilityLabel="Shadow"
            >
              <View>
                <UiText style={[styles.shadowGlyph, styles.shadowGlyphBack, look.shadow && styles.shadowGlyphBackOn]}>A</UiText>
                <UiText style={[styles.shadowGlyph, look.shadow && styles.chipTextOn]}>A</UiText>
              </View>
            </Pressable>
          </View>

          <View style={styles.palette}>
            {swatches.map((c) => {
              const on = selectedId === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => pick(c)}
                  style={styles.swatchHit}
                  accessibilityRole="button"
                  accessibilityLabel={`${TAB_LABEL[active]} ${c.label}`}
                  accessibilityState={{ selected: on }}
                >
                  <View style={[styles.swatch, c.hex === null && styles.swatchNone, c.hex !== null && c.hex.length === 9 && styles.swatchChecker, on && styles.swatchOn]}>
                    {c.hex === null ? <View style={styles.noneSlash} /> : <View style={[StyleSheet.absoluteFill, { borderRadius: 16, backgroundColor: hexToRgba(c.hex) }]} />}
                  </View>
                </Pressable>
              );
            })}
          </View>

          {look.lowContrast && <UiText style={styles.note}>The text and background are close in color. Your colors are kept as picked.</UiText>}

          <View style={styles.actions}>
            <Pressable onPress={onReset} hitSlop={8} style={styles.resetBtn}>
              <UiText style={styles.secondary}>Reset to Tryal style</UiText>
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

const styles = StyleSheet.create({
  // No dimming: the caption being styled stays fully visible above the sheet.
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "transparent" },
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
  shadowBtn: { marginLeft: "auto", width: 44, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.card, borderWidth: 1.5, borderColor: "transparent" },
  shadowGlyph: { fontSize: 17, fontWeight: "900" as const, color: theme.text, includeFontPadding: false },
  shadowGlyphBack: { position: "absolute", left: 2, top: 2, color: "rgba(10,10,10,0.3)" },
  shadowGlyphBackOn: { color: "rgba(255,255,255,0.4)" },
  swatchNone: { backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  noneSlash: { width: 36, height: 2, backgroundColor: theme.accent, transform: [{ rotate: "-45deg" }] },
  palette: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  swatchHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: "rgba(10,10,10,0.14)", overflow: "hidden" },
  swatchChecker: { backgroundColor: "#8E8E93" },
  swatchOn: { borderColor: theme.accent, borderWidth: 3 },
  note: { fontSize: 11, color: theme.textMuted },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  resetBtn: { height: 40, justifyContent: "center" },
  secondary: { fontSize: 14, color: theme.textMuted, fontWeight: "700" as const },
  doneBtn: { height: 40, paddingHorizontal: 22, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.accent },
  primary: { fontSize: 14, color: "#FFFFFF", fontWeight: "800" as const },
});
