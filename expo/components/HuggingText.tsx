import React, { useRef, useState } from "react";
import { StyleSheet, Text, View, type NativeSyntheticEvent, type TextLayoutEventData, type TextStyle, type LayoutChangeEvent } from "react-native";
import Svg, { Path, Text as SvgText } from "react-native-svg";

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
  /**
   * A real outline (an SVG stroke, not offset copies): the words are drawn by react-native-svg, stroke layer under
   * fill layer, from the lines this component measures; the Text itself is transparent and only lays the lines out.
   * `reach` is how far the outline extends beyond the letters, in points; `shadow` puts a soft drop shadow behind it.
   */
  outline?: { fill: string; color: string; reach: number; shadow: boolean } | null;
  /**
   * A drop shadow behind everything (the box and the words together), like the renderer's own: the shadow of whatever is
   * drawn, so with a background it falls around the box. Captions use it so the preview matches the burned-in video.
   */
  shadow?: { opacity: number; radius: number; offsetY: number } | null;
  onLayout?: (e: LayoutChangeEvent) => void;
  children?: React.ReactNode;
};

/**
 * Text with a background that hugs the words. A wrapped Text view is as wide as its container, so a plain
 * backgroundColor draws a full-width banner behind two short lines. This measures the real line widths
 * (onTextLayout) and draws the background from them (lib/lineBackground.ts), never wider than the widest line
 * plus padding. The same component draws the editor's and the feed's text overlays and the captions.
 */
export default function HuggingText({ text, textStyle, padX, padY, radius, background, maxWidth, mode, hidden, outline, shadow, onLayout, children }: Props) {
  const key = `${text}|${textStyle.fontSize}|${textStyle.fontFamily ?? ""}|${textStyle.fontWeight ?? ""}|${maxWidth}|${textStyle.letterSpacing ?? 0}`;
  const [measured, setMeasured] = useState<{ key: string; widths: number[]; lines: LineInfo[] } | null>(null);
  const last = useRef<number[]>([]);

  const onTextLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    const widths = e.nativeEvent.lines.map((l) => l.width);
    if (widths.length === 0) return;
    const same = last.current.length === widths.length && last.current.every((w, i) => Math.abs(w - widths[i]!) < 0.5);
    if (same && measured?.key === key) return;
    last.current = widths;
    const lines: LineInfo[] = e.nativeEvent.lines.map((l) => ({
      text: l.text,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      ascender: l.ascender,
      descender: l.descender,
    }));
    setMeasured({ key, widths, lines });
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
      style={[
        styles.root,
        { paddingHorizontal: padX, paddingVertical: padY, maxWidth },
        shadow ? { shadowColor: "#000", shadowOpacity: shadow.opacity, shadowRadius: shadow.radius, shadowOffset: { width: 0, height: shadow.offsetY } } : null,
        hidden && styles.hidden,
      ]}
    >
      {geo && (
        <View pointerEvents="none" style={styles.bg}>
          <Svg width={geo.width} height={geo.height}>
            <Path d={geo.path} fill={background!} />
          </Svg>
        </View>
      )}
      {outline && fresh && measured ? <OutlineLayer measured={measured.lines} textStyle={textStyle} padX={padX} padY={padY} textWidth={textWidth ?? 0} outline={outline} /> : null}
      <Text
        allowFontScaling={false}
        onTextLayout={onTextLayout}
        style={[textStyle, styles.text, outline ? styles.transparent : null, textWidth ? { width: textWidth } : null]}
      >
        {text}
      </Text>
      {children}
    </View>
  );
}

type LineInfo = { text: string; x: number; y: number; width: number; height: number; ascender: number; descender: number };

/** The words as SVG text: an outline layer under a fill layer, one pair per measured line, centred like the Text. */
function OutlineLayer({
  measured,
  textStyle,
  padX,
  padY,
  textWidth,
  outline,
}: {
  measured: LineInfo[];
  textStyle: TextStyle & { lineHeight: number; fontSize: number };
  padX: number;
  padY: number;
  textWidth: number;
  outline: { fill: string; color: string; reach: number; shadow: boolean };
}) {
  const fontSize = textStyle.fontSize;
  const width = Math.ceil(textWidth + 2 * padX);
  const height = Math.ceil(measured.length * textStyle.lineHeight + 2 * padY);
  const shadow = outline.shadow
    ? { shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: fontSize * 0.1, shadowOffset: { width: 0, height: fontSize * 0.04 } }
    : null;
  return (
    <View pointerEvents="none" style={[styles.outlineLayer, { width, height }, shadow]}>
      <Svg width={width} height={height}>
        {measured.map((l, i) => {
          const asc = Math.abs(l.ascender ?? fontSize * 0.8);
          const desc = Math.abs(l.descender ?? fontSize * 0.2);
          // the line is centred in its line height; the baseline sits an ascender below the glyph box's top
          const baseline = padY + l.y + (l.height - (asc + desc)) / 2 + asc;
          const cx = padX + l.x + l.width / 2;
          const common = {
            x: cx,
            y: baseline,
            fontFamily: textStyle.fontFamily,
            fontSize,
            fontWeight: "400" as const,
            textAnchor: "middle" as const,
          };
          return (
            <React.Fragment key={i}>
              <SvgText {...common} fill={outline.color} stroke={outline.color} strokeWidth={outline.reach * 2} strokeLinejoin="round" strokeLinecap="round">
                {l.text.replace(/\n$/, "")}
              </SvgText>
              <SvgText {...common} fill={outline.fill}>
                {l.text.replace(/\n$/, "")}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  outlineLayer: { position: "absolute", left: 0, top: 0 },
  transparent: { color: "transparent" },
  root: { alignItems: "center", justifyContent: "center", alignSelf: "center" },
  hidden: { opacity: 0 },
  bg: { ...StyleSheet.absoluteFill, alignItems: "center" },
  text: { textAlign: "center", includeFontPadding: false },
});
