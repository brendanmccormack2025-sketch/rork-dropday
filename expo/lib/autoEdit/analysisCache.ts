/**
 * Analysis cache: loudness and transcript are computed once per source and reused.
 * The key is uri + file size + modification time. Toggling or reverting a decision
 * never reaches this file: only planners and the render run again.
 *
 * Analyses never run at the same time, and a source's transcript waits for its
 * silence (loudness) analysis if that one is running.
 *
 * Pure apart from the injected deps; erasable TypeScript only (see decisions.ts).
 */
import { detectSilences } from "../silenceDetection.ts";
import type { TranscriptResult, Word } from "./../transcription/types.ts";

export type SourceStat = { uri: string; size: number; mtime: number };
export type LoudnessData = { durationMs: number; windows: number[] };

export type AnalysisDeps = {
  stat(uri: string): Promise<SourceStat | null>;
  loadLoudness(uri: string): Promise<LoudnessData | null>;
  transcribe(uri: string): Promise<TranscriptResult>;
  storage?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
};

/**
 * An empty transcript is believed only if the audio really is (almost) silent: with
 * more than this much sound it is an 'error' and is never cached.
 */
export const EMPTY_TRANSCRIPT_MIN_SOUND_MS = 2000;

/** Milliseconds of audio above the silence detector's threshold. */
export function nonSilentMs(loud: LoudnessData | null): number {
  if (!loud || loud.windows.length === 0) return 0;
  const windowMs = loud.durationMs / loud.windows.length;
  const threshold = detectSilences(loud.windows, windowMs, { durationMs: loud.durationMs }).thresholdDb;
  let n = 0;
  for (const v of loud.windows) if (Number.isFinite(v) && v > threshold) n++;
  return n * windowMs;
}

const PREFIX = "trial:analysis:v1:";
const INDEX_KEY = `${PREFIX}index`;
const MAX_STORED = 6;

export function sourceKeyOf(s: SourceStat): string {
  return `${s.uri}|${s.size}|${Math.round(s.mtime)}`;
}

export function createAnalysisCache(deps: AnalysisDeps) {
  const loudnessMem = new Map<string, LoudnessData | null>();
  const transcriptMem = new Map<string, Word[]>();
  const loudnessFlight = new Map<string, Promise<LoudnessData | null>>();
  const transcriptFlight = new Map<string, Promise<{ result: TranscriptResult; fromCache: boolean; key: string | null }>>();
  const runs = { loudness: 0, transcript: 0 };
  let tail: Promise<unknown> = Promise.resolve();

  /** One analysis at a time. */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job, job);
    tail = next.catch(() => {});
    return next;
  }

  async function keyFor(uri: string): Promise<string | null> {
    const s = await deps.stat(uri).catch(() => null);
    return s ? sourceKeyOf(s) : null;
  }

  async function readStored<T>(kind: string, key: string): Promise<T | null> {
    if (!deps.storage) return null;
    try {
      const raw = await deps.storage.get(`${PREFIX}${kind}:${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async function writeStored(kind: string, key: string, value: unknown): Promise<void> {
    if (!deps.storage) return;
    try {
      await deps.storage.set(`${PREFIX}${kind}:${key}`, JSON.stringify(value));
      const rawIndex = await deps.storage.get(INDEX_KEY);
      const index: string[] = rawIndex ? (JSON.parse(rawIndex) as string[]) : [];
      const entry = `${kind}:${key}`;
      const next = [...index.filter((e) => e !== entry), entry];
      while (next.length > MAX_STORED * 2) {
        const old = next.shift()!;
        await deps.storage.remove(`${PREFIX}${old}`);
      }
      await deps.storage.set(INDEX_KEY, JSON.stringify(next));
    } catch {
      // The persistent copy is a bonus.
    }
  }

  async function loudness(uri: string): Promise<LoudnessData | null> {
    const key = await keyFor(uri);
    if (!key) return serial(() => deps.loadLoudness(uri));
    if (loudnessMem.has(key)) return loudnessMem.get(key)!;
    const flying = loudnessFlight.get(key);
    if (flying) return flying;
    const job = (async () => {
      const stored = await readStored<LoudnessData>("loudness", key);
      if (stored) {
        loudnessMem.set(key, stored);
        return stored;
      }
      const data = await serial(async () => {
        runs.loudness++;
        return deps.loadLoudness(uri);
      });
      loudnessMem.set(key, data);
      if (data) await writeStored("loudness", key, data);
      return data;
    })();
    loudnessFlight.set(key, job);
    try {
      return await job;
    } finally {
      loudnessFlight.delete(key);
    }
  }

  async function forget(key: string, kinds: string[]): Promise<void> {
    for (const kind of kinds) {
      if (kind === "transcript") transcriptMem.delete(key);
      if (kind === "loudness") loudnessMem.delete(key);
    }
    if (!deps.storage) return;
    try {
      for (const kind of kinds) await deps.storage.remove(`${PREFIX}${kind}:${key}`);
      const rawIndex = await deps.storage.get(INDEX_KEY);
      const index: string[] = rawIndex ? (JSON.parse(rawIndex) as string[]) : [];
      await deps.storage.set(INDEX_KEY, JSON.stringify(index.filter((e) => !kinds.some((k) => e === `${k}:${key}`))));
    } catch {
      // Nothing to clean up is fine.
    }
  }

  /** True when the audio of this source has real sound (so an empty transcript cannot be right). */
  async function hasSpeechSound(uri: string): Promise<boolean> {
    const loud = await loudness(uri).catch(() => null);
    return nonSilentMs(loud) > EMPTY_TRANSCRIPT_MIN_SOUND_MS;
  }

  type TranscriptOutcome = { result: TranscriptResult; fromCache: boolean; key: string | null };

  async function transcriptWithInfo(uri: string): Promise<TranscriptOutcome> {
    const key = await keyFor(uri);
    if (key) {
      const flying = transcriptFlight.get(key);
      if (flying) return flying;
    }
    const job = (async (): Promise<TranscriptOutcome> => {
      // Silence detection first when it is running for this source.
      if (key) await loudnessFlight.get(key)?.catch(() => null);
      if (key) {
        const cached = transcriptMem.get(key) ?? (await readStored<Word[]>("transcript", key)) ?? undefined;
        if (cached) {
          // A cached EMPTY transcript is trusted only if the audio is silent (it may
          // have been stored by an older build, or after a recognizer that heard nothing).
          if (cached.length > 0 || !(await hasSpeechSound(uri))) {
            transcriptMem.set(key, cached);
            return { result: { status: "ok", words: cached }, fromCache: true, key };
          }
          await forget(key, ["transcript"]);
        }
      }
      const result = await serial(async () => {
        runs.transcript++;
        return deps.transcribe(uri);
      });
      if (result.status === "ok" && result.words.length === 0 && (await hasSpeechSound(uri))) {
        return {
          result: {
            status: "error",
            code: "EMPTY_TRANSCRIPT_WITH_SPEECH",
            message: "the recognizer returned no words, but the audio has sound; not cached, will retry next time",
          },
          fromCache: false,
          key,
        };
      }
      if (result.status === "ok" && key) {
        transcriptMem.set(key, result.words);
        await writeStored("transcript", key, result.words);
      }
      return { result, fromCache: false, key };
    })();
    if (key) transcriptFlight.set(key, job);
    try {
      return await job;
    } finally {
      if (key) transcriptFlight.delete(key);
    }
  }

  async function transcript(uri: string): Promise<TranscriptResult> {
    return (await transcriptWithInfo(uri)).result;
  }

  /** Forget everything cached for this source (memory and storage): the next analysis runs again. */
  async function clear(uri: string): Promise<string | null> {
    const key = await keyFor(uri);
    if (key) await forget(key, ["loudness", "transcript"]);
    return key;
  }

  return { loudness, transcript, transcriptWithInfo, clear, runs };
}
