import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import type { CaptionStyle } from "@/lib/editModel";
import type { OverlayFontWeight } from "@/lib/editStyles";
import type { EditorCaptionLine } from "@/lib/transcription/captionLines";
import {
  CAPTION_STYLE_CONFIG,
  captionBoxRect,
  defaultCaptionStyle,
  effectiveCaptionStyle,
  estimateBoxSize,
  settleCaptionStyle,
  styledSpec,
  touchRect,
} from "@/lib/transcription/captionStyle";

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
  /** The rendered preview already shows the burned-in captions: this overlay draws nothing of its own. */
  invisible: boolean;
  /** The clip-wide caption box (size and position); undefined = the preset's own. */
  style?: CaptionStyle | null;
  /** True while the video plays: the selection ends. */
  isPlaying?: boolean;
  onEditStart: () => void;
  onEdit: (lineIndex: number, text: string) => void;
  /** A drag or pinch ended: the new clip-wide box (one undo step). */
  onStyleCommit?: (style: CaptionStyle) => void;
  /** Back to the preset's own size and position (one undo step). */
  onStyleReset?: () => void;
  /** Delete this one caption line (one undo step). */
  onDeleteLine?: (lineIndex: number) => void;
};

const sameStyle = (a: CaptionStyle, b: CaptionStyle) =>
  Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(a.yCenter - b.yCenter) < 1e-4 && Math.abs(a.xCenter - b.xCenter) < 1e-4;

/**
 * Captions drawn over the editor preview from the same style as the burned-in ones (the "trial" preset
 * with the clip-wide caption box applied, scaled to the frame like the native renderer).
 *
 * Layout: the caption box is MEASURED (an invisible copy of it reports its real size), then everything is
 * placed from that size: the drawn box, the outline, and the touch target (the box, at least 44 pt in both
 * directions). Nothing depends on a zero-height container, so the target can never collapse.
 *
 * Live preview: the caption is drawn. Rendered preview: the burned-in caption is the picture, so this draws
 * nothing, not even a background, until the caption is selected; then only an outline and "Edit text".
 *
 * Gestures (react-native-gesture-handler): tap selects, drag moves, pinch resizes (together with the drag),
 * double-tap edits the text. All captions follow the one box.
 */
export default function CaptionPreview({
  lines,
  positionMs,
  frameW,
  frameH,
  invisible,
  style,
  isPlaying,
  onEditStart,
  onEdit,
  onStyleCommit,
  onStyleReset,
  onDeleteLine,
}: Props) {
  const stored = useMemo(() => effectiveCaptionStyle(style), [style]);
  const [live, setLive] = useState<CaptionStyle | null>(null);
  const [snapped, setSnapped] = useState(false);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const inputRef = useRef<TextInput>(null);
  const shown = live ?? stored;
  const spec = useMemo(() => styledSpec(shown), [shown]);
  const px = frameW / 1080;

  const activeIndex = lines.findIndex((l) => positionMs >= l.startMs && positionMs < l.endMs);
  const index = editing ?? activeIndex;
  const line = index >= 0 ? lines[index] : undefined;
  const shownText = line ? (spec.uppercase ? line.text.toUpperCase() : line.text) : "";

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (isPlaying) setSelected(false);
  }, [isPlaying]);
  // The text or the size changed: the measured size is stale until the copy reports again.
  useEffect(() => {
    setMeasured(null);
  }, [shownText, shown.scale, frameW]);

  const latest = useRef({ stored, frameW, frameH, onStyleCommit, onEditStart, index, line });
  latest.current = { stored, frameW, frameH, onStyleCommit, onEditStart, index, line };

  const startEditing = useCallback(() => {
    const cur = latest.current;
    if (!cur.line) return;
    cur.onEditStart();
    setDraft(cur.line.text.toUpperCase());
    setEditing(cur.index);
  }, []);

  // One continuous gesture (a drag, a pinch, or both at once) starts from the stored box and ends in one commit.
  const g = useRef({ base: stored, dx: 0, dy: 0, pinch: 1, active: 0, moved: false, last: null as CaptionStyle | null });
  const update = () => {
    const cur = latest.current;
    const gs = g.current;
    const next = settleCaptionStyle(
      {
        scale: gs.base.scale * gs.pinch,
        yCenter: gs.base.yCenter + gs.dy / Math.max(1, cur.frameH),
        xCenter: CAPTION_STYLE_CONFIG.horizontalNative ? gs.base.xCenter + gs.dx / Math.max(1, cur.frameW) : gs.base.xCenter,
      },
      cur.frameH / Math.max(1, cur.frameW),
    );
    gs.last = next.style;
    setLive(next.style);
    setSnapped(next.snappedX);
  };
  const begin = () => {
    const gs = g.current;
    if (gs.active === 0) {
      gs.base = latest.current.stored;
      gs.dx = 0;
      gs.dy = 0;
      gs.pinch = 1;
      gs.moved = false;
      gs.last = null;
    }
    gs.active++;
  };
  const finish = () => {
    const gs = g.current;
    gs.active = Math.max(0, gs.active - 1);
    if (gs.active > 0) return;
    const result = gs.last;
    gs.last = null;
    setLive(null);
    setSnapped(false);
    // A tap that wobbled changes nothing: only a real move or pinch is committed.
    if (gs.moved && result && !sameStyle(result, latest.current.stored)) {
      setSelected(true);
      latest.current.onStyleCommit?.(result);
    }
  };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(6)
      .maxPointers(2)
      .onBegin(begin)
      .onUpdate((e) => {
        g.current.dx = e.translationX;
        g.current.dy = e.translationY;
        g.current.moved = true;
        update();
      })
      .onFinalize(finish);
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(begin)
      .onUpdate((e) => {
        g.current.pinch = e.scale;
        g.current.moved = true;
        update();
      })
      .onFinalize(finish);
    const doubleTap = Gesture.Tap().runOnJS(true).numberOfTaps(2).maxDuration(300).onEnd((_e, ok) => {
      if (ok) startEditing();
    });
    const singleTap = Gesture.Tap().runOnJS(true).maxDuration(300).onEnd((_e, ok) => {
      if (ok) setSelected((s) => !s);
    });
    return Gesture.Simultaneous(Gesture.Exclusive(doubleTap, singleTap), pan, pinch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMeasure = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setMeasured({ w: width, h: height });
  }, []);

  if (!line || frameW <= 0 || frameH <= 0) return null;

  const textStyle = {
    color: spec.color,
    fontSize: spec.fontSize * px,
    fontWeight: WEIGHTS[spec.fontWeight],
    textAlign: "center" as const,
    letterSpacing: (spec.letterSpacing ?? 0) * px,
  };
  const boxStyle = {
    backgroundColor: spec.backgroundColor,
    paddingHorizontal: (spec.backgroundPadding ?? 0) * px,
    paddingVertical: (spec.backgroundPadding ?? 0) * px,
    maxWidth: frameW * (spec.maxWidth ?? 0.86),
    borderRadius: (spec.cornerRadius ?? 0) * px,
  };

  // Placement comes from the measured box (an estimate for the very first frame).
  const size = measured ?? estimateBoxSize(line.text, shown, frameW);
  const rect = captionBoxRect({ w: frameW, h: frameH }, { ...shown, xCenter: spec.xCenter ?? shown.xCenter }, size);
  const touch = touchRect(rect);
  const gesturing = live !== null;
  // Live preview draws the caption; the rendered preview already shows it burned in.
  const drawn = !invisible || gesturing || editing !== null;
  const showOutline = selected && editing === null;
  const customised = !sameStyle(stored, defaultCaptionStyle());

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* A copy of the caption that only measures: invisible, never touched. */}
      <View pointerEvents="none" style={[styles.measure, boxStyle]} onLayout={onMeasure}>
        <Text style={textStyle}>{shownText}</Text>
      </View>

      {gesturing && snapped && <View pointerEvents="none" style={[styles.guide, { left: frameW / 2 - 0.5, height: frameH }]} />}

      {drawn && editing === null && (
        <View pointerEvents="none" style={[styles.abs, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }]}>
          <View style={[boxStyle, styles.fill]}>
            <Text style={textStyle}>{shownText}</Text>
          </View>
        </View>
      )}

      {editing !== null && (
        <View style={[styles.abs, { left: rect.left, top: rect.top, minWidth: rect.width, minHeight: rect.height }]}>
          <View style={[boxStyle, styles.fill]}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={setDraft}
              onBlur={() => {
                if (editing !== null) onEdit(editing, draft);
                setEditing(null);
              }}
              onSubmitEditing={() => {
                if (editing !== null) onEdit(editing, draft);
                setEditing(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              style={[textStyle, styles.input]}
            />
          </View>
        </View>
      )}

      {showOutline && (
        <View pointerEvents="none" style={[styles.abs, styles.outline, { left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }]} />
      )}

      {/* The touch target: the box, at least 44 pt in both directions, transparent. */}
      {editing === null && (
        <GestureDetector gesture={gesture}>
          <View
            collapsable={Platform.OS === "web" ? undefined : false}
            onStartShouldSetResponder={() => true}
            style={[styles.abs, { left: touch.left, top: touch.top, width: touch.width, height: touch.height }]}
          />
        </GestureDetector>
      )}

      {showOutline && !gesturing && (
        <View
          pointerEvents="box-none"
          style={[styles.abs, styles.buttons, { left: 0, width: frameW, top: Math.min(frameH - 36, touch.top + touch.height + 8) }]}
        >
          <Pressable onPress={startEditing} hitSlop={8} style={styles.pill} accessibilityRole="button" accessibilityLabel="Edit text">
            <Text style={styles.pillText}>Edit text</Text>
          </Pressable>
          {onDeleteLine && (
            <Pressable
              onPress={() => {
                setSelected(false);
                onDeleteLine(index);
              }}
              hitSlop={8}
              style={styles.pill}
              accessibilityRole="button"
              accessibilityLabel="Delete this caption line"
            >
              <Text style={styles.pillText}>Delete line</Text>
            </Pressable>
          )}
          {customised && onStyleReset && (
            <Pressable onPress={onStyleReset} hitSlop={8} style={styles.pill} accessibilityRole="button" accessibilityLabel="Reset caption size and position">
              <Text style={styles.pillText}>Reset</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: "absolute" },
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  measure: { position: "absolute", left: 0, top: 0, opacity: 0, alignSelf: "flex-start" },
  input: { minWidth: 80, padding: 0 },
  outline: { borderWidth: 1.5, borderColor: "#FFFFFF", borderStyle: "dashed", borderRadius: 2 },
  guide: { position: "absolute", top: 0, width: 1, backgroundColor: "#FFD400" },
  buttons: { flexDirection: "row", justifyContent: "center", gap: 8 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
  },
  pillText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});
