/**
 * The iPhone's audio session, set only when it really needs to change. Recording (the camera) switches it to
 * record + play; playback screens put it back. Setting it again while a video plays makes iOS stutter that video,
 * so a screen coming back into view only restores playback mode when the camera changed it since.
 */
import { setAudioModeAsync } from "expo-audio";

let recordingMode = false;

/** The camera is recording-ready (called when it mounts). */
export function enterRecordingMode(): void {
  recordingMode = true;
  setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
}

/** Back to playback (the camera closing, or a playback screen while the camera's mode is still set). */
export function restorePlaybackMode(): void {
  if (!recordingMode) return;
  recordingMode = false;
  setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
}

/** For tests. */
export function isRecordingMode(): boolean {
  return recordingMode;
}
