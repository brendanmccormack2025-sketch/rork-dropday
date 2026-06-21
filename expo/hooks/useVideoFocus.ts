import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";

/**
 * Tracks whether the screen is currently focused.
 * Returns `false` when the user navigates away (tab switch, push, modal)
 * so video players can pause/unmute to prevent audio bleeding.
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
      return () => {
        setFocused(false);
      };
    }, []),
  );

  return focused;
}
