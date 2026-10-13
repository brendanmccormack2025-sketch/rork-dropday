import React from "react";
import type { LayoutChangeEvent, TextStyle } from "react-native";
import { isLoaded } from "expo-font";

import HuggingText from "@/components/HuggingText";
import { overlayFont, type TextLayout } from "@/lib/feedLayout";
import { resolveAppearance, rgbaOf, shadowOf, type LookSource } from "@/lib/textLook";

/** "#RRGGBB" and an opacity -> "rgba(r,g,b,a)". */
function withOpacity(hex: string, opacity: number): string {
  if (opacity >= 1) return hex;
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
}

type Props = {
  text: string;
  /** The overlay's look fields (font, color, style, outline, shadow; or the older background preset). */
  look: LookSource;
  layout: TextLayout;
  onLayout?: (e: LayoutChangeEvent) => void;
  hidden?: boolean;
  children?: React.ReactNode;
};

/**
 * A Text-button overlay as it is drawn in the editor, Preview and the feed (one component, so they cannot drift):
 * the overlay's font, an outlined fill with a soft shadow (the default), a box that hugs the words, or plain text with
 * a shadow. An older overlay (no `look`) is drawn exactly as before.
 */
export default function OverlayText({ text, look, layout, onLayout, hidden, children }: Props) {
  const a = resolveAppearance(look);
  const boxed = a.boxColor !== null;
  const outlined = a.stroke !== null;
  const font = overlayFont(look.fontId, isLoaded);

  let shadow: Pick<TextStyle, "textShadowOffset" | "textShadowRadius" | "textShadowColor"> = {
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 0,
    textShadowColor: "transparent",
  };
  const sh = shadowOf(a, layout.fontSize);
  if (sh && sh.kind === "text") {
    shadow = { textShadowOffset: { width: 0, height: sh.offsetY }, textShadowRadius: sh.radius, textShadowColor: rgbaOf(sh.color, sh.opacity) };
  }

  return (
    <HuggingText
      text={text}
      onLayout={onLayout}
      hidden={hidden}
      maxWidth={layout.maxWidth}
      padX={layout.padX}
      padY={layout.padY}
      radius={layout.cornerRadius}
      mode="lines"
      background={boxed ? withOpacity(a.boxColor as string, a.boxOpacity) : null}
      outline={a.stroke ? { fill: a.textColor, color: a.stroke.color, reach: a.stroke.em * layout.fontSize, shadow: a.shadow } : null}
      textStyle={{ ...font, fontSize: layout.fontSize, lineHeight: layout.lineHeight, color: a.textColor, ...shadow }}
    >
      {children}
    </HuggingText>
  );
}
