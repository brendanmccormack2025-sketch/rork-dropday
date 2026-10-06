/**
 * Provider-agnostic transcription. The editor only imports this file; the
 * implementation behind transcribeClip can be swapped (for example for Whisper)
 * without touching the editor. Never uses a network service.
 */
import { transcribeWithApple } from "./apple";
import type { TranscriptResult } from "./types";

export type { TranscriptResult, Word } from "./types";
export { mapWordsToEdit } from "./mapWords";

export function transcribeClip(sourceUri: string): Promise<TranscriptResult> {
  return transcribeWithApple(sourceUri);
}
