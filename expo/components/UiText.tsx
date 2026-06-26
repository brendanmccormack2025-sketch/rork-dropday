import React, { useMemo } from "react";
import { Text, type TextProps, type TextStyle } from "react-native";

export type FontWeight = 300 | 400 | 500 | 700 | 800;

const FONT_FAMILIES: Record<FontWeight, string> = {
  300: "PlusJakartaSans_300Light",
  400: "PlusJakartaSans_400Regular",
  500: "PlusJakartaSans_500Medium",
  700: "PlusJakartaSans_700Bold",
  800: "PlusJakartaSans_800ExtraBold",
};

type Props = TextProps & {
  weight?: FontWeight;
};

const FW_MAP: Record<string, FontWeight> = {
  "300": 300,
  light: 300,
  "400": 400,
  normal: 400,
  regular: 400,
  "500": 500,
  medium: 500,
  "600": 700,
  semibold: 700,
  "700": 700,
  bold: 700,
  "800": 800,
  extrabold: 800,
  "900": 800,
  black: 800,
};

/** Resolve fontWeight from a flat or array style into a numeric weight. */
function resolveWeight(style: TextProps["style"]): FontWeight | null {
  if (!style) return null;
  if (Array.isArray(style)) {
    for (let i = style.length - 1; i >= 0; i--) {
      const w = resolveWeight(style[i]);
      if (w !== null) return w;
    }
    return null;
  }
  if (typeof style === "object" && "fontWeight" in style) {
    const fw = (style as TextStyle).fontWeight;
    if (fw === undefined) return null;
    const key = String(fw).toLowerCase();
    return FW_MAP[key] ?? null;
  }
  return null;
}

/** Drop-in replacement for React Native `<Text>` that uses Plus Jakarta Sans
 *  as the default font family. Auto-detects `fontWeight` from the `style` prop
 *  and maps it to the correct font file. Use the `weight` prop for explicit
 *  control (300/400/500/700/800). Defaults to 400 (regular). */
export default function UiText({ weight, style, ...rest }: Props) {
  const fontFamily = useMemo(() => {
    if (weight !== undefined) return FONT_FAMILIES[weight];
    const detected = resolveWeight(style);
    return detected ? FONT_FAMILIES[detected] : FONT_FAMILIES[400];
  }, [weight, style]);

  return (
    <Text style={[{ fontFamily, includeFontPadding: false }, style]} {...rest} />
  );
}
