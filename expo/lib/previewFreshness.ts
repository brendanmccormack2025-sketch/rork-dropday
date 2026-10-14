/**
 * An out-of-date style is never shown. The editor draws captions and text live over the playing video; a rendered
 * preview file is only trusted to carry a style when it was made with exactly the style that is current now. Any
 * caption or text look change makes a new "look key", which (1) remounts the live drawing so nothing it cached survives
 * and (2) makes a rendered file with burned-in captions stale at once, so the live drawing takes over until a new render
 * is ready. Moving or resizing is not a look change (a drag never remounts anything).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { CaptionStyle } from "./editModel.ts";

type CaptionLook = Pick<CaptionStyle, "fontId" | "textColor" | "backgroundColor" | "uppercase" | "shadow" | "outline" | "outlineColor">;

/** Every part of a caption's look, and nothing about where it is or how big. */
export function captionLookKey(style: Partial<CaptionLook> | null | undefined): string {
  const s = style ?? {};
  return [s.fontId ?? "", s.textColor ?? "", s.backgroundColor ?? "", s.uppercase === undefined ? "" : s.uppercase ? "1" : "0", s.shadow === undefined ? "" : s.shadow ? "1" : "0", s.outline ?? "", s.outlineColor ?? ""].join("|");
}

/** The look fields of a Text-button overlay (lib/textLook.ts), including the older background preset and color. */
type OverlayLook = {
  fontId?: string;
  color?: string;
  outline?: boolean;
  outlineColor?: string;
  stroke?: string;
  shadow?: boolean;
  background?: boolean;
  bgColor?: string;
  look?: string;
  backgroundStyle?: string;
};

export function overlayLookKey(ov: OverlayLook): string {
  const f = (v: unknown) => (v === undefined ? "" : String(v));
  return [ov.fontId, ov.color, ov.outline, ov.outlineColor, ov.stroke, ov.shadow, ov.background, ov.bgColor, ov.look, ov.backgroundStyle].map(f).join("|");
}

/** The look of everything the preview draws: the caption style and every text overlay. */
export function lookSignature(captionStyle: Partial<CaptionLook> | null | undefined, overlays: ReadonlyArray<OverlayLook & { id: string }>): string {
  return `${captionLookKey(captionStyle)}#${overlays.map((o) => `${o.id}:${overlayLookKey(o)}`).join(";")}`;
}

/** What a rendered preview file was made with. */
export type RenderedPreview = { includesCaptions: boolean; lookSignature: string | null };

/**
 * May the rendered preview carry the captions (so the live drawing stays out of the way)? Only when it has them burned in
 * AND was made with the look that is current. Anything else: the live drawing shows them, always.
 */
export function renderedPreviewCarriesCaptions(rendered: RenderedPreview | null | undefined, currentLookSignature: string): boolean {
  return !!rendered && rendered.includesCaptions && rendered.lookSignature === currentLookSignature;
}

/** Captions are drawn live unless a fresh rendered file carries them. */
export function drawCaptionsLive(rendered: RenderedPreview | null | undefined, currentLookSignature: string): boolean {
  return !renderedPreviewCarriesCaptions(rendered, currentLookSignature);
}
