import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Modal,
  View,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  Platform,
  useWindowDimensions,
} from "react-native";
import UiText from "@/components/UiText";
import { Check } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { editorLayout } from "@/lib/textEditorLayout";
import { TEXT_FONT_FAMILY } from "@/lib/transcription/captionPresets";
import { theme } from "@/constants/theme";
import type { TextBackgroundStyle } from "@/providers/PostsProvider";
import { BG_STYLES, resolveBgMeta } from "@/components/DraggableTextOverlay";
import HuggingText from "@/components/HuggingText";
import { BG_PAD_X_EM, BG_PAD_Y_EM, BG_RADIUS_EM } from "@/lib/lineBackground";

const PLACEHOLDER = "Type something…";
const FIELD_FONT_SIZE = 30;
const FIELD_LINE_HEIGHT = 38;

interface TextOverlayEditorProps {
  visible: boolean;
  initialText: string;
  initialBackgroundStyle: TextBackgroundStyle;
  onDone: (text: string, backgroundStyle: TextBackgroundStyle) => void;
  onCancel: () => void;
  /** The Cancel button: a new text is discarded, an existing one is removed (undo brings it back). Defaults to onCancel. */
  onRemove?: () => void;
}

export default function TextOverlayEditor({
  visible,
  initialText,
  initialBackgroundStyle,
  onDone,
  onCancel,
  onRemove,
}: TextOverlayEditorProps) {
  const [text, setText] = useState(initialText);
  const [bgStyle, setBgStyle] = useState<TextBackgroundStyle>(initialBackgroundStyle);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const { height: screenH, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // ── Reset state when the editor opens ────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setText(initialText);
      setBgStyle(initialBackgroundStyle);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [visible, initialText, initialBackgroundStyle]);

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
    if (trimmed.length > 0) onDone(trimmed, bgStyle);
    else onCancel();
  };

  const cycleBgStyle = useCallback(() => {
    setBgStyle((prev) => {
      const idx = BG_STYLES.indexOf(prev);
      return BG_STYLES[(idx + 1) % BG_STYLES.length]!;
    });
  }, []);

  if (!visible) return null;

  const canConfirm = text.trim().length > 0;
  const layout = editorLayout(screenH, keyboardHeight, insets.top);
  const meta = resolveBgMeta(bgStyle, "#FFFFFF");
  const boxed = meta.bgOpacity > 0 && meta.bgColor !== "transparent";
  const fieldColor = meta.textColor === "#000000" && !boxed ? "#FFFFFF" : meta.textColor;
  const padX = BG_PAD_X_EM * FIELD_FONT_SIZE;
  const padY = BG_PAD_Y_EM * FIELD_FONT_SIZE;
  const radius = BG_RADIUS_EM * FIELD_FONT_SIZE;
  // The invisible mirror sizes the box (and the per-line background); a trailing newline still takes a line.
  const mirrorText = text.length === 0 ? PLACEHOLDER : text.endsWith("\n") ? `${text} ` : text;
  const fieldFont = { fontFamily: TEXT_FONT_FAMILY, fontSize: FIELD_FONT_SIZE, lineHeight: FIELD_LINE_HEIGHT };

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
            <Pressable onPress={cycleBgStyle} hitSlop={8} style={styles.styleBtn} accessibilityRole="button" accessibilityLabel="Change text style">
              <MiniBgPreview bgStyle={bgStyle} />
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

        {/* ONE copy of the text, edited in place (Instagram style): the field looks exactly like the finished text, the
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
            background={boxed && text.trim().length > 0 ? meta.bgColor : null}
            textStyle={{ ...fieldFont, color: "transparent" }}
          >
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={PLACEHOLDER}
              placeholderTextColor="rgba(255,255,255,0.55)"
              style={[styles.field, fieldFont, { left: padX, right: padX, top: padY, bottom: padY, color: fieldColor }]}
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
      </View>
    </Modal>
  );
}

// ── Mini background-style preview (for the cycle button) ──────────────────

function MiniBgPreview({ bgStyle }: { bgStyle: TextBackgroundStyle }) {
  const meta = resolveBgMeta(bgStyle, "#FFFFFF");
  const showBg = meta.bgOpacity > 0 && meta.bgColor !== "transparent";

  return (
    <View style={[miniStyles.wrap, !showBg && { backgroundColor: meta.textColor === "#FFFFFF" ? "#4A4A4A" : "#E5E5E5" }]}>
      {showBg && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: meta.bgColor,
              opacity: meta.bgOpacity,
              borderRadius: 0,
            },
          ]}
        />
      )}
      <UiText
        style={[miniStyles.letter, { color: meta.textColor }]}
        numberOfLines={1}
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
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 4,
    padding: 0,
    margin: 0,
    includeFontPadding: false,
  },
});

const miniStyles = StyleSheet.create({
  wrap: {
    width: 32,
    height: 24,
    borderRadius: 4,
    backgroundColor: "rgba(10,10,10,0.06)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  letter: {
    fontSize: 14,
    fontWeight: "900" as const,
    letterSpacing: 0.2,
  },
});
