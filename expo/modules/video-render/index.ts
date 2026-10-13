import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { RenderOptions, RenderProgressEvent, RenderResult, TimingProbe } from "./src/VideoRender.types";

export type { RenderOptions, RenderProgressEvent, RenderResult, TimingProbe } from "./src/VideoRender.types";

type Subscription = { remove(): void };

type VideoRenderNative = {
  renderAsync(instructionsJson: string, options?: RenderOptions): Promise<RenderResult>;
  cancelRender(): void;
  /** Present (true) from build 1.0.4: captions can use a font by PostScript name. */
  supportsCaptionFont?: boolean;
  /** Present (true) from build 1.0.4: separate padding across/down and a fixed line height in text boxes. */
  supportsTextBox?: boolean;
  /** Present (true) from build 1.0.4: a caption with several lines gets a background per line (style "lineBackground"). */
  supportsLineBackgrounds?: boolean;
  /** Present (true) from build 1.0.4: probeTimingAsync, and merges without seam fades / with tracks kept in step. */
  supportsTimingProbe?: boolean;
  /** Build 1.0.5 (not in 1.0.4): text styles may carry outlineColor / outlineWidth and the renderer strokes the letters. */
  supportsTextOutline?: boolean;
  /**
   * Build 1.0.5 (not in 1.0.4): Text-button overlays can be burned in: a "text" overlay with a complete styleSpec places
   * itself by xCenter / yCenter, rotates, and draws font, outline, text shadow and per-line background.
   */
  supportsTextOverlays?: boolean;
  /** Build 1.0.5 (not in 1.0.4): the PostScript names of the bundled fonts the build embeds (UIFont(name:) finds them). */
  supportedFontNames?: string[];
  probeTimingAsync?(uri: string): Promise<TimingProbe>;
  addListener(event: "onProgress", listener: (e: RenderProgressEvent) => void): Subscription;
};

// iOS only. Android and web have no native module.
const native: VideoRenderNative | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<VideoRenderNative>("VideoRender") : null;

/** True when this build can render a caption font (older builds ignore "fontName", so the editor hides the font row). */
export const supportsCaptionFont: boolean = native?.supportsCaptionFont === true;

/** True when this build lays text boxes out with backgroundPaddingX/Y and lineHeight (older builds ignore them). */
export const supportsTextBox: boolean = native?.supportsTextBox === true;

/** True when this build draws a background per caption line (older builds draw one box as wide as the widest line). */
export const supportsLineBackgrounds: boolean = native?.supportsLineBackgrounds === true;

/** True when this build burns in a text outline (style keys outlineColor / outlineWidth). False on 1.0.4: the outline is not offered for captions. */
export const supportsTextOutline: boolean = native?.supportsTextOutline === true;

/** True when this build burns Text-button overlays into a render (position, rotation, outline, shadow, background). False on 1.0.4: saves go out without text. */
export const supportsTextOverlays: boolean = native?.supportsTextOverlays === true;

/** The PostScript names of the bundled fonts this build embeds for the renderer. Empty on 1.0.4 (only Montserrat, for "Classic"). */
export const supportedFontNames: readonly string[] = Array.isArray(native?.supportedFontNames) ? (native!.supportedFontNames as string[]) : [];

/** True when this build can measure a file's track timing (probeTimingAsync). */
export const supportsTimingProbe: boolean = native?.supportsTimingProbe === true;

/** Where a file's video and audio tracks start and how long they are (movie time), or null when this build cannot say. */
export async function probeTimingAsync(uri: string): Promise<TimingProbe | null> {
  if (!native?.probeTimingAsync) return null;
  return native.probeTimingAsync(uri);
}

/**
 * Render EditInstructions v1 (lib/editModel.ts, as JSON) into one mp4 on this
 * phone. Rejects with an ERR_RENDER_* code on failure or cancel; on Android and
 * web it always rejects with ERR_RENDER_UNSUPPORTED. Nothing leaves the phone.
 */
export async function renderAsync(
  instructionsJson: string,
  options?: RenderOptions,
): Promise<RenderResult> {
  if (!native) {
    throw Object.assign(new Error("Rendering is only available on iOS"), {
      code: "ERR_RENDER_UNSUPPORTED",
    });
  }
  return native.renderAsync(instructionsJson, options);
}

/** Cancels the render in progress, if any (its promise rejects ERR_RENDER_CANCELLED). */
export function cancelRender(): void {
  native?.cancelRender();
}

/** Progress (0 to 1) of the render in progress. */
export function addRenderProgressListener(
  listener: (e: RenderProgressEvent) => void,
): Subscription {
  return native ? native.addListener("onProgress", listener) : { remove() {} };
}
