import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { resolveOverlayStyle, type OverlayFontWeight } from "@/lib/editStyles";
import { CAPTION_STYLE_ID, type EditorCaptionLine } from "@/lib/transcription/captionLines";

const WEIGHTS: Record<OverlayFontWeight, "400" | "500" | "600" | "700" | "800" | "900"> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  heavy: "800",
  black: "900",
};

type Props = {
  lines: EditorCaptionLine[];
  /** Playhead on the edited timeline, ms. */
  positionMs: number;
  frameW: number;
  frameH: number;
  /** The rendered preview already shows the burned-in captions: keep only the tap target. */
  invisible: boolean;
  onEditStart: () => void;
  onEdit: (lineIndex: number, text: string) => void;
};

/**
 * Captions drawn over the editor preview from the same style as the burned-in ones
 * (the "trial" preset, scaled to the frame like the native renderer scales it).
 * Tap the line to edit its text.
 */
export default function CaptionPreview({ lines, positionMs, frameW, frameH, invisible, onEditStart, onEdit }: Props) {
  const spec = resolveOverlayStyle("caption", CAPTION_STYLE_ID);
  const scale = frameW / 1080;
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<TextInput>(null);

  const activeIndex = lines.findIndex((l) => positionMs >= l.startMs && positionMs < l.endMs);
  const index = editing ?? activeIndex;
  const line = index >= 0 ? lines[index] : undefined;

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  if (!line || frameW <= 0) return null;

  const box = {
    backgroundColor: spec.backgroundColor,
    paddingHorizontal: (spec.backgroundPadding ?? 0) * scale,
    paddingVertical: (spec.backgroundPadding ?? 0) * scale,
    maxWidth: frameW * (spec.maxWidth ?? 0.86),
    borderRadius: (spec.cornerRadius ?? 0) * scale,
  };
  const text = {
    color: spec.color,
    fontSize: spec.fontSize * scale,
    fontWeight: WEIGHTS[spec.fontWeight],
    textAlign: "center" as const,
    letterSpacing: (spec.letterSpacing ?? 0) * scale,
  };

  const commit = () => {
    if (editing !== null) onEdit(editing, draft);
    setEditing(null);
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.anchor, { top: frameH * spec.yCenter }, invisible && editing === null && styles.hidden]}
    >
      {editing !== null ? (
        <View style={box}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            style={[text, styles.input]}
          />
        </View>
      ) : (
        <Pressable
          onPress={() => {
            onEditStart();
            setDraft(line.text.toUpperCase());
            setEditing(index);
          }}
          style={box}
        >
          <Text style={text}>{spec.uppercase ? line.text.toUpperCase() : line.text}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", left: 0, right: 0, height: 0, alignItems: "center", justifyContent: "center" },
  hidden: { opacity: 0 },
  input: { minWidth: 80, padding: 0 },
});
