import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View, useWindowDimensions } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Swipeable from "react-native-gesture-handler/Swipeable";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { CAPTIONS_EDIT_BAR_HEIGHT, CAPTIONS_SHEET_MAX_FRACTION } from "@/lib/editorChrome";
import type { EditorCaptionLine } from "@/lib/transcription/captionLines";

type Props = {
  visible: boolean;
  /** Captions on: drawn in the editor and burned into the post. Off removes them all (nothing else changes). */
  captionsOn: boolean;
  onToggle: (value: boolean) => void;
  lines: EditorCaptionLine[];
  /** Tap a line to edit its text. */
  onEditLine: (index: number, text: string) => void;
  /** Swipe a line to delete it. */
  onDeleteLine: (index: number) => void;
  onStyle: () => void;
  onResetStyle: () => void;
  onClose: () => void;
  /** The sheet's height (0 when closed), so the editor can slide the video up and keep the caption visible above it. */
  onHeight?: (height: number) => void;
};

/**
 * The Captions panel: the on/off switch, Style, every caption line (tap to edit its text, swipe to delete it)
 * and "Reset to Trial style". Switching captions off never changes the cuts.
 */
export default function CaptionsSheet({
  visible,
  captionsOn,
  onToggle,
  lines,
  onEditLine,
  onDeleteLine,
  onStyle,
  onResetStyle,
  onClose,
  onHeight,
}: Props) {
  const { height: windowH } = useWindowDimensions();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (editing !== null) onEditLine(editing, draft);
    setEditing(null);
  };
  useEffect(() => {
    if (!visible) {
      setEditing(null);
      onHeight?.(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  // While a line is edited the panel is only that line, in a compact bar just above the keyboard: the video (with the
  // caption on it) stays visible, and the line being typed is never hidden by the keyboard.
  const editingLine = editing !== null && captionsOn ? lines[editing] : null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable style={styles.backdrop} onPress={editingLine ? commit : onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} pointerEvents="box-none">
          {editingLine ? (
            <View
              style={[styles.editBar, { minHeight: CAPTIONS_EDIT_BAR_HEIGHT }]}
              onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
            >
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={commit}
                autoFocus
                autoCapitalize="sentences"
                autoCorrect={false}
                returnKeyType="done"
                style={styles.editInput}
                accessibilityLabel="Caption line"
              />
              <Pressable onPress={commit} hitSlop={8} style={styles.target} accessibilityRole="button" accessibilityLabel="Done editing">
                <UiText style={styles.primary}>Done</UiText>
              </Pressable>
            </View>
          ) : (
            <View
              style={[styles.sheet, { maxHeight: Math.round(windowH * CAPTIONS_SHEET_MAX_FRACTION) }]}
              onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
            >
              {/* A clean row: the name and the switch (cuts and text are not touched). */}
              <View style={styles.titleRow}>
                <UiText style={styles.title}>Captions</UiText>
                <Switch
                  value={captionsOn}
                  onValueChange={onToggle}
                  trackColor={{ false: theme.border, true: theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={theme.border}
                  accessibilityLabel={captionsOn ? "Captions on" : "Captions off"}
                />
              </View>

              {captionsOn && (
                <>
                  <Pressable onPress={onStyle} style={styles.styleRow} accessibilityRole="button" accessibilityLabel="Caption style">
                    <UiText style={styles.styleLabel}>Style</UiText>
                    <UiText style={styles.chevron}>›</UiText>
                  </Pressable>

                  <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
                    {lines.length === 0 ? (
                      <UiText style={styles.empty}>No captions yet.</UiText>
                    ) : (
                      lines.map((line, i) => (
                        <Swipeable
                          key={`${line.startMs}-${i}`}
                          overshootRight={false}
                          renderRightActions={() => (
                            <Pressable onPress={() => onDeleteLine(i)} style={styles.delete} accessibilityRole="button" accessibilityLabel="Delete line">
                              <UiText style={styles.deleteText}>Delete</UiText>
                            </Pressable>
                          )}
                        >
                          <Pressable
                            onPress={() => {
                              setDraft(line.text);
                              setEditing(i);
                            }}
                            style={styles.row}
                          >
                            <UiText style={styles.rowText} numberOfLines={1}>
                              {line.text}
                            </UiText>
                          </Pressable>
                        </Swipeable>
                      ))
                    )}
                  </ScrollView>

                  <View style={styles.actions}>
                    <Pressable onPress={onResetStyle} hitSlop={8} style={styles.target}>
                      <UiText style={styles.secondary}>Reset to Trial style</UiText>
                    </Pressable>
                    <Pressable onPress={onClose} hitSlop={8} style={styles.target}>
                      <UiText style={styles.primary}>Done</UiText>
                    </Pressable>
                  </View>
                </>
              )}
              {!captionsOn && (
                <Pressable onPress={onClose} hitSlop={8} style={[styles.target, styles.doneAlone]}>
                  <UiText style={styles.primary}>Done</UiText>
                </Pressable>
              )}
            </View>
          )}
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: { backgroundColor: theme.card, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, borderTopWidth: 1, borderTopColor: theme.border },
  editBar: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.card, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: theme.border },
  editInput: { flex: 1, color: theme.text, fontSize: 16, fontWeight: "700" as const, minHeight: 44, padding: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  styleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, borderTopWidth: 1, borderTopColor: theme.border },
  styleLabel: { color: theme.text, fontSize: 15, fontWeight: "700" as const },
  chevron: { color: theme.textMuted, fontSize: 22 },
  list: { flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.border },
  row: { minHeight: 44, justifyContent: "center", backgroundColor: theme.card, borderBottomWidth: 1, borderBottomColor: theme.border },
  rowText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  empty: { color: theme.textDim, fontSize: 14, paddingVertical: 12 },
  delete: { width: 88, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  deleteText: { color: "#fff", fontSize: 14, fontWeight: "900" as const },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  target: { minHeight: 44, justifyContent: "center" },
  doneAlone: { alignSelf: "flex-end", marginTop: 8 },
  secondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  primary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
});
