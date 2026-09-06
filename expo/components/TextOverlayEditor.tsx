import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Modal,
  View,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  Platform,
  LayoutAnimation,
} from "react-native";
import UiText from "@/components/UiText";
import { Check, Ellipsis } from "lucide-react-native";
import { theme } from "@/constants/theme";
import type { TextBackgroundStyle } from "@/providers/PostsProvider";
import { BG_STYLES, resolveBgMeta } from "@/components/DraggableTextOverlay";

interface TextOverlayEditorProps {
  visible: boolean;
  initialText: string;
  initialBackgroundStyle: TextBackgroundStyle;
  onDone: (text: string, backgroundStyle: TextBackgroundStyle) => void;
  onCancel: () => void;
}

export default function TextOverlayEditor({
  visible,
  initialText,
  initialBackgroundStyle,
  onDone,
  onCancel,
}: TextOverlayEditorProps) {
  const [text, setText] = useState(initialText);
  const [bgStyle, setBgStyle] = useState<TextBackgroundStyle>(initialBackgroundStyle);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // ── Reset state when the editor opens ────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setText(initialText);
      setBgStyle(initialBackgroundStyle);
      setShowSettings(false);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [visible, initialText, initialBackgroundStyle]);

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

  // ── Dismiss keyboard & settings on hide ──────────────────────────────────
  useEffect(() => {
    if (!visible) {
      Keyboard.dismiss();
      setShowSettings(false);
    }
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

  const toggleSettings = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setShowSettings((p) => !p);
  }, []);

  const selectBgStyle = useCallback((style: TextBackgroundStyle) => {
    setBgStyle(style);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setShowSettings(false);
  }, []);

  if (!visible) return null;

  const canConfirm = text.trim().length > 0;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.wrapper} pointerEvents="box-none">
        {/* Subtle dim backdrop — tapping dismisses */}
        <Pressable style={styles.backdrop} onPress={onCancel}>
          <View style={styles.backdropFill} />
        </Pressable>

        {/* Toolbar — positioned above the keyboard */}
        <View
          style={[styles.toolbarContainer, { bottom: Math.max(keyboardHeight, 0) }]}
          pointerEvents="box-none"
        >
          {/* Settings panel */}
          {showSettings && (
            <View style={styles.settingsPanel}>
              {BG_STYLES.map((style) => (
                <Pressable
                  key={style}
                  onPress={() => selectBgStyle(style)}
                  style={[
                    styles.styleChip,
                    bgStyle === style && styles.styleChipActive,
                  ]}
                  accessibilityLabel={`Select ${style} background`}
                >
                  <BgChipPreview
                    bgStyle={style}
                    isActive={bgStyle === style}
                  />
                </Pressable>
              ))}
            </View>
          )}

          {/* Main toolbar row */}
          <View style={styles.toolbar}>
            {/* Text input */}
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder="Type something…"
              placeholderTextColor="rgba(255,255,255,0.3)"
              style={styles.input}
              maxLength={100}
              multiline
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleDone}
              keyboardAppearance="dark"
            />

            {/* Background-style cycle button */}
            <Pressable
              onPress={cycleBgStyle}
              style={styles.iconBtn}
              hitSlop={8}
              accessibilityLabel="Change background style"
            >
              <MiniBgPreview bgStyle={bgStyle} />
            </Pressable>

            {/* Confirm button */}
            <Pressable
              onPress={handleDone}
              style={[
                styles.iconBtn,
                styles.doneBtn,
                !canConfirm && styles.doneBtnDisabled,
              ]}
              hitSlop={8}
              disabled={!canConfirm}
              accessibilityLabel="Done"
            >
              <Check
                color={canConfirm ? "#fff" : "rgba(255,255,255,0.2)"}
                size={18}
              />
            </Pressable>

            {/* Settings toggle */}
            <Pressable
              onPress={toggleSettings}
              style={[styles.iconBtn, showSettings && styles.iconBtnActive]}
              hitSlop={8}
              accessibilityLabel="More text options"
            >
              <Ellipsis
                color={
                  showSettings
                    ? theme.accent
                    : "rgba(255,255,255,0.5)"
                }
                size={18}
              />
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
              borderRadius: 3,
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

// ── Background-style chip preview (for the settings panel) ────────────────

function BgChipPreview({
  bgStyle,
  isActive,
}: {
  bgStyle: TextBackgroundStyle;
  isActive: boolean;
}) {
  const meta = resolveBgMeta(bgStyle, "#FFFFFF");
  const showBg = meta.bgOpacity > 0 && meta.bgColor !== "transparent";

  return (
    <View style={chipStyles.wrap}>
      {showBg && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: meta.bgColor,
              opacity: meta.bgOpacity,
              borderRadius: 6,
            },
          ]}
        />
      )}
      <UiText
        style={[
          chipStyles.letter,
          { color: meta.textColor },
          isActive && chipStyles.letterActive,
        ]}
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
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdropFill: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.18)",
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
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: "rgba(22,22,36,0.97)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  input: {
    flex: 1,
    color: "#fff",
    fontSize: 16,
    fontWeight: "600" as const,
    minHeight: 36,
    maxHeight: 80,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 10,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  iconBtnActive: {
    backgroundColor: "rgba(10,132,255,0.15)",
  },
  doneBtn: {
    backgroundColor: "rgba(10,132,255,0.18)",
  },
  doneBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  settingsPanel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginHorizontal: 10,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "rgba(22,22,36,0.97)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  styleChip: {
    width: 44,
    height: 44,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.08)",
  },
  styleChipActive: {
    borderColor: theme.accent,
    borderWidth: 2,
  },
});

const miniStyles = StyleSheet.create({
  wrap: {
    width: 26,
    height: 20,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  letter: {
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },
});

const chipStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    fontSize: 13,
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },
  letterActive: {
    // Keep the same style; active indication is via border
  },
});
