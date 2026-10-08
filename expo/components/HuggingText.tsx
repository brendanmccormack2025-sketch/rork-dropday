import React, { useRef, useState } from "react";
import { StyleSheet, Text, View, type NativeSyntheticEvent, type TextLayoutEventData, type TextStyle, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";

import { backgroundGeometry } from "@/lib/lineBackground";

type Props = {
  text: string;
  /** Font, size, line height, color, shadow ... of the text. lineHeight is required: the box is lines x lineHeight. */
  textStyle: TextStyle & { lineHeight: number; fontSize: number };
  padX: number;
  padY: number;
  radius: number;
  /** Background color; null / transparent draws none. */
  background: string | null;
  /** The widest the box may get (px). */
  maxWidth: number;
  /** "lines": TikTok style, a rounded background per line, joined. "box": one box as wide as the widest line. */
  mode: "lines" | "box";
  /** Invisible: it only measures (layout is unchanged). */
  hidden?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  children?: React.ReactNode;
};

/**
 * Text with a background that hugs the words. A wrapped Text view is as wide as its container, so a plain
 * backgroundColor draws a full-width banner behind two short lines. This measures the real line widths
 * (onTextLayout) and draws the background from them (lib/lineBackground.ts), never wider than the widest line
 * plus padding. The same component draws the editor's and the feed's text overlays and the captions.
 */
export default function HuggingText({ text, textStyle, padX, padY, radius, background, maxWidth, mode, hidden, onLayout, children }: Props) {
  const key = `${text}|${textStyle.fontSize}|${textStyle.fontFamily ?? ""}|${textStyle.fontWeight ?? ""}|${maxWidth}|${textStyle.letterSpacing ?? 0}`;
  const [measured, setMeasured] = useState<{ key: string; widths: number[] } | null>(null);
  const last = useRef<number[]>([]);

  const onTextLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    const widths = e.nativeEvent.lines.map((l) => l.width);
    if (widths.length === 0) return;
    const same = last.current.length === widths.length && last.current.every((w, i) => Math.abs(w - widths[i]!) < 0.5);
    if (same && measured?.key === key) return;
    last.current = widths;
    setMeasured({ key, widths });
  };

  // The width is pinned to the widest line only once the lines of THIS text are known; until then the text wraps freely.
  const fresh = measured?.key === key;
  const textWidth = fresh ? Math.ceil(Math.max(...measured!.widths)) + 1 : undefined;
  const hasBg = !!background && background !== "transparent";
  const geo =
    hasBg && measured
      ? backgroundGeometry(measured.widths.map((width) => ({ width })), textStyle.lineHeight, padX, padY, radius, mode)
      : null;

  return (
    <View
      onLayout={onLayout}
      style={[styles.root, { paddingHorizontal: padX, paddingVertical: padY, maxWidth }, hidden && styles.hidden]}
    >
      {geo && (
        <View pointerEvents="none" style={styles.bg}>
          <Svg width={geo.width} height={geo.height}>
            <Path d={geo.path} fill={background!} />
          </Svg>
        </View>
      )}
      <Text
        allowFontScaling={false}
        onTextLayout={onTextLayout}
        style={[textStyle, styles.text, textWidth ? { width: textWidth } : null]}
      >
        {text}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center", alignSelf: "center" },
  hidden: { opacity: 0 },
  bg: { ...StyleSheet.absoluteFill, alignItems: "center" },
  text: { textAlign: "center", includeFontPadding: false },
});
