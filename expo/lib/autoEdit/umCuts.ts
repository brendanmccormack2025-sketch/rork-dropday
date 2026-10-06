/**
 * Method-2 'um' sounds as reversible cuts (owner only, category "Ums").
 *
 *  - Edge padding: each cut starts umEdgePaddingMs after the candidate begins and ends
 *    umEdgePaddingMs before it ends, so neighbouring words are not clipped; a um
 *    shorter than umMinCutMs after padding is skipped.
 *  - Merge with pauses: a um within umMergeGapMs of a silence cut is stretched to touch
 *    it, so the two are one cut (one seam, not two).
 *  - No slivers: a kept piece shorter than umMinKeepMs between two cuts, next to a um
 *    cut, is removed by stretching that um cut over it.
 *  - Safety cap: at most one NEW seam per umSecondsPerNewSeam seconds of edited
 *    duration; the longest ums are kept first and the rest are skipped.
 * Laughs and unsure sounds are never cut. Silence cuts are never touched.
 *
 * Pure; erasable TypeScript only (see decisions.ts).
 */
import { SOUND_CLASSIFIER_CONFIG, type ClassifiedSound, type SoundClassifierConfig } from "./classifySound.ts";
import {
  mergePlan,
  setStates,
  effectiveCutRanges,
  effectivePieces,
  keepRangesOf,
  makeDecision,
  protectedRangesOf,
  type Decision,
  type EditState,
} from "./decisions.ts";

export type UmCutReport = {
  applied: Array<{ startMs: number; endMs: number; lengthMs: number; mergedWithSilence: boolean }>;
  skipped: Array<{ startMs: number; endMs: number; lengthMs: number; reason: string }>;
  /** Seams (cuts between kept pieces) with all applied cuts, and with silence cuts only. */
  finalSeams: number;
  silenceOnlySeams: number;
  seamLimit: { allowed: number; editedMs: number; capped: boolean };
};

type Um = { sound: ClassifiedSound; startMs: number; endMs: number; user?: boolean };
type Final = { um: Um; startMs: number; endMs: number; merged: boolean };

function seamsOf(state: EditState, durationMs: number): number {
  return Math.max(0, keepRangesOf(state, durationMs).length - 1);
}

/** What the applied cuts really remove (protected laughs already taken out). */
function activeRanges(state: EditState, type?: Decision["type"]): Array<{ startMs: number; endMs: number }> {
  return effectiveCutRanges(state, type);
}

/** Stretch each um to touch a silence cut within the merge gap, then over slivers. */
function finalize(base: EditState, ums: Um[], config: SoundClassifierConfig): Final[] {
  const silence = activeRanges(base, "silenceCut");
  const finals: Final[] = ums.map((um) => {
    let startMs = um.startMs;
    let endMs = um.endMs;
    let merged = false;
    for (const sc of silence) {
      if (sc.startMs < um.endMs && sc.endMs > um.startMs) merged = true; // overlaps: already one cut
      else if (um.startMs - sc.endMs >= 0 && um.startMs - sc.endMs <= config.umMergeGapMs) {
        startMs = Math.min(startMs, sc.endMs);
        merged = true;
      } else if (sc.startMs - um.endMs >= 0 && sc.startMs - um.endMs <= config.umMergeGapMs) {
        endMs = Math.max(endMs, sc.startMs);
        merged = true;
      }
    }
    return { um, startMs, endMs, merged };
  });

  const others = activeRanges(base);
  const prot = protectedRangesOf(base);
  for (let pass = 0; pass < 20; pass++) {
    // Slivers are judged on what is really removed, so protected laughs stay out of it.
    // A cut the creator made is not held back by protection, so it is judged whole.
    const pieces = finals.map((f) => ({
      f,
      pieces: effectivePieces({ startMs: f.startMs, endMs: f.endMs }, f.um.user ? [] : prot),
    }));
    const all = [...others, ...pieces.flatMap((x) => x.pieces)].sort((a, b) => a.startMs - b.startMs);
    const union: Array<{ startMs: number; endMs: number }> = [];
    for (const r of all) {
      const last = union[union.length - 1];
      if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
      else union.push({ ...r });
    }
    let changed = false;
    for (let k = 0; k + 1 < union.length && !changed; k++) {
      const gap = union[k + 1]!.startMs - union[k]!.endMs;
      if (gap <= 0 || gap >= config.umMinKeepMs) continue;
      const left = pieces.find((x) => x.pieces.some((p) => p.endMs === union[k]!.endMs))?.f;
      const right = pieces.find((x) => x.pieces.some((p) => p.startMs === union[k + 1]!.startMs))?.f;
      if (left && left.endMs < union[k + 1]!.startMs) {
        left.endMs = union[k + 1]!.startMs;
        changed = true;
      } else if (right && right.startMs > union[k]!.endMs) {
        right.startMs = union[k]!.endMs;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return finals;
}

function withUms(base: EditState, finals: Final[]): EditState {
  return { ...base, decisions: [...base.decisions, ...finals.map(toDecision)] };
}

function toDecision(f: Final): Decision {
  return makeDecision("umCut", f.startMs, f.endMs, {
    payload: {
      text: "um",
      cls: f.um.sound.cls,
      features: f.um.sound.features,
      mergedWithSilence: f.merged,
      original: { startMs: f.um.sound.startMs, endMs: f.um.sound.endMs },
    },
  });
}

/**
 * `base` is the state before any um cut (silence, hook and filler decisions as they
 * stand). Returns the um decisions to merge in (category "umCut") and a report.
 */
export function planUmCuts(
  base: EditState,
  sounds: ClassifiedSound[],
  sourceDurationMs: number,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): { decisions: Decision[]; report: UmCutReport } {
  const skipped: UmCutReport["skipped"] = [];
  const skip = (s: ClassifiedSound, reason: string) =>
    skipped.push({ startMs: s.startMs, endMs: s.endMs, lengthMs: s.lengthMs, reason });

  const baseKeep = keepRangesOf(base, sourceDurationMs);
  const baseSeams = Math.max(0, baseKeep.length - 1);
  const editedMs = baseKeep.reduce((sum, k) => sum + (k.endMs - k.startMs), 0);
  const allowed = Math.floor(editedMs / 1000 / config.umSecondsPerNewSeam);

  const candidates: Um[] = [];
  for (const s of sounds.filter((x) => x.cls === "um")) {
    const um = { sound: s, startMs: s.startMs + config.umEdgePaddingMs, endMs: s.endMs - config.umEdgePaddingMs };
    if (um.endMs - um.startMs < config.umMinCutMs) {
      skip(s, `shorter than ${config.umMinCutMs} ms after padding`);
      continue;
    }
    if (effectivePieces(um, protectedRangesOf(base)).length === 0) {
      skip(s, "inside a protected laugh");
      continue;
    }
    const covered = activeRanges(base).some((r) => r.startMs <= um.startMs && r.endMs >= um.endMs);
    if (covered) {
      skip(s, "already inside a cut");
      continue;
    }
    candidates.push(um);
  }

  // Longest first (then the steadiest) until the seam limit is reached.
  candidates.sort(
    (a, b) =>
      b.endMs - b.startMs - (a.endMs - a.startMs) || a.sound.features.steadiness - b.sound.features.steadiness,
  );
  const accepted: Um[] = [];
  for (const um of candidates) {
    const trial = [...accepted, um];
    const seams = seamsOf(withUms(base, finalize(base, trial, config)), sourceDurationMs);
    if (seams - baseSeams > allowed) skip(um.sound, `seam limit (${allowed} new seams allowed)`);
    else accepted.push(um);
  }

  const finals = finalize(base, accepted, config);
  const final = withUms(base, finals);
  const silenceOnly: EditState = {
    ...base,
    decisions: base.decisions.filter((d) => d.type === "silenceCut"),
  };
  return {
    decisions: finals.map(toDecision),
    report: {
      applied: finals
        .map((f) => ({
          startMs: f.startMs,
          endMs: f.endMs,
          lengthMs: f.endMs - f.startMs,
          mergedWithSilence: f.merged,
        }))
        .sort((a, b) => a.startMs - b.startMs),
      skipped: skipped.sort((a, b) => a.startMs - b.startMs),
      finalSeams: seamsOf(final, sourceDurationMs),
      silenceOnlySeams: seamsOf(silenceOnly, sourceDurationMs),
      seamLimit: { allowed, editedMs, capped: skipped.some((x) => x.reason.startsWith("seam limit")) },
    },
  };
}

/**
 * "Cut this sound": the creator decides about one method-2 candidate (um?, unsure or
 * laugh). It becomes an APPLIED umCut decision with origin 'user': same edge padding,
 * same merge with an adjacent silence cut and same no-slivers rule as an auto um cut.
 * It is allowed inside a laugh episode (the user wins), is never blocked by an earlier
 * reversal, and survives re-planning. Restore reverts it like any cut.
 */
export function addUserSoundCut(
  state: EditState,
  sound: { startMs: number; endMs: number; lengthMs: number } & Partial<Pick<ClassifiedSound, "cls" | "features" | "why">>,
  sourceDurationMs: number,
  config: SoundClassifierConfig = SOUND_CLASSIFIER_CONFIG,
): EditState {
  const classified: ClassifiedSound = {
    startMs: sound.startMs,
    endMs: sound.endMs,
    lengthMs: sound.lengthMs,
    cls: sound.cls ?? "unsure",
    features: sound.features ?? { durationMs: sound.lengthMs, peakVsSpeechDb: 0, steadiness: 0, burstCount: 0, nearEmphasis: false, midSpeech: false },
    why: sound.why ?? [],
  };
  let startMs = sound.startMs + config.umEdgePaddingMs;
  let endMs = sound.endMs - config.umEdgePaddingMs;
  // A very short sound the creator picked is cut whole rather than padded away.
  if (endMs - startMs < 60) {
    startMs = sound.startMs;
    endMs = sound.endMs;
  }
  const [final] = finalize(state, [{ sound: classified, startMs, endMs, user: true }], config);
  const decision = makeDecision("umCut", final!.startMs, final!.endMs, {
    origin: "user",
    payload: {
      text: "um",
      cls: classified.cls,
      features: classified.features,
      mergedWithSilence: final!.merged,
      original: { startMs: sound.startMs, endMs: sound.endMs },
      user: true,
    },
  });
  // An auto um cut with the very same range gives way to the creator's own.
  const without = { ...state, decisions: state.decisions.filter((d) => d.id !== decision.id || d.origin === "user") };
  const merged = mergePlan(without, [decision], []);
  return setStates(merged.state, { [decision.id]: "applied" });
}
