/**
 * Layers of the text editor, Instagram style: the video stays visible under a light dim, the text field is
 * centred in the space above the keyboard, and the controls (Cancel, style, check) sit above the dim at full
 * strength, never under it.
 *
 * Pure: no React, no native modules.
 */
export const LIGHT_DIM = 0.4;
export const EDITOR_TOP_ROW_HEIGHT = 56;

/** Back to front. The dim is one layer under both the controls and the field. */
export const EDITOR_LAYER_ORDER = ["video", "dim", "controls", "field"] as const;

export type EditorLayout = {
  /** The dimmed region: the whole screen, lightly. */
  dim: { top: number; height: number; opacity: number };
  /** Where the controls row sits (below the status bar). */
  controls: { top: number; height: number };
  /** The space the field is centred in: between the controls and the keyboard. */
  fieldArea: { top: number; height: number };
};

export function editorLayout(screenH: number, keyboardH: number, topInset = 0): EditorLayout {
  const kb = Math.max(0, Math.min(keyboardH, screenH));
  const controlsTop = topInset;
  const areaTop = controlsTop + EDITOR_TOP_ROW_HEIGHT;
  return {
    dim: { top: 0, height: screenH, opacity: LIGHT_DIM },
    controls: { top: controlsTop, height: EDITOR_TOP_ROW_HEIGHT },
    fieldArea: { top: areaTop, height: Math.max(0, screenH - kb - areaTop) },
  };
}

/** Centre of the field, in screen coordinates. */
export function fieldCenterY(layout: EditorLayout): number {
  return layout.fieldArea.top + layout.fieldArea.height / 2;
}
