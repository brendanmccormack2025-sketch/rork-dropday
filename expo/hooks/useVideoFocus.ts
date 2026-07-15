import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { Audio } from "expo-av";

/**
 * Tracks whether the screen is currently focused.
 * Returns `false` when the user navigates away (tab switch, push, modal)
 * so video players can pause/unmute to prevent audio bleeding.
 *
 * Also manages the iOS audio session: sets playback-only mode on focus,
 * which fixes intermittent silent-video bugs caused by expo-camera
 * leaving the audio session in PlayAndRecord mode after recording.
 *
 * Usage:
 *   const screenFocused = useVideoFocus();
 *   <Video shouldPlay={active && screenFocused} isMuted={!(active && screenFocused)} />
 */
export function useVideoFocus(): boolean {
  const [focused, setFocused] = useState<boolean>(true);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);

      // Restore playback-only audio mode whenever the feed/reactions tabs gain focus.
      // expo-camera switches the iOS AVAudioSession to PlayAndRecord mode during
      // recording; if it isn't reset, expo-av Video players may render video but
      // produce no audio (intermittent bug reported on real devices).
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      }).catch(() => {});

      return () => {
        setFocused(false);
      };
    }, []),
  );

  return focused;
}
