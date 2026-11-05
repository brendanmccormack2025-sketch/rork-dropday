/**
 * Hard time limits for native calls: a promise that never settles must not leave a spinner on the screen forever.
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export class DeadlineError extends Error {
  readonly code = "ERR_DEADLINE";
  readonly stage: string;
  readonly ms: number;
  constructor(stage: string, ms: number) {
    super(`timed out after ${Math.round(ms / 100) / 10} s while ${stage}`);
    this.name = "DeadlineError";
    this.stage = stage;
    this.ms = ms;
  }
}

/**
 * `promise`, or a DeadlineError after `ms`. `stage` may be a function, read when the deadline hits (the step that was
 * running by then). The timer is always cleared; a late result of `promise` is ignored (and its rejection swallowed).
 */
export function deadline<T>(promise: Promise<T>, ms: number, stage: string | (() => string)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(typeof stage === "function" ? stage() : stage, ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * One native render at a time. `acquire` waits for its turn without limit (as before); `acquireWithin(ms)` gives up with a
 * DeadlineError after `ms`, and if its turn comes later it passes the turn straight on, so the queue never stalls on a
 * caller that gave up.
 */
export function createNativeLock() {
  let chain: Promise<void> = Promise.resolve();
  function acquire(): Promise<() => void> {
    let release: () => void = () => {};
    const prev = chain;
    chain = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(() => release);
  }
  function acquireWithin(ms: number, stage: string = "waiting for the native renderer"): Promise<() => void> {
    const pending = acquire();
    let gaveUp = false;
    pending.then((release) => {
      if (gaveUp) release();
    });
    return deadline(pending, ms, stage).catch((e) => {
      gaveUp = true;
      throw e;
    });
  }
  return { acquire, acquireWithin };
}
