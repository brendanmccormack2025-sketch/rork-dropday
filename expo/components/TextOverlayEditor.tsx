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
import { SCRIM_OPACITY, editorLayout } from "@/lib/textEditorLayout";
import { theme } from "@/constants/theme";
import type { TextBackgroundStyle } from "@/providers/PostsProvider";
import { BG_STYLES, resolveBgMeta } from "@/components/DraggableTextOverlay";

interface TextOverlayEditorProps {
  visible: boolean;
  initialText: string;
  initialBackgroundStyle: TextBackgroundStyle;
  onDone: (text: string, backgroundStyle: TextBackgroundStyle) => void;
  onCancel: () => void;
  /** Called as the text or style changes, so the video preview shows it live. */
  onLiveChange?: (text: string, backgroundStyle: TextBackgroundStyle) => void;
}

export default function TextOverlayEditor({
  visible,
  initialText,
  initialBackgroundStyle,
  onDone,
  onCancel,
  onLiveChange,
}: TextOverlayEditorProps) {
  const [text, setText] = useState(initialText);
  const [bgStyle, setBgStyle] = useState<TextBackgroundStyle>(initialBackgroundStyle);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const { height: screenH } = useWindowDimensions();

  // ── Reset state when the editor opens ────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setText(initialText);
      setBgStyle(initialBackgroundStyle);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [visible, initialText, initialBackgroundStyle]);

  // ── The video preview follows what is typed ───────────────────────────────
  useEffect(() => {
    if (visible) onLiveChange?.(text, bgStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, text, bgStyle]);

  // ── Track keyboard height ────────────────────────────────────────────────
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!visible) Keyboard.dismiss();
  }, [visible]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleDone = () => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      onDone(trimmed, bgStyle);
    }
  };

  const cycleBgStyle = useCallback(() => {
    setBgStyle((prev) => {
      const idx = BG_STYLES.indexOf(prev);
      return BG_STYLES[(idx + 1) % BG_STYLES.length]!;
    });
  }, []);

  if (!visible) return null;

  const canConfirm = text.trim().length > 0;
  const layout = editorLayout(screenH, keyboardHeight);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.wrapper} pointerEvents="box-none">
        {/* 1. Tap anywhere over the preview to close. Draws nothing, so the video stays clear. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Close text editor" />

        {/* 2. The only dimming: behind the keyboard. */}
        {layout.scrim.height > 0 && (
          <View
            pointerEvents="none"
            style={[styles.scrim, { top: layout.scrim.top, height: layout.scrim.height }]}
          />
        )}

        {/* 3. The input bar, above the keyboard and above the scrim, at full strength. */}
        <View
          style={[styles.toolbarContainer, { bottom: Math.max(keyboardHeight, 0) }]}
          pointerEvents="box-none"
        >
          <View style={styles.toolbar}>
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder="Type something…"
              placeholderTextColor="rgba(10,10,10,0.4)"
              style={styles.input}
              maxLength={100}
              multiline
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleDone}
              keyboardAppearance="light"
            />

            <Pressable
              onPress={cycleBgStyle}
              style={styles.styleBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Change text style"
            >
              <MiniBgPreview bgStyle={bgStyle} />
            </Pressable>

            <Pressable
              onPress={handleDone}
              style={[styles.doneBtn, !canConfirm && styles.doneBtnOff]}
              hitSlop={8}
              disabled={!canConfirm}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Check color="#fff" size={20} strokeWidth={3} />
            </Pressable>
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
    <View style={miniStyles.wrap}>
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
  wrapper: {
    flex: 1,
  },
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: `rgba(0,0,0,${SCRIM_OPACITY})`,
  },
  toolbarContainer: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#D8D3C4",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  input: {
    flex: 1,
    color: "#0A0A0A",
    fontSize: 16,
    fontWeight: "600" as const,
    minHeight: 40,
    maxHeight: 80,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(10,10,10,0.06)",
    borderRadius: 8,
  },
  styleBtn: {
    width: 44,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "rgba(10,10,10,0.35)",
  },
  doneBtn: {
    width: 44,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.accent,
  },
  doneBtnOff: {
    opacity: 0.45,
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
