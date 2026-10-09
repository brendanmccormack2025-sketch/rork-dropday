/**
 * Put a player in a clean state: pause, load the file again (a fresh item, as after an app resume), wait until it
 * reports readyToPlay, seek ONCE, and only then let the caller resume playback. Used when Keep original (or an undo)
 * changes what the editor plays, so the player never sits on a stale item, a seek that was ignored before the file
 * was ready, or a "ready" flag that never comes back.
 *
 * Pure apart from the injected player; erasable TypeScript only so the Node tests can run it.
 */

export type ResettablePlayer = {
  pause(): void;
  /** Load `uri` again as a new item. */
  replace(uri: string): void;
  /** Resolves true when the NEW item reports readyToPlay (false: error or timeout). Called before replace(). */
  nextReady(timeoutMs: number): { promise: Promise<boolean>; cancel(): void };
  seekMs(ms: number): void;
};

export type ResetResult = { ready: boolean; steps: string[] };

export const READY_TIMEOUT_MS = 3000;

export async function resetPlayer(args: {
  player: ResettablePlayer;
  uri: string;
  seekToMs: number;
  timeoutMs?: number;
}): Promise<ResetResult> {
  const steps: string[] = [];
  const { player } = args;
  player.pause();
  steps.push("pause");
  // Listen first, so a quick ready is not missed.
  const wait = player.nextReady(args.timeoutMs ?? READY_TIMEOUT_MS);
  player.replace(args.uri);
  steps.push("replace");
  const ready = await wait.promise;
  steps.push(ready ? "ready" : "ready-timeout");
  // One seek, after the item is ready (a seek before that is ignored). Done even on a timeout: nothing else will.
  player.seekMs(Math.max(0, args.seekToMs));
  steps.push("seek");
  return { ready, steps };
}
