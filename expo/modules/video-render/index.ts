import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { RenderOptions, RenderProgressEvent, RenderResult } from "./src/VideoRender.types";

export type { RenderOptions, RenderProgressEvent, RenderResult } from "./src/VideoRender.types";

type Subscription = { remove(): void };

type VideoRenderNative = {
  renderAsync(instructionsJson: string, options?: RenderOptions): Promise<RenderResult>;
  cancelRender(): void;
  addListener(event: "onProgress", listener: (e: RenderProgressEvent) => void): Subscription;
};

// iOS only. Android and web have no native module.
const native: VideoRenderNative | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<VideoRenderNative>("VideoRender") : null;

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
