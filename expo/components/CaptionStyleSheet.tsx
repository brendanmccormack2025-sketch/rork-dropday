import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import type { CaptionStyle } from "@/lib/editModel";
import {
  CAPTION_BACKGROUNDS,
  CAPTION_FONTS,
  CAPTION_TEXT_COLORS,
  resolveCaptionLook,
  previewFontFamily,
} from "@/lib/transcription/captionPresets";

type Props = {
  visible: boolean;
  /** The stored style (its look fields may be absent: the Trial look). */
  style: CaptionStyle | null | undefined;
  /** False on a build that cannot render a font: the font row is hidden. */
  supportsFont: boolean;
  onChange: (patch: { fontId?: string; textColor?: string; backgroundColor?: string }) => void;
  onReset: () => void;
  onClose: () => void;
};

/**
 * Compact caption style sheet: fonts ("Aa" in each font), text colors, background colors, and
 * "Reset to Trial style". Every tap applies instantly (the live preview follows; the render re-runs
 * after its usual debounce) and is one undo step.
 */
export default function CaptionStyleSheet({ visible, style, supportsFont, onChange, onReset, onClose }: Props) {
  const look = resolveCaptionLook(style);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <UiText weight={800} style={styles.title}>
            Caption style
          </UiText>

          {supportsFont && (
            <>
              <UiText style={styles.label}>Font</UiText>
              <View style={styles.row}>
                {CAPTION_FONTS.map((f) => {
                  const on = look.fontId === f.id;
                  return (
                    <Pressable
                      key={f.id}
                      onPress={() => onChange({ fontId: f.id })}
                      style={[styles.chip, on && styles.chipOn]}
                      accessibilityRole="button"
                      accessibilityLabel={`Font ${f.label}`}
                      accessibilityState={{ selected: on }}
                    >
                      <UiText style={[styles.aa, f.fontName ? { fontFamily: previewFontFamily(f.fontName) } : { fontWeight: "800" }]}>Aa</UiText>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <UiText style={styles.label}>Text</UiText>
          <View style={styles.row}>
            {CAPTION_TEXT_COLORS.map((c) => {
              const on = look.textColorId === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => onChange({ textColor: c.id })}
                  style={[styles.swatchWrap, on && styles.swatchOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`Text ${c.label}`}
                  accessibilityState={{ selected: on }}
                >
                  <View style={[styles.swatch, { backgroundColor: c.color! }]} />
                </Pressable>
              );
            })}
          </View>

          <UiText style={styles.label}>Background</UiText>
          <View style={styles.row}>
            {CAPTION_BACKGROUNDS.map((c) => {
              const on = look.backgroundColorId === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => onChange({ backgroundColor: c.id })}
                  style={[styles.swatchWrap, on && styles.swatchOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`Background ${c.label}`}
                  accessibilityState={{ selected: on }}
                >
                  {c.color === null ? (
                    <View style={[styles.swatch, styles.none]}>
                      <View style={styles.noneSlash} />
                    </View>
                  ) : (
                    <View style={[styles.swatch, { backgroundColor: c.color }]} />
                  )}
                </Pressable>
              );
            })}
          </View>

          {look.adjusted && <UiText style={styles.note}>Adjusted for readability</UiText>}

          <View style={styles.actions}>
            <Pressable onPress={onReset} hitSlop={8}>
              <UiText style={styles.secondary}>Reset to Trial style</UiText>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={8}>
              <UiText style={styles.primary}>Done</UiText>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { backgroundColor: theme.bg, padding: 20, paddingBottom: 32, gap: 8 },
  title: { fontSize: 17, color: theme.text, marginBottom: 4 },
  label: { fontSize: 12, color: theme.textMuted, marginTop: 8 },
  row: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  chip: {
    minWidth: 48,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.card,
    paddingHorizontal: 10,
  },
  chipOn: { borderColor: theme.accent },
  aa: { fontSize: 20, color: theme.text },
  swatchWrap: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: "transparent" },
  swatchOn: { borderColor: theme.accent },
  swatch: { width: 32, height: 32, borderWidth: 1, borderColor: theme.border },
  none: { backgroundColor: theme.card, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  noneSlash: { width: 40, height: 2, backgroundColor: theme.accent, transform: [{ rotate: "-45deg" }] },
  note: { fontSize: 11, color: theme.textMuted, marginTop: 4 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  secondary: { fontSize: 14, color: theme.textMuted, fontWeight: "700" },
  primary: { fontSize: 14, color: theme.accent, fontWeight: "800" },
});
