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

interface TextOverlayEditorProps {
  visible: boolean;
  initialText: string;
  initialBackgroundStyle: TextBackgroundStyle;
  onDone: (text: string, backgroundStyle: TextBackgroundStyle) => void;
  onCancel: () => void;
  /** The Cancel button: a new text is discarded, an existing one is removed (undo brings it back). Defaults to onCancel. */
  onRemove?: () => void;
  /** Called as the text or style changes, so the video preview shows it live. */
  onLiveChange?: (text: string, backgroundStyle: TextBackgroundStyle) => void;
}

export default function TextOverlayEditor({
  visible,
  initialText,
  initialBackgroundStyle,
  onDone,
  onCancel,
  onRemove,
  onLiveChange,
}: TextOverlayEditorProps) {
  const [text, setText] = useState(initialText);
  const [bgStyle, setBgStyle] = useState<TextBackgroundStyle>(initialBackgroundStyle);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const { height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // ── Reset state when the editor opens ────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setText(initialText);
      setBgStyle(initialBackgroundStyle);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [visible, initialText, initialBackgroundStyle]);

  // ── The video behind follows what is typed ────────────────────────────────
  useEffect(() => {
    if (visible) onLiveChange?.(text, bgStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, text, bgStyle]);

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

        {/* The field, centred in the space above the keyboard. */}
        <View
          style={[styles.fieldArea, { top: layout.fieldArea.top, height: layout.fieldArea.height }]}
          pointerEvents="box-none"
        >
          <View style={[styles.fieldBox, boxed && { backgroundColor: meta.bgColor, opacity: 1 }]}>
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder="Type something…"
              placeholderTextColor="rgba(255,255,255,0.55)"
              style={[styles.field, { color: meta.textColor === "#000000" && !boxed ? "#FFFFFF" : meta.textColor }]}
              maxLength={100}
              multiline
              autoFocus
              textAlign="center"
              allowFontScaling={false}
              keyboardAppearance="dark"
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={handleDone}
            />
          </View>
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
  fieldBox: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, maxWidth: "100%" },
  field: {
    minWidth: 120,
    fontFamily: TEXT_FONT_FAMILY,
    fontSize: 30,
    lineHeight: 38,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 4,
    padding: 0,
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
