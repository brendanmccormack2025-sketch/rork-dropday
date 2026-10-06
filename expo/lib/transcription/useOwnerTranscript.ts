import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { DraftClip } from "@/providers/PostsProvider";
import { mapWordsToEdit, transcribeClip, type Word } from "@/lib/transcription";

const EXPLAINED_KEY = "trial:captionsExplained";

/**
 * Owner-only, debug: transcribe the editor's source clip once (on-device), then log
 * the words on the edited timeline whenever the cuts change. No visible UI except
 * the one-time explanation shown before the first speech permission prompt.
 * Only a timeline made of one local video file is transcribed.
 */
export function useOwnerTranscript(enabled: boolean, clips: DraftClip[]) {
  const [explainerVisible, setExplainerVisible] = useState(false);
  const [words, setWords] = useState<Word[] | null>(null);
  const startedRef = useRef(false);

  const first = clips[0];
  const sourceUri =
    first &&
    first.type === "video" &&
    !first.uri.startsWith("http") &&
    clips.every((c) => c.uri === first.uri && c.type === "video")
      ? first.uri
      : null;

  const run = useCallback(async (uri: string) => {
    const result = await transcribeClip(uri);
    if (result.status === "ok") setWords(result.words);
    else console.log("[transcript]", result.status, result.message ?? "");
  }, []);

  useEffect(() => {
    if (!enabled || !sourceUri || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      let explained = false;
      try {
        explained = (await AsyncStorage.getItem(EXPLAINED_KEY)) === "1";
      } catch {}
      if (explained) await run(sourceUri);
      else setExplainerVisible(true);
    })();
  }, [enabled, sourceUri, run]);

  const onContinue = useCallback(() => {
    setExplainerVisible(false);
    AsyncStorage.setItem(EXPLAINED_KEY, "1").catch(() => {});
    if (sourceUri) void run(sourceUri);
  }, [sourceUri, run]);

  const onNotNow = useCallback(() => setExplainerVisible(false), []);

  const keptKey = JSON.stringify(clips.map((c) => [c.trimStartMs ?? 0, c.trimEndMs ?? 0, c.durationMs ?? 0]));
  useEffect(() => {
    if (!enabled || !words || !sourceUri) return;
    const kept = clips.map((c) => ({
      startMs: c.trimStartMs ?? 0,
      endMs: c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0),
    }));
    const mapped = mapWordsToEdit(words, kept);
    console.log(
      "[transcript] output timeline:",
      JSON.stringify(mapped.map((w) => [w.text, w.startMs, w.endMs])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, words, sourceUri, keptKey]);

  return { explainerVisible, onContinue, onNotNow };
}
