/**
 * Hook trim: start the video just before the first word, drop a weak opener
 * ("so", "okay", "um", "alright", "hey guys", "what's up") that is followed by a
 * pause, and end shortly after the last word. Applied by default (it needs a
 * transcript, so it only exists where transcription runs).
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { Word } from "../transcription/types.ts";
import { makeDecision, type Decision } from "./decisions.ts";

/** The cut ends this long before the first spoken word. */
export const HOOK_LEAD_MS = 150;
/** The video ends this long after the last spoken word. */
export const HOOK_TAIL_MS = 300;
/** A weak opener is cut only when this much silence follows it. */
export const HOOK_WEAK_PAUSE_MS = 300;
/** Never trim more than this from the start. */
export const HOOK_MAX_START_TRIM_MS = 3000;

const WEAK_OPENERS: string[][] = [
  ["so"],
  ["okay"],
  ["ok"],
  ["um"],
  ["uh"],
  ["alright"],
  ["hey", "guys"],
  ["what's", "up"],
  ["whats", "up"],
];

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z']/g, "");
}

/** How many leading words form a weak opener (0 when none); the longest phrase wins. */
function weakOpenerLength(words: Word[]): number {
  let best = 0;
  for (const phrase of WEAK_OPENERS) {
    if (phrase.length > words.length || phrase.length <= best) continue;
    if (phrase.every((p, i) => norm(words[i]!.text) === p)) best = phrase.length;
  }
  return best;
}

export function planHookTrim(words: Word[], durationMs: number): Decision[] {
  const spoken = words.filter((w) => norm(w.text) !== "");
  if (spoken.length === 0 || !(durationMs > 0)) return [];
  const out: Decision[] = [];

  // Start
  const first = spoken[0]!;
  const opener = weakOpenerLength(spoken);
  const next = spoken[opener];
  let startCutEnd = 0;
  let reason = "lead";
  if (opener > 0 && next && next.startMs - spoken[opener - 1]!.endMs > HOOK_WEAK_PAUSE_MS) {
    const end = next.startMs - HOOK_LEAD_MS;
    // A weak opener is cut only when the whole cut stays within the 3 s limit.
    if (end <= HOOK_MAX_START_TRIM_MS) {
      startCutEnd = end;
      reason = "weakOpener";
    }
  }
  if (startCutEnd === 0) startCutEnd = Math.min(first.startMs - HOOK_LEAD_MS, HOOK_MAX_START_TRIM_MS);
  if (startCutEnd >= 50) {
    out.push(makeDecision("hookTrim", 0, startCutEnd, { payload: { edge: "start", reason } }));
  }

  // End
  const last = spoken[spoken.length - 1]!;
  const tailStart = last.endMs + HOOK_TAIL_MS;
  if (durationMs - tailStart >= 50) {
    out.push(makeDecision("hookTrim", tailStart, durationMs, { payload: { edge: "end", reason: "tail" } }));
  }
  return out;
}
