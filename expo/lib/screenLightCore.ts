/**
 * Screen brightness for the front-camera light: raised to the maximum while it is on, put back afterwards.
 * Pure (the platform is injected); erasable TypeScript only so the Node tests can run it.
 */

export type BrightnessApi = {
  get(): Promise<number>;
  set(value: number): Promise<void>;
};

/** on() remembers the current brightness and goes to max; off() puts it back. Both are safe to repeat. */
export function createScreenLight(api: BrightnessApi | null) {
  let saved: number | null = null;
  let active = false;
  return {
    available: api !== null,
    async on(): Promise<void> {
      if (!api || active) return;
      active = true;
      try {
        if (saved === null) saved = await api.get();
        if (active) await api.set(1);
      } catch {
        // brightness is a bonus
      }
    },
    async off(): Promise<void> {
      if (!api) return;
      active = false;
      const back = saved;
      saved = null;
      if (back === null) return;
      try {
        await api.set(back);
      } catch {
        // nothing to restore
      }
    },
  };
}
