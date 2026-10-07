import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { CaptionStyle, EditOverlay } from "@/lib/editModel";
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

/**
 * Auto-captions for the editor. When `enabled`, once `ready` (silence detection has
 * finished) the source clip is transcribed on-device, then caption lines are built on
 * the edited timeline. Anything other than a transcript leaves the editor as it was.
 * Only a timeline made of one local video file is captioned.
 */
export function useCaptions(enabled: boolean, clips: DraftClip[], ready: boolean, captionStyle?: CaptionStyle | null) {
  const [captionsOn, setCaptionsOn] = useState(true);
  const [status, setStatus] = useState<Status>("waiting");
  const [transcript, setTranscript] = useState<{ uri: string; words: Word[]; removedWords: Word[] } | null>(null);
  const [edits, setEdits] = useState<WordEdits>({});
  const [transcriptionInfo, setTranscriptionInfo] = useState<TranscriptionInfo | null>(null);
  const startedUriRef = useRef<string | null>(null);

  const first = clips[0];
  const sourceUri =
    first &&
    first.type === "video" &&
    !first.uri.startsWith("http") &&
    clips.every((c) => c.uri === first.uri && c.type === "video")
      ? first.uri
      : null;

  const run = useCallback(async (uri: string) => {
    setStatus("running");
    const { result, fromCache, key } = await analysis.transcriptWithInfo(uri);
    setTranscriptionInfo(
      result.status === "ok"
        ? {
            status: "ok",
            wordCount: result.words.length,
            repeatedWordsRemoved: result.removed?.repeatedWords ?? 0,
            overlappingWordsRemoved: result.removed?.overlappingWords ?? 0,
            dedupeDecisions: result.removed?.decisions ?? [],
            fromCache,
            key,
          }
        : { status: result.status, code: result.code, message: result.message, wordCount: 0, fromCache, key },
    );
    if (result.status === "ok") {
      setTranscript({ uri, words: result.words, removedWords: result.removed?.words ?? [] });
    } else {
      console.log("[captions] no transcript:", result.status, result.code ?? "", result.message ?? "");
    }
    setStatus("done");
  }, []);

  useEffect(() => {
    if (!enabled || !ready || status !== "waiting") return;
    if (!sourceUri) {
      setTranscriptionInfo({
        status: "skipped",
        message: "the timeline is not one local video file",
        wordCount: 0,
        fromCache: false,
        key: null,
      });
      setStatus("done");
      return;
    }
    startedUriRef.current = sourceUri;
    (async () => {
      let explained = false;
      try {
        explained = (await AsyncStorage.getItem(EXPLAINED_KEY)) === "1";
      } catch {}
      if (explained) await run(sourceUri);
      else setStatus("asking");
    })();
  }, [enabled, ready, status, sourceUri, run]);

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

  const keptKey = JSON.stringify(clips.map((c) => [c.trimStartMs ?? 0, c.trimEndMs ?? 0, c.durationMs ?? 0]));
  const lines: EditorCaptionLine[] = useMemo(() => {
    if (!enabled || !transcript || transcript.uri !== sourceUri) return [];
    const kept = clips.map((c) => ({
      startMs: c.trimStartMs ?? 0,
      endMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
    }));
    return buildCaptionLines(transcript.words, edits, kept, captionStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, transcript, sourceUri, edits, keptKey, captionStyle]);

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
      setEdits((prev) => applyLineEdit(transcript.words, prev, line, newText));
    },
    [lines, transcript],
  );

  return {
    /** The transcript (source timeline) and the file it belongs to, once there is one. */
    words: transcript?.words ?? null,
    /** Words dedupe dropped (nothing may be cut where one was). */
    removedWords: transcript?.removedWords ?? [],
    transcriptionInfo,
    restart,
    transcribedUri: transcript?.uri ?? null,
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
