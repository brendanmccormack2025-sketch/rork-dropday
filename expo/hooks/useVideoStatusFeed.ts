import { useEffect, useRef } from "react";
import type { VideoPlayer } from "expo-video";

/**
 * expo-av-style playback status, synthesized from expo-video player events.
 *
 * Field names mirror the AVPlaybackStatus shape the app's playback logic
 * (stall detection, trim gates, segment advance) was written against, so
 * those consumers keep working unchanged.
 */
export type VideoPlaybackStatus = {
  isLoaded: boolean;
  isPlaying: boolean;
  positionMillis: number;
  durationMillis: number;
  isBuffering: boolean;
  /** True only on the status emitted for the playToEnd event. */
  didJustFinish: boolean;
  /** Present when the player entered the error state. */
  error?: string;
};

type StatusFeedHandlers = {
  onStatus?: (status: VideoPlaybackStatus) => void;
  /** Fired once per source load, when the player becomes readyToPlay. */
  onLoad?: (info: { durationMillis: number }) => void;
  /** Fired when the player enters the error state. */
  onError?: (message: string) => void;
};

/**
 * Subscribes to an expo-video player's events and forwards them as a
 * merged, expo-av-compatible status object. Re-subscribes only when the
 * player instance changes; the handlers ref stays fresh across renders.
 */
export function useVideoStatusFeed(
  player: VideoPlayer | null | undefined,
  handlers: StatusFeedHandlers,
): void {
  const handlersRef = useRef<StatusFeedHandlers>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!player) return;

    const state = {
      isLoaded: false,
      isPlaying: false,
      positionMillis: 0,
      durationMillis: 0,
      isBuffering: false,
    };

    const emit = (didJustFinish = false, error?: string): void => {
      handlersRef.current.onStatus?.({
        isLoaded: state.isLoaded,
        isPlaying: state.isPlaying,
        positionMillis: state.positionMillis,
        durationMillis: state.durationMillis,
        isBuffering: state.isBuffering,
        didJustFinish,
        ...(error !== undefined ? { error } : {}),
      });
    };

    const subscriptions = [
      player.addListener("statusChange", ({ status, error }) => {
        state.isBuffering = status === "loading";
        if (status === "readyToPlay") {
          const wasLoaded = state.isLoaded;
          state.isLoaded = true;
          state.durationMillis = Math.round((player.duration || 0) * 1000);
          if (!wasLoaded) {
            handlersRef.current.onLoad?.({
              durationMillis: state.durationMillis,
            });
          }
          emit();
          return;
        }
        state.isLoaded = false;
        if (status === "error") {
          state.isPlaying = false;
          const message = error?.message ?? "Video playback error";
          handlersRef.current.onError?.(message);
          emit(false, message);
          return;
        }
        emit();
      }),
      player.addListener("playingChange", ({ isPlaying }) => {
        state.isPlaying = isPlaying;
        emit();
      }),
      player.addListener("timeUpdate", ({ currentTime }) => {
        state.positionMillis = Math.round(currentTime * 1000);
        emit();
      }),
      player.addListener("playToEnd", () => {
        emit(true);
      }),
    ];

    return () => {
      for (const sub of subscriptions) sub.remove();
    };
  }, [player]);
}
