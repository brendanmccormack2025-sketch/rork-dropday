/**
 * Bookkeeping for the pan, pinch and rotation of one Text-button overlay, which run together as one edit.
 *
 * One edit starts when the first of them starts (one undo snapshot) and ends, with one commit, when the LAST one
 * that started has ended, however it ended: lifted, cancelled or failed after it began. (An earlier version only
 * counted gestures that ended normally; one cancelled gesture left the count above zero for good, so nothing was
 * ever committed again: the pinch moved the text on screen but never stored the new size.)
 *
 * Pure: no React, no native modules.
 */

export type GestureName = "pan" | "pinch" | "rotate";

export function createGestureTracker(hooks: { onEditStart: () => void; onCommit: () => void }) {
  const started = new Set<GestureName>();
  let changed = false;
  return {
    /** A gesture became active. */
    begin(name: GestureName) {
      if (started.size === 0) {
        changed = false;
        hooks.onEditStart();
      }
      started.add(name);
    },
    /** A gesture moved something. */
    change() {
      changed = true;
    },
    /** A gesture finished, however it finished. Gestures that never began are ignored. */
    end(name: GestureName) {
      if (!started.delete(name)) return;
      if (started.size === 0 && changed) {
        changed = false;
        hooks.onCommit();
      }
    },
    active: () => started.size,
  };
}

/**
 * Invisible space around a text overlay's box that still takes touches, on every side. Two fingers have to land on
 * the overlay for a pinch to start; a one-line overlay is far thinner than two fingertips.
 */
export const TOUCH_PAD = 40;
