/**
 * Gapless preview playback with two players on the SAME source file (A and B).
 *
 * While A plays piece N, B is loaded with the same file, seeked a little BEFORE the start of piece N+1 and paused
 * (the "standby"). A moment before A reaches the end of its piece, B is started muted and hidden, so it reaches the
 * start of piece N+1 exactly as A reaches the end of piece N. At that boundary the two swap: B becomes visible and
 * audible, A is paused and muted (opacity and mute only), and A is prepared for the piece after. The hand-over is
 * decided from the players' own playback times, every frame, with a small lead.
 *
 * Pieces that continue where the last one ended (a split) need no hand-over at all: the player just keeps playing.
 * When the standby is not ready in time (a very short piece, a seek that was slow) the active player hops over the
 * cut by itself (a seek), which is what playback did before this module.
 *
 * Pure; erasable TypeScript only so the Node tests can run it. The players and the clock are the caller's.
 */
import { editedFromPlayer, type Segment } from "./virtualTimeline.ts";

export type GaplessParams = {
  /** How far before the next piece's start the standby is parked (it plays this long, muted and hidden, to get up to speed). */
  prerollMs?: number;
  /** How long a player takes from play() to moving; learned while playing. */
  latencyMs?: number;
  /** The swap is made this close to the end of the active piece. */
  swapLeadMs?: number;
  /** The standby counts as arrived when it is within this of the next piece's start. */
  arriveTolMs?: number;
  /** A standby needs this long after its seek before it can be started. */
  readyAfterMs?: number;
  /**
   * The active player waits at the end of its piece for a late standby only when the standby is predicted to arrive
   * within this long (it plays at normal speed), and never longer than this: a seek over the cut can be as slow as
   * the wait, so a longer wait is never worth it.
   */
  holdMaxMs?: number;
};

export const GAPLESS_DEFAULTS = {
  prerollMs: 120,
  latencyMs: 60,
  swapLeadMs: 16,
  arriveTolMs: 24,
  readyAfterMs: 140,
  holdMaxMs: 150,
} as const;

export type StandbyState = {
  /** The piece (index into the segments) this player is parked for. */
  index: number;
  /** Where it was parked (source ms). */
  prepMs: number;
  /** When it was parked (ms clock). */
  preparedAt: number;
  playing: boolean;
};

/** Why the playing player had to seek over a cut itself (for the diagnostics). */
export type HopReason = "no-standby" | "standby-not-started" | "standby-too-late" | "hold-limit";

export type GaplessAction =
  | { kind: "none" }
  /** The active player crossed into the next piece of the same run (a split): bookkeeping only. */
  | { kind: "advanceWithin"; toIndex: number }
  /** Park the standby for piece `toIndex` at `seekMs` (paused, muted, hidden). */
  | { kind: "prepare"; toIndex: number; seekMs: number }
  /** Start the parked standby now (muted, hidden). */
  | { kind: "startStandby" }
  /** Hand over: the standby becomes the active player at piece `toIndex`. */
  | { kind: "swap"; toIndex: number; editedMs: number }
  /** The active piece is over but the standby has not arrived: pause the active player and wait. */
  | { kind: "hold" }
  /** No usable standby: the active player seeks over the cut itself. */
  | { kind: "hop"; toIndex: number; seekToSourceMs: number; editedMs: number; reason: HopReason }
  /** The last piece is over. */
  | { kind: "end"; editedMs: number };

/** The last piece of the run that continues without a gap, starting at `index` (a split is no gap). */
export function runEndIndex(segs: Segment[], index: number): number {
  let i = Math.min(Math.max(0, index), segs.length - 1);
  while (i < segs.length - 1 && Math.abs(segs[i + 1]!.srcStartMs - segs[i]!.srcEndMs) <= 1) i++;
  return i;
}

/** Where the standby for the piece after `activeIndex`'s run is parked, or null if the run is the last. */
export function standbyTarget(segs: Segment[], activeIndex: number, params: GaplessParams = {}): { index: number; prepMs: number; startMs: number } | null {
  const p = { ...GAPLESS_DEFAULTS, ...params };
  const re = runEndIndex(segs, activeIndex);
  const next = segs[re + 1];
  if (!next) return null;
  return { index: re + 1, prepMs: Math.max(0, next.srcStartMs - p.prerollMs), startMs: next.srcStartMs };
}

/** When (active player's source ms) the standby must be started so that it reaches the next piece as the active one ends. */
export function standbyStartAt(runEndMs: number, params: GaplessParams = {}): number {
  const p = { ...GAPLESS_DEFAULTS, ...params };
  return runEndMs - p.prerollMs - p.latencyMs;
}

/** The piece of the active run that holds a source time (the run's pieces only). */
function pieceInRun(segs: Segment[], from: number, to: number, sourceMs: number): number {
  for (let i = from; i <= to; i++) if (sourceMs < segs[i]!.srcEndMs) return i;
  return to;
}

/**
 * What to do this frame. `aMs` / `bMs` are the players' source times, `playing` whether the editor is playing,
 * `heldMs` how long the active player has already waited at the end of its piece (0 if not).
 */
export function gaplessTick(args: {
  segs: Segment[];
  activeIndex: number;
  aMs: number;
  bMs: number;
  standby: (StandbyState & { ready: boolean }) | null;
  nowMs: number;
  playing: boolean;
  heldMs: number;
  params?: GaplessParams;
}): GaplessAction {
  const { segs, aMs, bMs, standby, playing } = args;
  const p = { ...GAPLESS_DEFAULTS, ...args.params };
  if (segs.length === 0) return { kind: "none" };
  const ai = Math.min(Math.max(0, args.activeIndex), segs.length - 1);
  const re = runEndIndex(segs, ai);

  // inside a run of pieces that continue into each other, the active piece is whichever holds the time
  if (re > ai) {
    const now = pieceInRun(segs, ai, re, aMs);
    if (now !== ai) return { kind: "advanceWithin", toIndex: now };
  }
  const runEnd = segs[re]!.srcEndMs;
  const remaining = runEnd - aMs;
  const target = standbyTarget(segs, ai, p);

  if (!target) {
    return playing && remaining <= p.swapLeadMs ? { kind: "end", editedMs: segs[re]!.outEndMs } : { kind: "none" };
  }

  const parked = standby && standby.index === target.index && Math.abs(standby.prepMs - target.prepMs) <= 1 ? standby : null;
  const due = playing && remaining <= p.swapLeadMs;

  if (!parked) {
    if (due) return { kind: "hop", toIndex: target.index, seekToSourceMs: target.startMs, editedMs: segs[target.index]!.outStartMs, reason: "no-standby" };
    return { kind: "prepare", toIndex: target.index, seekMs: target.prepMs };
  }
  if (!playing) return { kind: "none" };

  if (due) {
    const arrived = parked.playing && bMs >= target.startMs - p.arriveTolMs;
    if (arrived) return { kind: "swap", toIndex: target.index, editedMs: segs[target.index]!.outStartMs };
    const hopTo = { kind: "hop" as const, toIndex: target.index, seekToSourceMs: target.startMs, editedMs: segs[target.index]!.outStartMs };
    if (!parked.playing) return { ...hopTo, reason: "standby-not-started" };
    // waiting is only worth it when the standby is about to arrive
    if (target.startMs - bMs > p.holdMaxMs) return { ...hopTo, reason: "standby-too-late" };
    if (args.heldMs >= p.holdMaxMs) return { ...hopTo, reason: "hold-limit" };
    return { kind: "hold" };
  }
  if (!parked.playing && parked.ready && aMs >= standbyStartAt(runEnd, p)) return { kind: "startStandby" };
  return { kind: "none" };
}

/**
 * The learned start-up latency of the standby: at the swap it was `errorMs` past (positive) or short of (negative) the
 * start of the piece. Late means start it earlier next time, early means later. Bounded.
 */
export function learnLatency(latencyMs: number, errorMs: number): number {
  // errorMs < 0 (late): the latency grows by all of it (start earlier at once); errorMs > 0 (early): it shrinks by half
  const next = latencyMs - errorMs * (errorMs < 0 ? 1 : 0.5);
  return Math.min(250, Math.max(15, Math.round(next)));
}

/** The edited time at the moment of a swap or hop, held inside the new piece: the playhead does not jump. */
export function editedAtPiece(segs: Segment[], index: number, sourceMs: number): number {
  return editedFromPlayer(segs, index, sourceMs);
}

// ── ending, replaying ──

/** The state after the last piece has played: stopped at the end of the edit, showing replay. */
export function endState(totalEditedMs: number): { isPlaying: false; ended: true; positionMs: number } {
  return { isPlaying: false, ended: true, positionMs: totalEditedMs };
}

/** Replay: from the start of the edit, playing, no longer ended. */
export function replayState(): { isPlaying: true; ended: false; positionMs: 0 } {
  return { isPlaying: true, ended: false, positionMs: 0 };
}

/** Play/pause pressed: at the end it replays instead. */
export function playPressed(args: { isPlaying: boolean; ended: boolean }): "pause" | "play" | "replay" {
  if (args.isPlaying) return "pause";
  return args.ended ? "replay" : "play";
}

/** "0:12": minutes and seconds of an edited time. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── what the editor shows: the rendered file or the two players ──

/**
 * The preview source. The two players always work. A finished render-ahead file (for exactly this timeline) is played
 * instead when playback starts on it, never swapped in the middle of playback; any edit makes the render stale and the
 * players are back at once.
 */
export function previewSourceFor(args: { aheadMatches: boolean; isPlaying: boolean; renderedWasPlaying: boolean }): "rendered" | "players" {
  if (!args.aheadMatches) return "players";
  if (args.isPlaying && !args.renderedWasPlaying) return "players";
  return "rendered";
}
