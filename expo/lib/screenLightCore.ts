/**
 * Screen brightness for the front-camera light: raised to the maximum while it is on, put back afterwards.
 * Pure (the platform is injected); erasable TypeScript only so the Node tests can run it.
 */

export type BrightnessApi = {
  get(): Promise<number>;
  set(value: number): Promise<void>;
};

/** Each brightness call is given this long; after it the call is dropped (the light still shows, the brightness stays). */
export const BRIGHTNESS_TIMEOUT_MS = 1500;

function limited<T>(job: () => Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    try {
      job().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/**
 * on() remembers the current brightness and goes to max; off() puts it back. Both are safe to repeat, never throw,
 * and never wait longer than BRIGHTNESS_TIMEOUT_MS per native call. The platform is looked up lazily, on first use,
 * so creating the light at camera start does nothing at all. Callers fire and forget (`void light.on()`).
 */
export function createScreenLight(getApi: () => BrightnessApi | null, timeoutMs = BRIGHTNESS_TIMEOUT_MS) {
  let saved: number | null = null;
  let active = false;
  let resolved: BrightnessApi | null | undefined;
  const api = (): BrightnessApi | null => {
    if (resolved === undefined) {
      try {
        resolved = getApi();
      } catch {
        resolved = null;
      }
    }
    return resolved;
  };
  return {
    async on(): Promise<void> {
      const a = api();
      if (!a || active) return;
      active = true;
      if (saved === null) {
        const current = await limited(() => a.get(), timeoutMs);
        if (typeof current === "number") saved = current;
      }
      if (active) await limited(() => a.set(1), timeoutMs);
    },
    async off(): Promise<void> {
      const a = api();
      if (!a) return;
      active = false;
      const back = saved;
      saved = null;
      if (back === null) return;
      await limited(() => a.set(back), timeoutMs);
    },
  };
}
