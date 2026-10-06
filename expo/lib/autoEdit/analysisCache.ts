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
  const transcriptFlight = new Map<string, Promise<TranscriptResult>>();
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

  async function transcript(uri: string): Promise<TranscriptResult> {
    const key = await keyFor(uri);
    if (key) {
      const words = transcriptMem.get(key);
      if (words) return { status: "ok", words };
      const flying = transcriptFlight.get(key);
      if (flying) return flying;
    }
    const job = (async (): Promise<TranscriptResult> => {
      // Silence detection first when it is running for this source.
      if (key) await loudnessFlight.get(key)?.catch(() => null);
      if (key) {
        const stored = await readStored<Word[]>("transcript", key);
        if (stored) {
          transcriptMem.set(key, stored);
          return { status: "ok", words: stored };
        }
      }
      const result = await serial(async () => {
        runs.transcript++;
        return deps.transcribe(uri);
      });
      if (result.status === "ok" && key) {
        transcriptMem.set(key, result.words);
        await writeStored("transcript", key, result.words);
      }
      return result;
    })();
    if (key) transcriptFlight.set(key, job);
    try {
      return await job;
    } finally {
      if (key) transcriptFlight.delete(key);
    }
  }

  return { loudness, transcript, runs };
}
