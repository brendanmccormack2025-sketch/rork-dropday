/**
 * Laughs are never cut. Every method-2 candidate classified 'laugh' becomes a
 * protected range, padded on each side; laugh candidates within mergeGapMs of each
 * other are one range (a laugh is several pulses). The ranges are laughProtect
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
  const groups: Array<{ startMs: number; endMs: number; count: number }> = [];
  for (const l of laughs) {
    const last = groups[groups.length - 1];
    if (last && l.startMs - last.endMs <= config.mergeGapMs) {
      last.endMs = Math.max(last.endMs, l.endMs);
      last.count++;
    } else {
      groups.push({ startMs: l.startMs, endMs: l.endMs, count: 1 });
    }
  }
  return groups.map((g) =>
    makeDecision("laughProtect", Math.max(0, g.startMs - config.padMs), g.endMs + config.padMs, {
      payload: { laughs: g.count, original: { startMs: g.startMs, endMs: g.endMs } },
    }),
  );
}
