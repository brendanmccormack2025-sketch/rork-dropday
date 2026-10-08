/**
 * The safe-zone guides of the full-screen editor: shown only while a text overlay or caption is being dragged
 * or pinched, faded out when the finger lets go; a thin vertical line when the item is centred.
 *
 * Pure: no React, no native modules.
 */
export const GUIDE_FADE_MS = 200;
/** The feed-UI regions are a soft tint, not a dashed box. */
export const GUIDE_TINT = "rgba(0,0,0,0.15)";
export const GUIDE_RADIUS = 10;
/** Within this many points of the horizontal centre an item snaps to it. */
export const CENTER_SNAP_PT = 6;

/** Guides are on only while something is being moved or resized. */
export function guidesVisible(state: { dragging: boolean; pinching: boolean }): boolean {
  return state.dragging || state.pinching;
}

/** The opacity the guides animate to. */
export function guideTarget(visible: boolean): number {
  return visible ? 1 : 0;
}

/** Snap an item's centre x (frame points) to the frame's centre when within CENTER_SNAP_PT. */
export function snapToCenter(x: number, frameW: number, thresholdPt: number = CENTER_SNAP_PT): { x: number; centered: boolean } {
  const centre = frameW / 2;
  return Math.abs(x - centre) < thresholdPt ? { x: centre, centered: true } : { x, centered: false };
}

/** A light haptic fires when an item arrives at the centre, not on every move while it stays there. */
export function shouldBuzz(wasCentered: boolean, centered: boolean): boolean {
  return centered && !wasCentered;
}
