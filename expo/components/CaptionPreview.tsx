import React, { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from "react-native";

import type { CaptionStyle } from "@/lib/editModel";
import type { OverlayFontWeight } from "@/lib/editStyles";
import type { EditorCaptionLine } from "@/lib/transcription/captionLines";
import {
  CAPTION_STYLE_CONFIG,
  effectiveCaptionStyle,
  settleCaptionStyle,
  styledSpec,
} from "@/lib/transcription/captionStyle";

const WEIGHTS: Record<OverlayFontWeight, "400" | "500" | "600" | "700" | "800" | "900"> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  heavy: "800",
  black: "900",
};

/** A touch that moves less than this (px) and ends within TAP_MS is a tap. */
const TAP_SLOP = 8;
const TAP_MS = 350;
const DOUBLE_TAP_MS = 300;

type Props = {
  lines: EditorCaptionLine[];
  /** Playhead on the edited timeline, ms. */
  positionMs: number;
  frameW: number;
  frameH: number;
  /** The rendered preview already shows the burned-in captions: keep only the tap target. */
  invisible: boolean;
  /** The clip-wide caption box (size and position); undefined = the preset's own. */
  style?: CaptionStyle | null;
  /** True while the video plays: the selection ends. */
  isPlaying?: boolean;
  onEditStart: () => void;
  onEdit: (lineIndex: number, text: string) => void;
  /** A drag or pinch ended: the new clip-wide box (one undo step). */
  onStyleCommit?: (style: CaptionStyle) => void;
};

const touchDistance = (e: GestureResponderEvent) => {
  const t = e.nativeEvent.touches;
  if (t.length < 2) return 0;
  const dx = t[0]!.pageX - t[1]!.pageX;
  const dy = t[0]!.pageY - t[1]!.pageY;
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Captions drawn over the editor preview from the same style as the burned-in ones (the "trial"
 * preset with the clip-wide caption box applied, scaled to the frame like the native renderer).
 * Tap selects (bounding box + "Edit text"), drag moves, pinch resizes, double-tap or the button
 * edits the text. Size and position are shared by every caption.
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
}: Props) {
  const stored = useMemo(() => effectiveCaptionStyle(style), [style]);
  const [live, setLive] = useState<CaptionStyle | null>(null);
  const [snapped, setSnapped] = useState(false);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<TextInput>(null);
  const shown = live ?? stored;
  const spec = useMemo(() => styledSpec(shown), [shown]);
  const px = frameW / 1080;

  const activeIndex = lines.findIndex((l) => positionMs >= l.startMs && positionMs < l.endMs);
  const index = editing ?? activeIndex;
  const line = index >= 0 ? lines[index] : undefined;

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (isPlaying) setSelected(false);
  }, [isPlaying]);

  // Everything the gesture handlers read lives in a ref: PanResponder is created once.
  const latest = useRef({ stored, frameW, frameH, onStyleCommit, onEditStart, index, line, selected });
  latest.current = { stored, frameW, frameH, onStyleCommit, onEditStart, index, line, selected };
  const liveRef = useRef<CaptionStyle | null>(null);
  const lastTapRef = useRef(0);

  const startEditing = () => {
    const cur = latest.current;
    if (!cur.line) return;
    cur.onEditStart();
    setDraft(cur.line.text.toUpperCase());
    setEditing(cur.index);
  };
  const startEditingRef = useRef(startEditing);
  startEditingRef.current = startEditing;

  const responder = useMemo(() => {
    let start = stored;
    let startDist = 0;
    let startAt = 0;
    let moved = false;
    let pinched = false;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const cur = latest.current;
        start = liveRef.current ?? cur.stored;
        startAt = Date.now();
        moved = false;
        pinched = e.nativeEvent.touches.length >= 2;
        startDist = pinched ? touchDistance(e) : 0;
      },
      onPanResponderMove: (e, g) => {
        const cur = latest.current;
        const aspect = cur.frameH / Math.max(1, cur.frameW);
        if (e.nativeEvent.touches.length >= 2) {
          const d = touchDistance(e);
          if (!pinched || startDist === 0) {
            pinched = true;
            startDist = d;
            start = liveRef.current ?? start;
            return;
          }
          moved = true;
          const next = settleCaptionStyle({ ...start, scale: start.scale * (d / startDist) }, aspect);
          liveRef.current = next.style;
          setLive(next.style);
          setSnapped(next.snappedX);
          return;
        }
        if (Math.abs(g.dx) + Math.abs(g.dy) > TAP_SLOP) moved = true;
        if (!moved || pinched) return;
        const next = settleCaptionStyle(
          {
            ...start,
            yCenter: start.yCenter + g.dy / cur.frameH,
            xCenter: CAPTION_STYLE_CONFIG.horizontalNative ? start.xCenter + g.dx / cur.frameW : start.xCenter,
          },
          aspect,
        );
        liveRef.current = next.style;
        setLive(next.style);
        setSnapped(next.snappedX);
      },
      onPanResponderRelease: () => {
        const cur = latest.current;
        if (!moved && Date.now() - startAt < TAP_MS && !pinched) {
          const now = Date.now();
          if (now - lastTapRef.current < DOUBLE_TAP_MS) {
            lastTapRef.current = 0;
            startEditingRef.current();
          } else {
            lastTapRef.current = now;
            setSelected((s) => !s);
          }
        } else if (liveRef.current) {
          setSelected(true);
          cur.onStyleCommit?.(liveRef.current);
        }
        liveRef.current = null;
        setLive(null);
        setSnapped(false);
      },
      onPanResponderTerminate: () => {
        liveRef.current = null;
        setLive(null);
        setSnapped(false);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!line || frameW <= 0) return null;

  const box = {
    backgroundColor: spec.backgroundColor,
    paddingHorizontal: (spec.backgroundPadding ?? 0) * px,
    paddingVertical: (spec.backgroundPadding ?? 0) * px,
    maxWidth: frameW * (spec.maxWidth ?? 0.86),
    borderRadius: (spec.cornerRadius ?? 0) * px,
  };
  const text = {
    color: spec.color,
    fontSize: spec.fontSize * px,
    fontWeight: WEIGHTS[spec.fontWeight],
    textAlign: "center" as const,
    letterSpacing: (spec.letterSpacing ?? 0) * px,
  };
  const gesturing = live !== null;
  const textHidden = invisible && editing === null && !gesturing;
  const anchorLeft = frameW * (spec.xCenter ?? 0.5);

  const commit = () => {
    if (editing !== null) onEdit(editing, draft);
    setEditing(null);
  };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {gesturing && snapped && <View pointerEvents="none" style={[styles.guide, { left: frameW / 2 - 0.5, height: frameH }]} />}
      <View
        pointerEvents="box-none"
        style={[styles.anchor, { top: frameH * spec.yCenter, left: anchorLeft - frameW / 2, width: frameW }]}
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
          <View {...responder.panHandlers} style={[box, selected && styles.selectedBox]}>
            <Text style={[text, textHidden && styles.hidden]}>{spec.uppercase ? line.text.toUpperCase() : line.text}</Text>
          </View>
        )}
        {selected && editing === null && !gesturing && (
          <Pressable
            onPress={startEditing}
            hitSlop={8}
            style={[styles.editButton, { marginTop: 8 }]}
            accessibilityRole="button"
            accessibilityLabel="Edit text"
          >
            <Text style={styles.editButtonText}>Edit text</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", height: 0, alignItems: "center", justifyContent: "center" },
  hidden: { opacity: 0 },
  input: { minWidth: 80, padding: 0 },
  selectedBox: { borderWidth: 1.5, borderColor: "#FFFFFF", borderStyle: "dashed" },
  guide: { position: "absolute", top: 0, width: 1, backgroundColor: "#FFD400" },
  editButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
  },
  editButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});
