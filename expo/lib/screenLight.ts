/**
 * The platform side of the front-camera light (see screenLightCore.ts).
 *
 * Brightness needs the expo-brightness native module. It is not in this build, so it is looked up at run time and
 * used only if present (a later build that adds the package picks it up with no code change). Without it the white
 * glow still shows; only the brightness stays where the user had it.
 */
import { requireOptionalNativeModule } from "expo";

import { createScreenLight, type BrightnessApi } from "@/lib/screenLightCore";

export { createScreenLight };
export type { BrightnessApi };

type BrightnessModule = {
  getBrightnessAsync(): Promise<number>;
  setBrightnessAsync(value: number): Promise<void>;
};

/** The platform's brightness, or null when expo-brightness is not part of this build. */
export function nativeBrightness(): BrightnessApi | null {
  try {
    const mod = requireOptionalNativeModule<BrightnessModule>("ExpoBrightness");
    if (!mod?.getBrightnessAsync || !mod?.setBrightnessAsync) return null;
    return { get: () => mod.getBrightnessAsync(), set: (v) => mod.setBrightnessAsync(v) };
  } catch {
    return null;
  }
}
