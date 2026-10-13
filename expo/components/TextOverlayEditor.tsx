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
  STROKE_SIZES,
  TEXT_FONTS,
  resolveAppearance,
  textFontFamily,
  type EditorAppearance,
  type StrokeSize,
} from "@/lib/textLook";
import { hexToRgba, paletteByHex, paletteFor, type PaletteRole } from "@/lib/palette";
import { theme } from "@/constants/theme";
import HuggingText from "@/components/HuggingText";
import { BG_PAD_X_EM, BG_PAD_Y_EM, BG_RADIUS_EM } from "@/lib/lineBackground";
import { PANEL_GAP, PANEL_PAD, PANEL_ROW_H } from "@/lib/textEditorLayout";

const PLACEHOLDER = "Type something…";
const FIELD_FONT_SIZE = 30;
const FIELD_LINE_HEIGHT = 38;

type Appearance = EditorAppearance;

/** What the palette row below the tabs is picking. */
type Target = PaletteRole;

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
  const [target, setTarget] = useState<Target>("text");
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
      setTarget("text");
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
  const panelH = panelHeight({ fonts: showFonts });
  const layout = editorLayout(screenH, Math.max(keyboardHeight, insets.bottom), insets.top, panelH);
  const look = resolveAppearance(ap);
  const boxed = look.boxColor !== null;
  // the tab shown: a part that is switched off has no color to pick
  const activeTarget: Target = target === "outline" && !ap.outline ? "text" : target === "background" && !ap.background ? "text" : target;
  const colors = paletteFor(activeTarget);
  const currentHex = activeTarget === "text" ? ap.color : activeTarget === "outline" ? ap.outlineColor : ap.bgColor;
  const pick = (hex: string) => set(activeTarget === "text" ? { color: hex } : activeTarget === "outline" ? { outlineColor: hex } : { bgColor: hex });
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
            background={boxed && text.trim().length > 0 ? hexToRgba(ap.bgColor) : null}
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

          {/* what the colors below are for: the text, its outline, its background box */}
          <View style={[styles.row, styles.tabsRow]}>
            <View style={styles.tabs}>
              {(["text", "outline", "background"] as Target[]).map((t) => {
                const enabled = t === "text" || (t === "outline" ? ap.outline : ap.background);
                const on = activeTarget === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => {
                      tick();
                      setTarget(t);
                    }}
                    disabled={!enabled}
                    style={[styles.tab, on && styles.tabOn, !enabled && styles.dimmed]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on, disabled: !enabled }}
                    accessibilityLabel={`${TAB_LABEL[t]} color`}
                  >
                    <UiText style={[styles.tabText, on && styles.tabTextOn]}>{TAB_LABEL[t]}</UiText>
                  </Pressable>
                );
              })}
            </View>
            {activeTarget === "outline" && (
              <View style={styles.segment}>
                {STROKE_SIZES.map((sz) => (
                  <Pressable
                    key={sz}
                    onPress={() => set({ stroke: sz })}
                    style={[styles.segBtn, ap.stroke === sz && styles.segBtnOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: ap.stroke === sz }}
                    accessibilityLabel={`Outline ${sz}`}
                  >
                    <View style={[styles.strokeBar, { height: STROKE_BAR[sz] }, ap.stroke === sz && styles.strokeBarOn]} />
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* the one shared palette (also used by the caption style sheet) */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.row} contentContainerStyle={styles.rowContent}>
            {colors.map((c) => (
              <Swatch key={c.id} hex={c.hex} label={c.label} on={paletteByHex(currentHex)?.id === c.id} onPress={() => pick(c.hex)} />
            ))}
          </ScrollView>

          {/* independent switches: any combination */}
          <View style={[styles.row, styles.optionsRow]}>
            <Switch label="Outline" on={ap.outline} onPress={() => {
              set({ outline: !ap.outline });
              setTarget(!ap.outline ? "outline" : "text");
            }} />
            <Switch label="Shadow" on={ap.shadow} onPress={() => set({ shadow: !ap.shadow })} />
            <Switch label="Background" on={ap.background} onPress={() => {
              set({ background: !ap.background });
              setTarget(!ap.background ? "background" : "text");
            }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const TAB_LABEL: Record<Target, string> = { text: "Text", outline: "Outline", background: "Background" };
const STROKE_BAR: Record<StrokeSize, number> = { thin: 2, medium: 4, thick: 7 };

function Swatch({ hex, label, on, onPress }: { hex: string; label: string; on: boolean; onPress: () => void }) {
  const translucent = hex.length === 9;
  return (
    <Pressable onPress={onPress} style={styles.swatchHit} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={label}>
      <View style={[styles.swatch, translucent && styles.swatchChecker, on && styles.swatchOn]}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: hexToRgba(hex), borderRadius: 15 }]} />
      </View>
    </Pressable>
  );
}

/** A rounded on / off pill. */
function Switch({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.optBtn, on && styles.optBtnOn]} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}>
      <View style={[styles.dot, on && styles.dotOn]} />
      <UiText style={[styles.optLabel, on && styles.optLabelOn]}>{label}</UiText>
    </Pressable>
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
  swatchChecker: { backgroundColor: "#8E8E93" },
  tabsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  tabs: { flexDirection: "row", gap: 6 },
  tab: { height: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" },
  tabOn: { backgroundColor: "#FFFFFF" },
  tabText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" as const },
  tabTextOn: { color: "#000000" },
  optionsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  optBtn: {
    minWidth: 100,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  optBtnOn: { backgroundColor: "#FFFFFF" },
  optLabel: { color: "rgba(255,255,255,0.8)", fontSize: 13, fontWeight: "700" as const },
  optLabelOn: { color: "#000" },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.7)" },
  dotOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  segment: { flexDirection: "row", gap: 6 },
  segBtn: { width: 44, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" },
  segBtnOn: { backgroundColor: "#FFFFFF" },
  strokeBar: { width: 22, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.85)" },
  strokeBarOn: { backgroundColor: "#000" },
  dimmed: { opacity: 0.35 },
});
