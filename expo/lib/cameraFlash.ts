/**
 * Flash on the in-app camera. One switch ("flash on") that survives camera flips; what it does depends on the camera:
 * the back camera uses the torch, the front camera uses the screen as a light (a white glow around the preview).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type FlashMode = "off" | "torch" | "screen";

export function flashMode(facing: "back" | "front", flashOn: boolean): FlashMode {
  if (!flashOn) return "off";
  return facing === "back" ? "torch" : "screen";
}

/** Width of the white ring (points) around the preview for the screen light. */
export const SCREEN_LIGHT_RING = 44;
