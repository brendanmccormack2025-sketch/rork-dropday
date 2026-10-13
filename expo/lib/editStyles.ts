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
import { CAPTION_FONTS, TEXT_FONT_NAME, resolveCaptionLook } from "./transcription/captionPresets.ts";
import { burnedFontName, resolveAppearance, STROKE_EM, type LookSource } from "./textLook.ts";
import { TEXT_LINE_HEIGHT_EM, TEXT_PAD_X_EM, TEXT_PAD_Y_EM } from "./feedLayout.ts";

export type OverlayFontWeight = "regular" | "medium" | "semibold" | "bold" | "heavy" | "black";

export type OverlayStyleSpec = {
  fontSize: number;
  fontWeight: OverlayFontWeight;
  color: string;
  backgroundColor?: string;
  /** Space between the text and the edge of its background box. */
  backgroundPadding?: number;
  /** Build 1.0.4 (supportsTextBox): padding across and down separately; older builds use backgroundPadding. */
  backgroundPaddingX?: number;
  backgroundPaddingY?: number;
  /** Build 1.0.4 (supportsTextBox): one fixed line height, as a multiple of the font size. */
  lineHeight?: number;
  /** Build 1.0.4 (supportsLineBackgrounds): a rounded background per line, joined. Absent: one box as wide as the widest line. */
  lineBackground?: boolean;
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
  /**
   * An outline around the letters (build 1.0.5, supportsTextOutline): its color and its width in points on a 1080-wide
   * frame (how far it reaches beyond the letters). Builds that do not know the keys ignore them.
   */
  outlineColor?: string;
  outlineWidth?: number;
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
      fontSize: 38, fontWeight: "heavy", color: "#FFFFFF", backgroundColor: "#000000",
      backgroundPadding: 18, cornerRadius: 11, yCenter: 0.72, maxWidth: 0.86,
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

/** What the build can burn in beyond the 1.0.4 baseline; every field is false / empty on a 1.0.4 build. */
export type RenderCaps = {
  /** An outline around the text (style keys outlineColor / outlineWidth). */
  outline?: boolean;
  /** PostScript names of the fonts the build embeds (VideoRender.supportedFontNames). */
  fontNames?: readonly string[];
};

/**
 * A preset with the clip-wide caption box applied: size scaled, position replaced, then the look: the colors exactly as
 * chosen (text, background, outline), the shadow, the font. `caps` says what the build can burn in: without outline
 * support the outline keys are left out, so the preview (which uses the same function) shows what the render draws.
 */
export function applyCaptionStyle(spec: OverlayStyleSpec, style: CaptionStyle, caps: RenderCaps = {}): OverlayStyleSpec {
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
  if (look.uppercase) out.uppercase = true;
  else delete out.uppercase;
  if (look.shadow) out.shadow = true;
  else delete out.shadow;
  if (look.fontName) out.fontName = look.fontName;
  if (look.outline && caps.outline) {
    out.outlineColor = look.outline.hex;
    out.outlineWidth = look.outline.em * out.fontSize;
  }
  return out;
}

/**
 * The spec sent to the native renderer. A caption never gets both fades at 0: the
 * renderer's discrete (hard cut) path leaves captions visible after their end, so a
 * caption fades for 1 ms, which takes the minimum-fade path.
 */
function renderSpec(kind: "text" | "caption", styleId?: string, captionStyle?: CaptionStyle, options: RenderOptions = {}): OverlayStyleSpec {
  const caps: RenderCaps = { outline: options.supportsOutline === true, fontNames: options.fontNames ?? [] };
  const resolved = resolveOverlayStyle(kind, styleId);
  // Text overlays are Montserrat Bold where the build can draw a bundled font; elsewhere the system font, as before.
  if (kind !== "caption") {
    const spec = options.supportsFont && !resolved.fontName ? { ...resolved, fontName: TEXT_FONT_NAME } : resolved;
    return withTextBox(spec, !!options.supportsTextBox, !!options.supportsLineBackgrounds);
  }
  const spec = guardFont(captionStyle ? applyCaptionStyle(resolved, captionStyle, caps) : resolved, options);
  return withTextBox({ ...spec, fadeInMs: Math.max(1, spec.fadeInMs ?? 0), fadeOutMs: Math.max(1, spec.fadeOutMs ?? 0) }, !!options.supportsTextBox, !!options.supportsLineBackgrounds);
}

/**
 * A font that needs the build to embed it is only sent to a build that says it does; anything else falls back to the
 * default font (Montserrat ExtraBold where the build can draw a bundled font, else the system font), never to a name
 * the renderer cannot open.
 */
function guardFont(spec: OverlayStyleSpec, options: RenderOptions): OverlayStyleSpec {
  const font = CAPTION_FONTS.find((f) => f.fontName !== null && f.fontName === spec.fontName);
  if (!font?.requiresEmbedded || (options.fontNames ?? []).includes(font.fontName as string)) return spec;
  const out = { ...spec };
  if (options.supportsFont) out.fontName = "Montserrat-ExtraBold";
  else delete out.fontName;
  return out;
}

export type RenderOptions = {
  supportsFont?: boolean;
  supportsTextBox?: boolean;
  supportsLineBackgrounds?: boolean;
  /** Build 1.0.5: the renderer draws an outline (style keys outlineColor / outlineWidth). */
  supportsOutline?: boolean;
  /** Build 1.0.5: PostScript names of the fonts the build embeds. */
  fontNames?: readonly string[];
};

/**
 * The box proportions both the preview and the render use where the build supports them: 0.5 em across and
 * 0.25 em down around the text, and one fixed line height. A spec with no background keeps no padding.
 * Without the capability (build 39) the spec is returned untouched.
 */
export function withTextBox(spec: OverlayStyleSpec, supportsTextBox: boolean, supportsLineBackgrounds = false): OverlayStyleSpec {
  if (!supportsTextBox) return spec;
  const out: OverlayStyleSpec = { ...spec, lineHeight: TEXT_LINE_HEIGHT_EM };
  if (spec.backgroundColor && supportsLineBackgrounds) out.lineBackground = true;
  if (spec.backgroundColor) {
    out.backgroundPaddingX = spec.fontSize * TEXT_PAD_X_EM;
    out.backgroundPaddingY = spec.fontSize * TEXT_PAD_Y_EM;
  }
  return out;
}

/**
 * EditInstructions -> the JSON the native renderer takes: text and caption
 * overlays get their preset resolved into `styleSpec`.
 */
export function toRenderJson(instructions: EditInstructions, options: RenderOptions = {}): string {
  return JSON.stringify({
    ...instructions,
    overlays: instructions.overlays.map((o) =>
      o.kind === "text" || o.kind === "caption"
        ? { ...o, styleSpec: renderSpec(o.kind, o.style, o.kind === "caption" ? o.captionStyle : undefined, options) }
        : o,
    ),
  });
}

/**
 * A Text-button overlay as the native renderer's style (for a 1080-wide frame): every part of the look maps to its own
 * keys and none depends on another: `color` is the text color, `backgroundColor` the box (absent = none), `shadow` the
 * shadow, `outlineColor` / `outlineWidth` the outline (only where the build draws one). The font is the overlay's own
 * where the build embeds it, else Montserrat Bold. Text-button overlays are drawn live today and are not burned into the
 * posted video; this is the mapping for the day they are, and what the tests check for every combination.
 */
export function overlayRenderStyle(ov: LookSource & { fontSize: number; scale?: number }, caps: RenderCaps = {}): OverlayStyleSpec {
  const a = resolveAppearance(ov);
  const fontSize = ov.fontSize * (ov.scale ?? 1);
  const spec: OverlayStyleSpec = {
    fontSize,
    fontWeight: "bold",
    color: a.textColor,
    yCenter: 0.5,
    fontName: burnedFontName(a.fontId, caps.fontNames ?? []),
  };
  if (a.boxColor !== null) {
    const alpha = a.boxOpacity < 1 ? Math.round(a.boxOpacity * 255).toString(16).padStart(2, "0").toUpperCase() : "";
    spec.backgroundColor = `${a.boxColor}${alpha}`;
    spec.cornerRadius = fontSize * 0.2;
    spec.lineBackground = true;
    spec.backgroundPaddingX = fontSize * TEXT_PAD_X_EM;
    spec.backgroundPaddingY = fontSize * TEXT_PAD_Y_EM;
  }
  if (a.shadow) spec.shadow = true;
  if (a.stroke && caps.outline) {
    spec.outlineColor = a.stroke.color;
    spec.outlineWidth = a.stroke.em * fontSize;
  }
  return spec;
}

export { STROKE_EM };
