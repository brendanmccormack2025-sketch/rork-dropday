/**
 * Fail-safe for the precision timeline on the Cuts screen. A React error boundary catches errors thrown while
 * rendering, and the component reports errors from its handlers; neither can catch a native crash. For those the
 * timeline "arms" a marker in storage while it is on screen: if the app starts and finds the marker still armed (it
 * died while the timeline was showing) the timeline stays off for that build and the previous timeline is used.
 * A new build or over-the-air update (a different build key) gets another try.
 *
 * Pure apart from the injected storage; erasable TypeScript only so the Node tests can run it.
 */
export type GuardStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export const GUARD_KEY = "trial:precisionTimeline:v1";

export type GuardRecord = {
  /** The app build / update this record belongs to. */
  buildKey: string;
  /** Set while the timeline is on screen; still set at the next start means the app died with it showing. */
  armedAt: number | null;
  /** The timeline is off for this build. */
  disabled: boolean;
  reason?: string;
};

function parse(raw: string | null): GuardRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GuardRecord>;
    if (typeof v.buildKey !== "string") return null;
    return {
      buildKey: v.buildKey,
      armedAt: typeof v.armedAt === "number" ? v.armedAt : null,
      disabled: v.disabled === true,
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    };
  } catch {
    return null;
  }
}

async function write(storage: GuardStorage, rec: GuardRecord): Promise<void> {
  try {
    await storage.set(GUARD_KEY, JSON.stringify(rec));
  } catch {
    // storage unavailable: the guard just does not remember
  }
}

/** Whether the precision timeline may be used now. Reads the marker the last run left. */
export function readGuard(storage: GuardStorage, buildKey: string): Promise<{ enabled: boolean; reason: string | null }> {
  return serial(() => readGuardNow(storage, buildKey));
}

async function readGuardNow(storage: GuardStorage, buildKey: string): Promise<{ enabled: boolean; reason: string | null }> {
  let rec: GuardRecord | null = null;
  try {
    rec = parse(await storage.get(GUARD_KEY));
  } catch {
    rec = null;
  }
  if (!rec || rec.buildKey !== buildKey) return { enabled: true, reason: null };
  if (rec.disabled) return { enabled: false, reason: rec.reason ?? "disabled" };
  if (rec.armedAt !== null) {
    await write(storage, { buildKey, armedAt: null, disabled: true, reason: "app closed while the precision timeline was showing" });
    return { enabled: false, reason: "crash" };
  }
  return { enabled: true, reason: null };
}

// Writes happen one after the other, in the order they were asked for (an arm, a failure and a disarm can come in the
// same moment, and a late disarm must never undo a failure).
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = tail.then(job, job);
  tail = next.catch(() => {});
  return next;
}

/** The timeline is on screen. */
export function armGuard(storage: GuardStorage, buildKey: string, now: number): Promise<void> {
  return serial(async () => {
    const rec = parse(await storage.get(GUARD_KEY).catch(() => null));
    if (rec && rec.buildKey === buildKey && rec.disabled) return;   // already off for this build
    await write(storage, { buildKey, armedAt: now, disabled: false });
  });
}

/** The timeline left the screen normally (or the app went to the background). Never clears a failure. */
export function disarmGuard(storage: GuardStorage, buildKey: string): Promise<void> {
  return serial(async () => {
    const rec = parse(await storage.get(GUARD_KEY).catch(() => null));
    if (rec && rec.buildKey === buildKey && rec.disabled) return;
    await write(storage, { buildKey, armedAt: null, disabled: false });
  });
}

/** The timeline failed (an error was caught): off for this build. */
export function disableGuard(storage: GuardStorage, buildKey: string, reason: string): Promise<void> {
  return serial(() => write(storage, { buildKey, armedAt: null, disabled: true, reason: reason.slice(0, 200) }));
}
