/**
 * Apple implementation of transcribeClip: the local speech-captions module
 * (SFSpeechRecognizer with requiresOnDeviceRecognition = true; it fails instead of
 * falling back to server recognition). It reads the video file itself and exports
 * its audio to a temporary m4a on the phone.
 */
import { Platform } from "react-native";

import { speechCaptionsInBuild, transcribeAsync } from "@/modules/speech-captions";
import { mapTranscribeError, mapTranscription } from "./map";
import type { TranscriptResult } from "./types";

export async function transcribeWithApple(sourceUri: string): Promise<TranscriptResult> {
  if (Platform.OS !== "ios") return { status: "unavailable", code: "NOT_IOS", message: "iOS only" };
  if (!speechCaptionsInBuild) {
    return { status: "unavailable", code: "NOT_IN_BUILD", message: "speech-captions not in this build" };
  }
  try {
    return mapTranscription(await transcribeAsync(sourceUri));
  } catch (e) {
    return mapTranscribeError(e);
  }
}
