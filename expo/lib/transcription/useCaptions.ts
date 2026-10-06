import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { EditOverlay } from "@/lib/editModel";
import { transcribeClip, type Word } from "@/lib/transcription";
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
export function useCaptions(enabled: boolean, clips: DraftClip[], ready: boolean) {
  const [captionsOn, setCaptionsOn] = useState(true);
  const [status, setStatus] = useState<Status>("waiting");
  const [transcript, setTranscript] = useState<{ uri: string; words: Word[] } | null>(null);
  const [edits, setEdits] = useState<WordEdits>({});
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
    const result = await transcribeClip(uri);
    if (result.status === "ok") {
      setTranscript({ uri, words: result.words });
    } else if (__DEV__) {
      console.log("[captions] no transcript:", result.status, result.message ?? "");
    }
    setStatus("done");
  }, []);

  useEffect(() => {
    if (!enabled || !ready || status !== "waiting") return;
    if (!sourceUri) {
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
  const onNotNow = useCallback(() => setStatus("done"), []);

  const keptKey = JSON.stringify(clips.map((c) => [c.trimStartMs ?? 0, c.trimEndMs ?? 0, c.durationMs ?? 0]));
  const lines: EditorCaptionLine[] = useMemo(() => {
    if (!enabled || !transcript || transcript.uri !== sourceUri) return [];
    const kept = clips.map((c) => ({
      startMs: c.trimStartMs ?? 0,
      endMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
    }));
    return buildCaptionLines(transcript.words, edits, kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, transcript, sourceUri, edits, keptKey]);

  const overlays: EditOverlay[] = useMemo(
    () => (captionsOn ? captionLinesToEditOverlays(lines) : []),
    [captionsOn, lines],
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
