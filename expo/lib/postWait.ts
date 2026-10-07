/**
 * Posting while captions are still being made (transcription or AI planning running).
 *
 * The creator must never post silently without captions they saw in the editor: Post waits up to
 * POST_WAIT_MS for them; if they are still not done, the post goes out without captions and says so.
 *
 * Pure apart from the injected clock; erasable TypeScript only so the Node tests can run it.
 */
export const POST_WAIT_MS = 10_000;
const POLL_MS = 100;

export type PostWaitDeps = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const realDeps: PostWaitDeps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

/** Resolves true as soon as `isDone()` is true, or false once `timeoutMs` has passed. */
export async function waitUntil(
  isDone: () => boolean,
  timeoutMs: number = POST_WAIT_MS,
  deps: PostWaitDeps = realDeps,
): Promise<boolean> {
  const start = deps.now();
  while (!isDone()) {
    if (deps.now() - start >= timeoutMs) return false;
    await deps.sleep(POLL_MS);
  }
  return true;
}

export type CaptionsAtPost =
  | { action: "post"; captions: boolean; note: null }
  | { action: "post"; captions: false; note: string };

/**
 * What to do when Post is tapped. captionsOn: the creator has captions on and they are meant to be burned in;
 * busy: transcription or planning is still running.
 */
export async function settleCaptionsForPost(args: {
  captionsOn: boolean;
  isBusy: () => boolean;
  onWaiting?: (waiting: boolean) => void;
  deps?: PostWaitDeps;
}): Promise<CaptionsAtPost> {
  if (!args.captionsOn || !args.isBusy()) return { action: "post", captions: args.captionsOn, note: null };
  args.onWaiting?.(true);
  try {
    const done = await waitUntil(() => !args.isBusy(), POST_WAIT_MS, args.deps);
    if (done) return { action: "post", captions: true, note: null };
    return { action: "post", captions: false, note: "Posted without captions (they were not ready in time)" };
  } finally {
    args.onWaiting?.(false);
  }
}
