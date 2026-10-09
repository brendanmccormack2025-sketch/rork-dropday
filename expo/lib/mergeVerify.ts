/**
 * Does a merged file play straight through from 0 to the end, past every join? Checked in a plain player right after
 * the merge: for each join, start a little before it and see that the position gets past it. The numbers are logged
 * (client_errors, kind "mergeVerify") so a stall at a camera flip can be seen with its figures.
 *
 * The player is injected; pure apart from that; erasable TypeScript only so the Node tests can run it.
 */

export type VerifyPlayer = {
  /** Resolves true when the file is loaded and can play, false on error or timeout. */
  ready(): Promise<boolean>;
  seekMs(ms: number): void;
  play(): void;
  pause(): void;
  positionMs(): number;
  durationMs(): number;
  release(): void;
};

export type JoinCheck = { atMs: number; ok: boolean; reachedMs: number; waitedMs: number };
export type VerifyResult = {
  playerDurationMs: number;
  expectedMs: number | null;
  durationOk: boolean;
  joins: JoinCheck[];
  stalled: boolean;
};

/** Where the joins are on the merged timeline: the running total of the segments' lengths (all but the last). */
export function joinTimesMs(segmentMs: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < segmentMs.length - 1; i++) {
    at += segmentMs[i]!;
    out.push(at);
  }
  return out;
}

export const VERIFY_LEAD_MS = 500;
export const VERIFY_PAST_MS = 300;
export const VERIFY_TIMEOUT_MS = 3000;
export const DURATION_TOLERANCE_MS = 300;
const POLL_MS = 100;

export async function verifyJoins(args: {
  createPlayer: () => VerifyPlayer;
  joinsMs: number[];
  expectedMs: number | null;
  delay(ms: number): Promise<void>;
  /** At most this many joins are checked. */
  maxJoins?: number;
}): Promise<VerifyResult> {
  const player = args.createPlayer();
  const joins: JoinCheck[] = [];
  let playerDurationMs = 0;
  try {
    if (!(await player.ready())) {
      return { playerDurationMs: 0, expectedMs: args.expectedMs, durationOk: false, joins, stalled: false };
    }
    playerDurationMs = player.durationMs();
    for (const at of args.joinsMs.slice(0, args.maxJoins ?? 4)) {
      player.seekMs(Math.max(0, at - VERIFY_LEAD_MS));
      await args.delay(POLL_MS);
      player.play();
      let waited = 0;
      let reached = player.positionMs();
      while (waited < VERIFY_TIMEOUT_MS && reached < at + VERIFY_PAST_MS) {
        await args.delay(POLL_MS);
        waited += POLL_MS;
        reached = player.positionMs();
      }
      player.pause();
      joins.push({ atMs: at, ok: reached >= at + VERIFY_PAST_MS, reachedMs: Math.round(reached), waitedMs: waited });
    }
  } finally {
    try {
      player.release();
    } catch {
      // already released
    }
  }
  const durationOk = args.expectedMs === null || Math.abs(playerDurationMs - args.expectedMs) <= DURATION_TOLERANCE_MS;
  return { playerDurationMs: Math.round(playerDurationMs), expectedMs: args.expectedMs, durationOk, joins, stalled: joins.some((j) => !j.ok) };
}
