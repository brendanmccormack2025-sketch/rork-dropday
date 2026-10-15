/**
 * Ask for speech-recognition permission BEFORE the first video is edited (from the Camera / Camera Roll menu), so the
 * system prompt never interrupts the first edit. The speech module in this build has no separate "ask" call: it asks
 * when it first transcribes something, so a 0.6 s silent clip shipped with the app is transcribed once. Nothing is
 * uploaded; the result is ignored. Asked once per install; a "no" is respected (the editor then works without speech).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Asset } from "expo-asset";

import { speechCaptionsInBuild, transcribeAsync } from "@/modules/speech-captions";

const PRIMED_KEY = "tryal:speechPrimed:v1";
/** The editor's own one-time explainer (lib/transcription/useCaptions.ts): set too, so it is not shown again. */
const EXPLAINED_KEY = "trial:captionsExplained";
const SILENT_CLIP = require("../assets/audio/speech-primer.m4a") as number;

/** True when the explainer + system prompt should be shown before the first edit. */
export async function needsSpeechPrimer(): Promise<boolean> {
  if (!speechCaptionsInBuild) return false;
  try {
    return (await AsyncStorage.getItem(PRIMED_KEY)) === null;
  } catch {
    return false;
  }
}

/** Shows the system prompt (via one silent transcription) and remembers that it was asked. Never throws. */
export async function primeSpeechPermission(): Promise<void> {
  try {
    await AsyncStorage.multiSet([[PRIMED_KEY, "1"], [EXPLAINED_KEY, "1"]]);
  } catch {
    // asked anyway below
  }
  try {
    const asset = Asset.fromModule(SILENT_CLIP);
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    if (!uri) return;
    // the user answers the prompt during this call; give up waiting after 60 s (the prompt itself stays answerable)
    await Promise.race([transcribeAsync(uri).catch(() => null), new Promise((r) => setTimeout(r, 60_000))]);
  } catch {
    // the editor still works without speech
  }
}

/** "Not now" in the explainer: do not ask again from the menu (the editor asks later, as before). */
export async function skipSpeechPrimer(): Promise<void> {
  try {
    await AsyncStorage.setItem(PRIMED_KEY, "skipped");
  } catch {
    // ignore
  }
}
