import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { CAPTION_BAR, captionBarBottom } from "@/lib/editorChrome";

/**
 * Editing a caption from the video, TikTok / Instagram style: the video dims, and a bar sits right above the keyboard with
 * the caption's text in a field (focused at once), Cancel on the left and Done on the right. The caption on the video shows the draft as it is typed.
 * Done, the keyboard's Done key and a tap on the dimmed video all save (the editor calls captions.editLine); Cancel and the
 * editor's Back discard (the caption keeps its original text). The bar follows the keyboard's height; it waits a moment for the keyboard so it never flashes at the bottom.
 */
export default function CaptionEditBar({
  text,
  onChangeText,
  onDone,
  onCancel,
  keyboardHeight,
  bottomInset,
}: {
  text: string;
  onChangeText: (text: string) => void;
  /** Saves the draft and closes. */
  onDone: () => void;
  /** Discards the draft and closes: the caption keeps its original text. */
  onCancel: () => void;
  keyboardHeight: number;
  bottomInset: number;
}) {
  // visible once the keyboard height is known, or after a short wait (hardware keyboard / simulator: no soft keyboard)
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setWaited(true), 350);
    return () => clearTimeout(id);
  }, []);
  const ready = keyboardHeight > 0 || waited;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="caption-edit-bar">
      <Pressable style={styles.dim} onPress={onDone} accessibilityLabel="Done editing caption" accessibilityRole="button" />
      <View style={[styles.bar, { bottom: captionBarBottom(keyboardHeight, bottomInset), opacity: ready ? 1 : 0 }]}>
        <Pressable onPress={onCancel} style={styles.cancel} hitSlop={6} accessibilityRole="button" accessibilityLabel="Cancel">
          <UiText style={styles.cancelText}>Cancel</UiText>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          autoFocus
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={onDone}
          placeholder="Caption"
          placeholderTextColor={theme.textDim}
          selectionColor={theme.accent}
          style={styles.input}
          accessibilityLabel="Caption text"
        />
        <Pressable onPress={onDone} style={styles.done} accessibilityRole="button" accessibilityLabel="Done">
          <UiText style={styles.doneText}>Done</UiText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFill, backgroundColor: `rgba(0,0,0,${CAPTION_BAR.dim})` },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    minHeight: CAPTION_BAR.height,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: theme.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  input: { flex: 1, height: 44, borderRadius: 22, paddingHorizontal: 16, backgroundColor: theme.card, color: theme.text, fontSize: 17 },
  cancel: { height: 44, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.textMuted, fontSize: 15, fontWeight: "700" },
  done: { height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  doneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
