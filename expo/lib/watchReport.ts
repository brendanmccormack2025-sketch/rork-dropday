/**
 * Watch-time reporting for one post, pure (no React, no network import). Erasable TypeScript only (Node tests).
 *
 *  - Accumulates the time the post was actually on screen: start()/pause() around active, app background and screen leave.
 *  - report() sends the cumulative time (the server keeps the max). A failed write is retried a few times and then kept
 *    in a pending list that is flushed on the next report / app foreground, so a viewer's watch is not lost to a flaky
 *    connection. Supabase RPCs resolve with { error } instead of rejecting, so `send` must return false on any error.
 */
import { viewProgress, worthReporting, type ViewProgress } from "./trialEngine.ts";

export type ProgressPayload = ViewProgress & { post_id: string };
export type SendProgress = (p: ProgressPayload) => Promise<boolean>;

const RETRY_DELAYS_MS = [1000, 3000, 8000];
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reports that failed every retry: latest per post, flushed later. */
const pending = new Map<string, ProgressPayload>();

export function pendingCount(): number {
  return pending.size;
}
export function clearPending(): void {
  pending.clear();
}

async function sendWithRetry(send: SendProgress, p: ProgressPayload, delays: number[], sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; i <= delays.length; i++) {
    let ok = false;
    try {
      ok = await send(p);
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (i < delays.length) await sleep(delays[i]);
  }
  return false;
}

/** Tries the reports that earlier failed (one attempt each). */
export async function flushPending(send: SendProgress): Promise<void> {
  for (const [postId, p] of [...pending]) {
    let ok = false;
    try {
      ok = await send(p);
    } catch {
      ok = false;
    }
    if (ok) pending.delete(postId);
  }
}

export function createWatchReporter(opts: {
  postId: string;
  send: SendProgress;
  getDurationMs?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepReal;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  let acc = 0;
  let segStart: number | null = null;
  let acked = 0;

  const watchedMs = () => acc + (segStart != null ? Math.max(0, now() - segStart) : 0);

  return {
    watchedMs,
    /** The post is on screen and the app is in the foreground. */
    start() {
      if (segStart == null) segStart = now();
    },
    /** Swiped away, left the screen, or the app went to the background. */
    pause() {
      if (segStart != null) {
        acc += Math.max(0, now() - segStart);
        segStart = null;
      }
    },
    async report(): Promise<void> {
      const watched = watchedMs();
      if (!worthReporting(watched) || watched <= acked) {
        await flushPending(opts.send);
        return;
      }
      let dur = 0;
      try {
        dur = opts.getDurationMs?.() ?? 0;
      } catch {
        dur = 0;
      }
      const payload: ProgressPayload = { post_id: opts.postId, ...viewProgress(watched, dur) };
      const ok = await sendWithRetry(opts.send, payload, delays, sleep);
      if (ok) {
        acked = watched;
        pending.delete(opts.postId);
        await flushPending(opts.send);
      } else {
        pending.set(opts.postId, payload);
      }
    },
  };
}
