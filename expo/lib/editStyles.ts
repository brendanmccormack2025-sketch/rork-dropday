/**
 * Overlay style presets, as data. The native renderer (modules/video-render)
 * implements these properties; the editor only picks a name.
 *
 * Sizes are for a 1080-pixel-wide frame and scale with the render size.
 * yCenter is the vertical centre of the overlay as a fraction of the frame
 * height from the top (0 top, 1 bottom). Colors are #RRGGBB or #RRGGBBAA.
 *
 * Pure data and functions: no React, no native modules.
 */
import type { EditInstructions } from "./editModel.ts";

export type OverlayFontWeight = "regular" | "medium" | "semibold" | "bold" | "heavy" | "black";

export type OverlayStyleSpec = {
  fontSize: number;
  fontWeight: OverlayFontWeight;
  color: string;
  backgroundColor?: string;
  /** Space between the text and the edge of its background box. */
  backgroundPadding?: number;
  cornerRadius?: number;
  yCenter: number;
  /** Widest the text may get, as a fraction of the frame width. Default 0.86. */
  maxWidth?: number;
  uppercase?: boolean;
  letterSpacing?: number;
  shadow?: boolean;
  /** Simple fade at the start and end of the overlay's window. */
  fadeInMs?: number;
  fadeOutMs?: number;
};

export type OverlayStylePreset = {
  id: string;
  label: string;
  spec: OverlayStyleSpec;
};

export const CAPTION_STYLES: OverlayStylePreset[] = [
  {
    id: "clean",
    label: "Clean",
    spec: { fontSize: 54, fontWeight: "bold", color: "#FFFFFF", yCenter: 0.74, shadow: true, fadeInMs: 80, fadeOutMs: 80 },
  },
  {
    id: "bold",
    label: "Bold",
    spec: { fontSize: 66, fontWeight: "black", color: "#FFFFFF", yCenter: 0.72, uppercase: true, shadow: true, fadeInMs: 60, fadeOutMs: 60 },
  },
  {
    id: "highlight",
    label: "Highlight",
    spec: {
      fontSize: 54, fontWeight: "heavy", color: "#0A0A0A", backgroundColor: "#FFD400",
      backgroundPadding: 16, cornerRadius: 12, yCenter: 0.74, fadeInMs: 60, fadeOutMs: 60,
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    spec: { fontSize: 42, fontWeight: "medium", color: "#FFFFFFE6", yCenter: 0.84, shadow: true, fadeInMs: 120, fadeOutMs: 120 },
  },
  {
    id: "creator",
    label: "Creator",
    spec: {
      fontSize: 58, fontWeight: "heavy", color: "#FFFFFF", backgroundColor: "#000000B3",
      backgroundPadding: 18, cornerRadius: 20, yCenter: 0.7, letterSpacing: 1, fadeInMs: 80, fadeOutMs: 80,
    },
  },
];

export const TEXT_STYLES: OverlayStylePreset[] = [
  {
    id: "hook",
    label: "Hook",
    spec: {
      fontSize: 84, fontWeight: "black", color: "#FFFFFF", yCenter: 0.22, uppercase: true,
      shadow: true, letterSpacing: 1, fadeInMs: 150, fadeOutMs: 150,
    },
  },
  {
    id: "emphasis",
    label: "Emphasis",
    spec: { fontSize: 96, fontWeight: "black", color: "#FFD400", yCenter: 0.45, uppercase: true, shadow: true, fadeInMs: 100, fadeOutMs: 100 },
  },
  {
    id: "quote",
    label: "Quote",
    spec: { fontSize: 52, fontWeight: "medium", color: "#FFFFFF", yCenter: 0.5, maxWidth: 0.78, shadow: true, fadeInMs: 250, fadeOutMs: 250 },
  },
  {
    id: "callout",
    label: "Callout",
    spec: {
      fontSize: 56, fontWeight: "heavy", color: "#FFFFFF", backgroundColor: "#E8291C",
      backgroundPadding: 20, cornerRadius: 14, yCenter: 0.3, fadeInMs: 120, fadeOutMs: 120,
    },
  },
  {
    id: "title",
    label: "Title",
    spec: { fontSize: 72, fontWeight: "bold", color: "#FFFFFF", yCenter: 0.15, shadow: true, fadeInMs: 200, fadeOutMs: 200 },
  },
];

const DEFAULT_CAPTION = "clean";
const DEFAULT_TEXT = "hook";

/** The spec for an overlay: its named preset, or the default for its kind. */
export function resolveOverlayStyle(kind: "text" | "caption", styleId?: string): OverlayStyleSpec {
  const list = kind === "caption" ? CAPTION_STYLES : TEXT_STYLES;
  const fallback = kind === "caption" ? DEFAULT_CAPTION : DEFAULT_TEXT;
  const preset = list.find((p) => p.id === styleId) ?? list.find((p) => p.id === fallback)!;
  return preset.spec;
}

/**
 * EditInstructions -> the JSON the native renderer takes: text and caption
 * overlays get their preset resolved into `styleSpec`.
 */
export function toRenderJson(instructions: EditInstructions): string {
  return JSON.stringify({
    ...instructions,
    overlays: instructions.overlays.map((o) =>
      o.kind === "text" || o.kind === "caption"
        ? { ...o, styleSpec: resolveOverlayStyle(o.kind, o.style) }
        : o,
    ),
  });
}
