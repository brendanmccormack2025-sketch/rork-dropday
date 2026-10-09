/**
 * The camera must always open: nothing it does at start (reading the remembered camera, the screen light) may wait
 * on something that never answers, and a camera that does not come up shows "Camera couldn't start. Retry" instead
 * of a frozen screen.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

/** The camera view has this long to report ready before the start is called stalled. */
export const START_TIMEOUT_MS = 8000;
/** The remembered camera is read with this limit; after it the default is used. */
export const FACING_READ_TIMEOUT_MS = 1200;

/** `promise`, or `fallback` if it has not settled after `ms` (or rejects). Never rejects, never waits longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export type StartState = {
  /** Camera permission is granted and the camera view is on screen. */
  viewMounted: boolean;
  ready: boolean;
  mountError: string | null;
  elapsedMs: number;
};

/** Why the camera could not start, or null (still starting, or fine). */
export function startFailure(s: StartState): "mount-error" | "stalled" | null {
  if (s.mountError) return "mount-error";
  if (!s.viewMounted || s.ready) return null;
  return s.elapsedMs >= START_TIMEOUT_MS ? "stalled" : null;
}

export const CAMERA_FAILED_TEXT = "Camera couldn't start.";
