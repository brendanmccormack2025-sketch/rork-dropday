/**
 * Flash on the in-app camera. One switch ("flash on") that survives camera flips; what it does depends on the camera:
 * the back camera uses the torch, the front camera uses the screen as a light (a warm white glow over the screen).
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type FlashMode = "off" | "torch" | "screen";

export function flashMode(facing: "back" | "front", flashOn: boolean): FlashMode {
  if (!flashOn) return "off";
  return facing === "back" ? "torch" : "screen";
}

/** The front-camera screen light: warm white (#FFF4E0) at 80% opacity over the whole screen. */
export const SCREEN_LIGHT_COLOR = "rgba(255,244,224,0.8)";
