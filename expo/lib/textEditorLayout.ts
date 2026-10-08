/**
 * Layers of the text editor over the screen: the input bar sits right above the keyboard, and the
 * only dimming is behind the keyboard area, so the bar and the video preview above it stay at full strength.
 *
 * Pure: no React, no native modules.
 */
export type EditorLayout = {
  /** The dimmed region, in screen coordinates (empty when there is no keyboard). */
  scrim: { top: number; height: number };
  /** The input bar's rectangle, in screen coordinates. */
  bar: { top: number; height: number };
  /** The rest of the screen (the video preview stays visible and untouched). */
  preview: { top: number; height: number };
};

export const EDITOR_BAR_HEIGHT = 64;
export const SCRIM_OPACITY = 0.35;

export function editorLayout(screenH: number, keyboardH: number, barH = EDITOR_BAR_HEIGHT): EditorLayout {
  const kb = Math.max(0, Math.min(keyboardH, screenH));
  const barTop = screenH - kb - barH;
  return {
    scrim: { top: screenH - kb, height: kb },
    bar: { top: barTop, height: barH },
    preview: { top: 0, height: Math.max(0, barTop) },
  };
}

/** The editor's pieces, back to front. The bar is after the scrim, so nothing dims it. */
export const EDITOR_LAYER_ORDER = ["dismiss", "scrim", "bar"] as const;
