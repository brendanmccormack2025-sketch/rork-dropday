/**
 * Laughs are never cut. Every method-2 candidate classified 'laugh' becomes a
 * protected range, padded on each side; laugh candidates within mergeGapMs (3 s)
 * of each other are ONE episode (a laugh is several pulses with breaths between).
 * An 'unsure' or 'um' candidate lying between laugh candidates of an episode belongs
 * to it: the episode runs from its first laugh to its last, so they are inside.
 * The ranges are laughProtect
 * decisions (category "Protect laughs"); decisions.ts takes them out of every cut,
 * so a cut stops at a protected range's edge and the original cuts come back
 * exactly when the category is switched off.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import type { ClassifiedSound } from "./classifySound.ts";
import { LAUGH_PROTECT_CONFIG, makeDecision, type Decision } from "./decisions.ts";

export function planLaughProtection(
  sounds: ClassifiedSound[],
  config: typeof LAUGH_PROTECT_CONFIG = LAUGH_PROTECT_CONFIG,
): Decision[] {
  const laughs = sounds.filter((s) => s.cls === "laugh").sort((a, b) => a.startMs - b.startMs);
  const groups: Array<{ startMs: number; endMs: number; count: number; others: number }> = [];
  for (const l of laughs) {
    const last = groups[groups.length - 1];
    if (last && l.startMs - last.endMs <= config.mergeGapMs) {
      last.endMs = Math.max(last.endMs, l.endMs);
      last.count++;
    } else {
      groups.push({ startMs: l.startMs, endMs: l.endMs, count: 1, others: 0 });
    }
  }
  for (const g of groups) {
    g.others = sounds.filter((s) => s.cls !== "laugh" && s.startMs >= g.startMs && s.endMs <= g.endMs).length;
  }
  return groups.map((g) =>
    makeDecision("laughProtect", Math.max(0, g.startMs - config.padMs), g.endMs + config.padMs, {
      payload: { laughs: g.count, others: g.others, original: { startMs: g.startMs, endMs: g.endMs } },
    }),
  );
}
