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
import type { CaptionStyle, EditInstructions } from "./editModel.ts";
import { resolveCaptionLook } from "./transcription/captionPresets.ts";

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
  /** Horizontal centre as a fraction of the frame width (default 0.5). Read by the renderer only once it supports it. */
  xCenter?: number;
  /** Widest the text may get, as a fraction of the frame width. Default 0.86. */
  maxWidth?: number;
  uppercase?: boolean;
  /** iOS PostScript font name; absent = the system font at fontWeight. Read by the renderer from build 1.0.4 on. */
  fontName?: string;
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
    id: "trial",
    label: "Trial",
    spec: {
      fontSize: 60, fontWeight: "heavy", color: "#FFFFFF", backgroundColor: "#000000",
      backgroundPadding: 18, cornerRadius: 15, yCenter: 0.7, maxWidth: 0.86, uppercase: true,
      fadeInMs: 0, fadeOutMs: 0,
    },
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
      fontSize: 84, fontWeight: "black", color: "#FFFFFF", backgroundPadding: 25, cornerRadius: 21,
      yCenter: 0.22, uppercase: true, shadow: true, letterSpacing: 1, fadeInMs: 150, fadeOutMs: 150,
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

/** A preset with the clip-wide caption box applied: size scaled, position replaced. */
export function applyCaptionStyle(spec: OverlayStyleSpec, style: CaptionStyle): OverlayStyleSpec {
  const s = style.scale;
  const out: OverlayStyleSpec = {
    ...spec,
    fontSize: spec.fontSize * s,
    backgroundPadding: spec.backgroundPadding === undefined ? undefined : spec.backgroundPadding * s,
    cornerRadius: spec.cornerRadius === undefined ? undefined : spec.cornerRadius * s,
    letterSpacing: spec.letterSpacing === undefined ? undefined : spec.letterSpacing * s,
    yCenter: style.yCenter,
    // The centre is the default: leave the key out, so the default box sends the preset's own JSON.
    ...(style.xCenter === 0.5 ? {} : { xCenter: style.xCenter }),
  };
  // The look. Overwritten in place, so the Trial look (white on black, system font) changes nothing:
  // its JSON is byte-identical to the preset's. Only a different look adds or removes keys.
  const look = resolveCaptionLook(style);
  out.color = look.textHex;
  if (look.backgroundHex === null) delete out.backgroundColor;
  else out.backgroundColor = look.backgroundHex;
  if (look.shadow) out.shadow = true;
  if (look.fontName) out.fontName = look.fontName;
  return out;
}

/**
 * The spec sent to the native renderer. A caption never gets both fades at 0: the
 * renderer's discrete (hard cut) path leaves captions visible after their end, so a
 * caption fades for 1 ms, which takes the minimum-fade path.
 */
function renderSpec(kind: "text" | "caption", styleId?: string, captionStyle?: CaptionStyle): OverlayStyleSpec {
  const resolved = resolveOverlayStyle(kind, styleId);
  if (kind !== "caption") return resolved;
  const spec = captionStyle ? applyCaptionStyle(resolved, captionStyle) : resolved;
  return { ...spec, fadeInMs: Math.max(1, spec.fadeInMs ?? 0), fadeOutMs: Math.max(1, spec.fadeOutMs ?? 0) };
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
        ? { ...o, styleSpec: renderSpec(o.kind, o.style, o.kind === "caption" ? o.captionStyle : undefined) }
        : o,
    ),
  });
}
