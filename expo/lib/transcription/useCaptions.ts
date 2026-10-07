import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { CaptionStyle, EditOverlay } from "@/lib/editModel";
import { CAPTIONS_ON_BY_DEFAULT } from "@/lib/autoEdit/rollout";
import { combineSources, distinctSources, type ClipRange } from "@/lib/transcription/multiSource";
import { analysis } from "@/lib/autoEdit/analysis";
import type { TranscriptionInfo, Word } from "@/lib/transcription/types";
import {
  applyLineEdit,
  buildCaptionLines,
  captionLinesToEditOverlays,
  type EditorCaptionLine,
  type WordEdits,
} from "@/lib/transcription/captionLines";
import type { DraftClip } from "@/providers/PostsProvider";

const EXPLAINED_KEY = "trial:captionsExplained";

type Status = "waiting" | "asking" | "running" | "done";

export type CaptionsOptions = {
  /** Caption edits kept outside (in the edit state, so undo / redo cover them); undefined = kept here. */
  wordEdits?: WordEdits;
  onWordEdits?: (next: WordEdits) => void;
};

/**
 * Auto-captions for the editor. When `enabled`, once `ready` (silence detection has
 * finished) every local video file of the timeline is transcribed on-device, one after the
 * other and each cached per file, then caption lines are built on the edited timeline.
 * Anything other than a transcript leaves the editor as it was.
 * A timeline of one file (or segments of one recording) also gets the AI edits (transcribedUri
 * is set); a timeline of several files gets captions only.
 */
export function useCaptions(
  enabled: boolean,
  clips: DraftClip[],
  ready: boolean,
  captionStyle?: CaptionStyle | null,
  options?: CaptionsOptions,
) {
  const [captionsOn, setCaptionsOn] = useState(CAPTIONS_ON_BY_DEFAULT);
  const [status, setStatus] = useState<Status>("waiting");
  const [transcript, setTranscript] = useState<{
    /** The sources it was made for (uris joined). */
    key: string;
    /** The one source file when the timeline has one; null for several. */
    uri: string | null;
    words: Word[];
    wordUris: string[];
    removedWords: Word[];
  } | null>(null);
  const [localEdits, setLocalEdits] = useState<WordEdits>({});
  const edits = options?.wordEdits ?? localEdits;
  const [transcriptionInfo, setTranscriptionInfo] = useState<TranscriptionInfo | null>(null);
  const startedUriRef = useRef<string[] | null>(null);

  // Every clip must be a local video; the sources are its distinct files.
  const captionable = clips.length > 0 && clips.every((c) => c.type === "video" && !c.uri.startsWith("http"));
  const sources = useMemo(() => (captionable ? distinctSources(clips) : []), [captionable, clips]);
  const sourcesKey = sources.join("|");

  const run = useCallback(async (uris: string[]) => {
    setStatus("running");
    // One file after the other: the recognizer and the analysis cache run one job at a time anyway.
    const parts: Array<{ uri: string; words: Word[]; removed: Word[] }> = [];
    let first: Awaited<ReturnType<typeof analysis.transcriptWithInfo>> | null = null;
    let failure: Awaited<ReturnType<typeof analysis.transcriptWithInfo>> | null = null;
    let fromCacheAll = true;
    let repeated = 0;
    let overlapping = 0;
    const decisions: NonNullable<TranscriptionInfo["dedupeDecisions"]> = [];
    const keys: string[] = [];
    for (const uri of uris) {
      const outcome = await analysis.transcriptWithInfo(uri);
      first = first ?? outcome;
      keys.push(outcome.key ?? "none");
      fromCacheAll = fromCacheAll && outcome.fromCache;
      if (outcome.result.status === "ok") {
        parts.push({ uri, words: outcome.result.words, removed: outcome.result.removed?.words ?? [] });
        repeated += outcome.result.removed?.repeatedWords ?? 0;
        overlapping += outcome.result.removed?.overlappingWords ?? 0;
        decisions.push(...(outcome.result.removed?.decisions ?? []));
      } else {
        failure = failure ?? outcome;
        // Permission denied or no recognizer: the other files will not do better.
        if (outcome.result.status === "denied" || outcome.result.status === "unavailable") break;
      }
    }
    if (parts.length > 0) {
      const combined = combineSources(parts);
      setTranscriptionInfo({
        status: "ok",
        wordCount: combined.words.length,
        repeatedWordsRemoved: repeated,
        overlappingWordsRemoved: overlapping,
        dedupeDecisions: decisions,
        fromCache: fromCacheAll,
        key: keys.join(" + "),
      });
      setTranscript({
        key: uris.join("|"),
        uri: uris.length === 1 ? uris[0]! : null,
        words: combined.words,
        wordUris: combined.wordUris,
        removedWords: parts.flatMap((p) => p.removed),
      });
    } else {
      const f = failure ?? first;
      const result = f?.result;
      setTranscriptionInfo({
        status: result && result.status !== "ok" ? result.status : "error",
        code: result && result.status !== "ok" ? result.code : undefined,
        message: result && result.status !== "ok" ? result.message : undefined,
        wordCount: 0,
        fromCache: f?.fromCache ?? false,
        key: keys.join(" + ") || null,
      });
      console.log("[captions] no transcript:", result?.status ?? "none");
    }
    setStatus("done");
  }, []);

  useEffect(() => {
    if (!enabled || !ready || status !== "waiting") return;
    if (sources.length === 0) {
      setTranscriptionInfo({
        status: "skipped",
        message: "the timeline is not made of local video files",
        wordCount: 0,
        fromCache: false,
        key: null,
      });
      setStatus("done");
      return;
    }
    startedUriRef.current = sources;
    (async () => {
      let explained = false;
      try {
        explained = (await AsyncStorage.getItem(EXPLAINED_KEY)) === "1";
      } catch {}
      if (explained) await run(sources);
      else setStatus("asking");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ready, status, sourcesKey, run]);

  // A source file was added to the timeline after the transcript: transcribe again (cached per file).
  useEffect(() => {
    if (status === "done" && transcript && sourcesKey && transcript.key !== sourcesKey) setStatus("waiting");
  }, [status, transcript, sourcesKey]);

  const onContinue = useCallback(() => {
    AsyncStorage.setItem(EXPLAINED_KEY, "1").catch(() => {});
    if (startedUriRef.current) void run(startedUriRef.current);
    else setStatus("done");
  }, [run]);
  const onNotNow = useCallback(() => {
    setTranscriptionInfo({ status: "skipped", message: "the creator chose Not now", wordCount: 0, fromCache: false, key: null });
    setStatus("done");
  }, []);

  /** Run the transcription again from scratch (after the analysis cache was cleared). */
  const restart = useCallback(() => {
    setTranscript(null);
    setTranscriptionInfo(null);
    startedUriRef.current = null;
    setStatus("waiting");
  }, []);

  const keptKey = JSON.stringify(clips.map((c) => [c.uri, c.trimStartMs ?? 0, c.trimEndMs ?? 0, c.durationMs ?? 0]));
  const lines: EditorCaptionLine[] = useMemo(() => {
    if (!enabled || !transcript || transcript.key !== sourcesKey) return [];
    const ranges: ClipRange[] = clips.map((c) => ({
      uri: c.uri,
      startMs: c.trimStartMs ?? 0,
      endMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
    }));
    // One source file: the single-file mapping (touching ranges are one stretch). Several: per clip.
    return transcript.uri
      ? buildCaptionLines(transcript.words, edits, ranges, captionStyle)
      : buildCaptionLines(transcript.words, edits, ranges, captionStyle, { wordUris: transcript.wordUris, clips: ranges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, transcript, sourcesKey, edits, keptKey, captionStyle]);

  const overlays: EditOverlay[] = useMemo(
    () => (captionsOn ? captionLinesToEditOverlays(lines, captionStyle) : []),
    [captionsOn, lines, captionStyle],
  );

  useEffect(() => {
    if (enabled && lines.length > 0) {
      console.log("[captions] lines:", JSON.stringify(lines.map((l) => [l.text, l.startMs, l.endMs])));
    }
  }, [enabled, lines]);

  const editLine = useCallback(
    (index: number, newText: string) => {
      const line = lines[index];
      if (!line || !transcript) return;
      const next = applyLineEdit(transcript.words, edits, line, newText);
      if (options?.onWordEdits) options.onWordEdits(next);
      else setLocalEdits(next);
    },
    [lines, transcript, edits, options],
  );
  /** Delete one caption line: every word of it is deleted (reversible with undo, survives cut changes). */
  const deleteLine = useCallback((index: number) => editLine(index, ""), [editLine]);

  return {
    /** The transcript (source timeline) and the file it belongs to, once there is one. */
    words: transcript?.words ?? null,
    /** Words dedupe dropped (nothing may be cut where one was). */
    removedWords: transcript?.removedWords ?? [],
    transcriptionInfo,
    restart,
    transcribedUri: transcript?.uri ?? null,
    /** True when the timeline has several source files (captions only, no AI cuts). */
    multiSource: !!transcript && transcript.uri === null,
    deleteLine,
    explainerVisible: status === "asking",
    onContinue,
    onNotNow,
    captionsOn,
    setCaptionsOn,
    lines,
    overlays,
    /** True while captions are still on their way, so render-ahead should wait. */
    pending: enabled && captionsOn && (status === "waiting" || status === "running"),
    editLine,
  };
}
