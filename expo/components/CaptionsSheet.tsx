import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Swipeable from "react-native-gesture-handler/Swipeable";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
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
}: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (editing !== null) onEditLine(editing, draft);
    setEditing(null);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <UiText style={styles.title}>Captions</UiText>
            <Switch
              value={captionsOn}
              onValueChange={onToggle}
              trackColor={{ false: theme.border, true: theme.accent }}
              thumbColor="#fff"
              ios_backgroundColor={theme.border}
              accessibilityLabel="Captions on or off"
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
                      {editing === i ? (
                        <View style={styles.row}>
                          <TextInput
                            value={draft}
                            onChangeText={setDraft}
                            onBlur={commit}
                            onSubmitEditing={commit}
                            autoFocus
                            autoCapitalize="characters"
                            autoCorrect={false}
                            returnKeyType="done"
                            style={styles.input}
                          />
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => {
                            setDraft(line.text.toUpperCase());
                            setEditing(i);
                          }}
                          style={styles.row}
                        >
                          <UiText style={styles.rowText} numberOfLines={1}>
                            {line.text.toUpperCase()}
                          </UiText>
                        </Pressable>
                      )}
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
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: theme.card, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, maxHeight: "70%" },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  styleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, borderTopWidth: 1, borderTopColor: theme.border },
  styleLabel: { color: theme.text, fontSize: 15, fontWeight: "700" as const },
  chevron: { color: theme.textMuted, fontSize: 22 },
  list: { flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.border },
  row: { minHeight: 44, justifyContent: "center", backgroundColor: theme.card, borderBottomWidth: 1, borderBottomColor: theme.border },
  rowText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  input: { color: theme.text, fontSize: 14, fontWeight: "700" as const, minHeight: 44, padding: 0 },
  empty: { color: theme.textDim, fontSize: 14, paddingVertical: 12 },
  delete: { width: 88, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  deleteText: { color: "#fff", fontSize: 14, fontWeight: "900" as const },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  target: { minHeight: 44, justifyContent: "center" },
  doneAlone: { alignSelf: "flex-end", marginTop: 8 },
  secondary: { color: theme.textMuted, fontSize: 15, fontWeight: "700" as const },
  primary: { color: theme.accent, fontSize: 15, fontWeight: "900" as const },
});
