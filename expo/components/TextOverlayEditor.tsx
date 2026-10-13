import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Modal,
  View,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Keyboard,
  Platform,
  useWindowDimensions,
} from "react-native";
import UiText from "@/components/UiText";
import { Check } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { isLoaded } from "expo-font";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { editorLayout, panelHeight } from "@/lib/textEditorLayout";
import {
  EXTRA_TEXT_COLORS,
  STROKE_SIZES,
  TEXT_COLORS,
  TEXT_FONTS,
  nextLook,
  resolveAppearance,
  textFontFamily,
  type StrokeSize,
  type TextAppearance,
  type TextLook,
} from "@/lib/textLook";
import { theme } from "@/constants/theme";
import HuggingText from "@/components/HuggingText";
import { BG_PAD_X_EM, BG_PAD_Y_EM, BG_RADIUS_EM } from "@/lib/lineBackground";
import { PANEL_GAP, PANEL_PAD, PANEL_ROW_H } from "@/lib/textEditorLayout";

const PLACEHOLDER = "Type something…";
const FIELD_FONT_SIZE = 30;
const FIELD_LINE_HEIGHT = 38;

type Appearance = Required<TextAppearance>;

interface TextOverlayEditorProps {
  visible: boolean;
  initialText: string;
  /** The look the text starts with: the defaults for a new text, the overlay's own for an existing one. */
  initialAppearance: Appearance;
  onDone: (text: string, appearance: Appearance) => void;
  onCancel: () => void;
  /** The Cancel button: a new text is discarded, an existing one is removed (undo brings it back). Defaults to onCancel. */
  onRemove?: () => void;
}

function tick(): void {
  try {
    void Haptics.selectionAsync().catch(() => {});
  } catch {
    // no haptics here
  }
}

export default function TextOverlayEditor({
  visible,
  initialText,
  initialAppearance,
  onDone,
  onCancel,
  onRemove,
}: TextOverlayEditorProps) {
  const [text, setText] = useState(initialText);
  const [ap, setAp] = useState<Appearance>(initialAppearance);
  const [showFonts, setShowFonts] = useState(true);
  const [showExtra, setShowExtra] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const { height: screenH, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // ── Reset state when the editor opens ────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setText(initialText);
      setAp(initialAppearance);
      setShowFonts(true);
      setShowExtra(false);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialText]);

  // ── Track keyboard height ────────────────────────────────────────────────
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!visible) Keyboard.dismiss();
  }, [visible]);

  const handleDone = () => {
    const trimmed = text.trim();
    if (trimmed.length > 0) onDone(trimmed, ap);
    else onCancel();
  };

  const set = useCallback((patch: Partial<Appearance>) => {
    tick();
    setAp((prev) => ({ ...prev, ...patch }));
  }, []);

  if (!visible) return null;

  const canConfirm = text.trim().length > 0;
  const panelH = panelHeight({ fonts: showFonts, extraColors: showExtra });
  const layout = editorLayout(screenH, Math.max(keyboardHeight, insets.bottom), insets.top, panelH);
  const look = resolveAppearance(ap);
  const boxed = look.boxColor !== null;
  const family = textFontFamily(ap.fontId, isLoaded);
  const padX = BG_PAD_X_EM * FIELD_FONT_SIZE;
  const padY = BG_PAD_Y_EM * FIELD_FONT_SIZE;
  const radius = BG_RADIUS_EM * FIELD_FONT_SIZE;
  // The invisible mirror sizes the box (and the per-line background); a trailing newline still takes a line.
  const mirrorText = text.length === 0 ? PLACEHOLDER : text.endsWith("\n") ? `${text} ` : text;
  const fieldFont = { fontFamily: family, fontSize: FIELD_FONT_SIZE, lineHeight: FIELD_LINE_HEIGHT };
  // While typing the field shows the fill, the font and the box; the outline is drawn on the finished text (a soft
  // halo in the outline color stands in for it here, as a TextInput cannot stroke its letters).
  const fieldShadow = look.stroke
    ? { textShadowColor: look.stroke.color, textShadowRadius: 3, textShadowOffset: { width: 0, height: 0 } }
    : look.shadow
      ? { textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } }
      : { textShadowColor: "transparent", textShadowRadius: 0, textShadowOffset: { width: 0, height: 0 } };

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={onCancel}>
      <View style={styles.wrapper}>
        {/* The video stays visible under a light dim; tapping it finishes. */}
        <Pressable
          style={[styles.dim, { backgroundColor: `rgba(0,0,0,${layout.dim.opacity})` }]}
          onPress={handleDone}
          accessibilityLabel="Finish text"
        />

        {/* Controls, above the dim: normal, enabled buttons. */}
        <View style={[styles.controls, { top: layout.controls.top, height: layout.controls.height }]} pointerEvents="box-none">
          <Pressable onPress={onRemove ?? onCancel} hitSlop={10} style={styles.cancelBtn} accessibilityRole="button" accessibilityLabel="Cancel">
            <UiText style={styles.cancelText}>Cancel</UiText>
          </Pressable>
          <View style={styles.controlsRight}>
            <Pressable
              onPress={() => {
                tick();
                setShowFonts((v) => !v);
              }}
              hitSlop={8}
              style={[styles.styleBtn, showFonts && styles.styleBtnOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: showFonts }}
              accessibilityLabel="Fonts"
            >
              <UiText style={[styles.aa, { fontFamily: family }, showFonts && { color: "#fff" }]}>Aa</UiText>
            </Pressable>
            <Pressable
              onPress={handleDone}
              hitSlop={8}
              disabled={!canConfirm}
              style={[styles.doneBtn, !canConfirm && styles.doneBtnOff]}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Check color="#fff" size={22} strokeWidth={3} />
            </Pressable>
          </View>
        </View>

        {/* ONE copy of the text, edited in place (Instagram style): the field looks like the finished text, the
            background hugging each line. The overlay itself is hidden on the video while this is open. */}
        <View
          style={[styles.fieldArea, { top: layout.fieldArea.top, height: layout.fieldArea.height }]}
          pointerEvents="box-none"
        >
          <HuggingText
            text={mirrorText}
            maxWidth={Math.max(120, width - 48)}
            padX={padX}
            padY={padY}
            radius={radius}
            mode="lines"
            background={boxed && text.trim().length > 0 ? (look.boxColor as string) : null}
            textStyle={{ ...fieldFont, color: "transparent" }}
          >
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={PLACEHOLDER}
              placeholderTextColor="rgba(255,255,255,0.55)"
              style={[styles.field, fieldFont, fieldShadow, { left: padX, right: padX, top: padY, bottom: padY, color: look.textColor }]}
              maxLength={100}
              multiline
              scrollEnabled={false}
              autoFocus
              textAlign="center"
              allowFontScaling={false}
              keyboardAppearance="dark"
              selectionColor="#FFFFFF"
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={handleDone}
            />
          </HuggingText>
        </View>

        {/* Options, on top of the keyboard: fonts, colors, style. */}
        <View style={[styles.panel, { top: layout.panel.top, height: layout.panel.height }]} pointerEvents="box-none">
          {showFonts && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.row} contentContainerStyle={styles.rowContent}>
              {TEXT_FONTS.map((f) => {
                const on = f.id === ap.fontId;
                return (
                  <Pressable
                    key={f.id}
                    onPress={() => set({ fontId: f.id })}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={f.label}
                  >
                    <UiText style={[styles.chipText, { fontFamily: textFontFamily(f.id, isLoaded) }, on && styles.chipTextOn]} numberOfLines={1}>
                      {f.label}
                    </UiText>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.row} contentContainerStyle={styles.rowContent}>
            {TEXT_COLORS.map((c) => (
              <Swatch key={c.id} hex={c.hex} label={c.label} on={ap.color.toUpperCase() === c.hex} onPress={() => set({ color: c.hex })} />
            ))}
            <Pressable
              onPress={() => {
                tick();
                setShowExtra((v) => !v);
              }}
              style={styles.swatchHit}
              accessibilityRole="button"
              accessibilityState={{ selected: showExtra }}
              accessibilityLabel="More colors"
            >
              <View style={[styles.swatch, styles.rainbow, showExtra && styles.swatchOn]}>
                <UiText style={styles.rainbowText}>+</UiText>
              </View>
            </Pressable>
          </ScrollView>

          {showExtra && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.row} contentContainerStyle={styles.rowContent}>
              {EXTRA_TEXT_COLORS.map((c) => (
                <Swatch key={c.id} hex={c.hex} label={c.label} on={ap.color.toUpperCase() === c.hex} onPress={() => set({ color: c.hex })} />
              ))}
            </ScrollView>
          )}

          <View style={[styles.row, styles.optionsRow]}>
            <Pressable onPress={() => set({ look: nextLook(ap.look) })} style={styles.optBtn} accessibilityRole="button" accessibilityLabel={`Style: ${LOOK_LABEL[ap.look]}. Tap to change`}>
              <LookIcon look={ap.look} />
              <UiText style={styles.optLabel}>{LOOK_LABEL[ap.look]}</UiText>
            </Pressable>
            <View style={[styles.segment, ap.look !== "outline" && styles.dimmed]} pointerEvents={ap.look === "outline" ? "auto" : "none"}>
              {STROKE_SIZES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => set({ stroke: s })}
                  style={[styles.segBtn, ap.stroke === s && styles.segBtnOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: ap.stroke === s }}
                  accessibilityLabel={`Outline ${s}`}
                >
                  <View style={[styles.strokeBar, { height: STROKE_BAR[s] }, ap.stroke === s && styles.strokeBarOn]} />
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={() => set({ shadow: !ap.shadow })}
              style={[styles.optBtn, ap.shadow && styles.optBtnOn, ap.look === "box" && styles.dimmed]}
              disabled={ap.look === "box"}
              accessibilityRole="button"
              accessibilityState={{ selected: ap.shadow }}
              accessibilityLabel="Shadow"
            >
              <UiText style={[styles.shadowAa, ap.shadow && styles.shadowAaOn]}>Aa</UiText>
              <UiText style={styles.optLabel}>Shadow</UiText>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const LOOK_LABEL: Record<TextLook, string> = { outline: "Outline", box: "Box", plain: "Plain" };
const STROKE_BAR: Record<StrokeSize, number> = { thin: 2, medium: 4, thick: 7 };

function Swatch({ hex, label, on, onPress }: { hex: string; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.swatchHit} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={label}>
      <View style={[styles.swatch, { backgroundColor: hex }, on && styles.swatchOn]} />
    </Pressable>
  );
}

/** The style button's little picture: the same "Aa" drawn outlined, in a box, or plain. */
function LookIcon({ look }: { look: TextLook }) {
  return (
    <View style={[iconStyles.wrap, look === "box" && iconStyles.box]}>
      <UiText
        style={[
          iconStyles.letter,
          look === "box" && { color: "#000" },
          look === "outline" && { textShadowColor: "#000", textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } },
          look === "plain" && { textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
        ]}
      >
        Aa
      </UiText>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: { flex: 1 },
  dim: { ...StyleSheet.absoluteFill },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  cancelBtn: { minHeight: 44, justifyContent: "center" },
  cancelText: { color: "#fff", fontSize: 16, fontWeight: "700" as const },
  controlsRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  styleBtn: {
    minWidth: 48,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 8,
  },
  styleBtnOn: { backgroundColor: "rgba(255,255,255,0.28)" },
  aa: { color: "#000", fontSize: 18 },
  doneBtn: {
    width: 48,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.accent,
  },
  doneBtnOff: { opacity: 0.5 },
  fieldArea: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  field: {
    position: "absolute",
    textAlign: "center",
    padding: 0,
    margin: 0,
    includeFontPadding: false,
  },
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingVertical: PANEL_PAD,
    gap: PANEL_GAP,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  row: { height: PANEL_ROW_H, flexGrow: 0 },
  rowContent: { paddingHorizontal: 12, alignItems: "center", gap: 8 },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  chipOn: { backgroundColor: "#FFFFFF" },
  chipText: { color: "#FFFFFF", fontSize: 17 },
  chipTextOn: { color: "#000000" },
  swatchHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: "rgba(255,255,255,0.55)" },
  swatchOn: { borderColor: "#FFFFFF", borderWidth: 3, transform: [{ scale: 1.12 }] },
  rainbow: { backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  rainbowText: { color: "#fff", fontSize: 18, fontWeight: "800" as const, lineHeight: 20 },
  optionsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  optBtn: {
    minWidth: 84,
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  optBtnOn: { backgroundColor: "rgba(255,255,255,0.32)" },
  optLabel: { color: "#fff", fontSize: 13, fontWeight: "700" as const },
  segment: { flexDirection: "row", gap: 6 },
  segBtn: { width: 44, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" },
  segBtnOn: { backgroundColor: "#FFFFFF" },
  strokeBar: { width: 22, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.85)" },
  strokeBarOn: { backgroundColor: "#000" },
  dimmed: { opacity: 0.35 },
  shadowAa: { color: "rgba(255,255,255,0.7)", fontSize: 15, fontWeight: "800" as const },
  shadowAaOn: { color: "#fff", textShadowColor: "rgba(0,0,0,0.9)", textShadowRadius: 4, textShadowOffset: { width: 1, height: 2 } },
});

const iconStyles = StyleSheet.create({
  wrap: { minWidth: 30, height: 24, borderRadius: 5, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  box: { backgroundColor: "#FFFFFF" },
  letter: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" as const },
});
