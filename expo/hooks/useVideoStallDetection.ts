import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import type { Video } from "expo-av";
import type { AVPlaybackStatus } from "expo-av";

const STALL_TIMEOUT_MS = 4000; // position must advance within this window
const MAX_RETRIES = 3;
const RELOAD_COOLDOWN_MS = 5000;
const STALL_GRACE_PERIOD_MS = 2000; // ignore stalls during initial buffering

export type VideoEvent =
  | { type: "load_start"; postId: string; uri: string }
  | { type: "load_success"; postId: string; durationMs: number | undefined }
  | { type: "load_error"; postId: string; error: string }
  | { type: "ready_for_display"; postId: string }
  | { type: "buffering_start"; postId: string; positionMs: number }
  | { type: "buffering_end"; postId: string; positionMs: number }
  | { type: "stall_detected"; postId: string; positionMs: number; isPlaying: boolean }
  | { type: "stall_recovery_attempt"; postId: string; attempt: number; method: string }
  | { type: "stall_recovered"; postId: string; afterMs: number }
  | { type: "stall_recovery_failed"; postId: string; attempts: number }
  | { type: "app_state_change"; postId: string; newState: string }
  | { type: "position_update"; postId: string; positionMs: number; isPlaying: boolean }
  | { type: "player_error"; postId: string; error: string };

export interface StallDetectionState {
  isBuffering: boolean;
  stallCount: number;
  lastStallPos: number;
  recovering: boolean;
}

/**
 * Detects playback stalls and auto-recovers expo-av Video players.
 *
 * A stall is when the player reports `isPlaying: true` but
 * `positionMillis` hasn't advanced for STALL_TIMEOUT_MS.
 * Recovery: playAsync() first, then reload source on repeated failures.
 *
 * Also handles AppState changes — resuming a video from background
 * can leave the native player in a broken state.
 */
export function useVideoStallDetection(
  postId: string,
  active: boolean,
  sourceUri: string,
  onLog: (event: VideoEvent) => void,
  externalVideoRef?: React.MutableRefObject<Video | null>,
) {
  const internalVideoRef = useRef<Video>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;
  const lastPositionRef = useRef<number>(0);
  const lastPositionTimeRef = useRef<number>(Date.now());
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveringRef = useRef<boolean>(false);
  const retryCountRef = useRef<number>(0);
  const lastReloadTimeRef = useRef<number>(0);
  const appStateRef = useRef<AppStateStatus>("active");
  const wasBackgroundedRef = useRef<boolean>(false);
  // Ref-based active so stall timer callback always sees the latest value
  const activeRef = useRef<boolean>(active);
  activeRef.current = active;

  // ── Buffering + recovery state ──────────────────────────────────────
  const [stallState, setStallState] = useState<StallDetectionState>({
    isBuffering: false,
    stallCount: 0,
    lastStallPos: 0,
    recovering: false,
  });

  // Ref-based buffering state so handlePlaybackStatus doesn't recreate on every toggle
  const isBufferingRef = useRef<boolean>(false);
  const playbackStartTimeRef = useRef<number>(0);

  // ── Stall timer management ──────────────────────────────────────────
  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const startStallTimer = useCallback(
    (positionMs: number, isPlaying: boolean) => {
      clearStallTimer();
      if (!isPlaying || !active) return;

      stallTimerRef.current = setTimeout(() => {
        // Guard: only fire if still active and video ref is live.
        // The user may have scrolled away during the 4s window, making
        // videoRef.current null and causing undefined.then() crashes.
        if (!activeRef.current || !videoRef.current) return;
        // Check if position has advanced since we started the timer
        const elapsed = Date.now() - lastPositionTimeRef.current;
        if (elapsed >= STALL_TIMEOUT_MS && recoveringRef.current === false) {
          onLog({
            type: "stall_detected",
            postId,
            positionMs: lastPositionRef.current,
            isPlaying,
          });
          setStallState((s) => ({
            ...s,
            stallCount: s.stallCount + 1,
            lastStallPos: lastPositionRef.current,
          }));
          attemptRecovery();
        }
      }, STALL_TIMEOUT_MS);
    },
    [active, clearStallTimer, onLog, postId],
  );

  // ── Recovery logic ──────────────────────────────────────────────────
  const attemptRecovery = useCallback(() => {
    if (recoveringRef.current) return;
    const now = Date.now();
    // Prevent rapid reloads
    if (now - lastReloadTimeRef.current < RELOAD_COOLDOWN_MS && retryCountRef.current > 0) {
      onLog({
        type: "stall_recovery_attempt",
        postId,
        attempt: retryCountRef.current,
        method: "skipped_cooldown",
      });
      return;
    }

    recoveringRef.current = true;
    setStallState((s) => ({ ...s, recovering: true }));

    const attempt = retryCountRef.current + 1;
    onLog({ type: "stall_recovery_attempt", postId, attempt, method: "playAsync" });

    // Safety: guard against null ref (component unmounted during stall window)
    if (!videoRef.current) {
      recoveringRef.current = false;
      setStallState((s) => ({ ...s, recovering: false }));
      return;
    }
    videoRef.current
      .playAsync()
      .then(() => {
        lastReloadTimeRef.current = now;
        onLog({ type: "stall_recovered", postId, afterMs: 0 });
        recoveringRef.current = false;
        retryCountRef.current = 0;
        setStallState((s) => ({ ...s, recovering: false }));
      })
      .catch(() => {
        // playAsync failed — try reloading the source
        retryCountRef.current = attempt;
        if (attempt > MAX_RETRIES) {
          onLog({ type: "stall_recovery_failed", postId, attempts: attempt });
          recoveringRef.current = false;
          setStallState((s) => ({ ...s, recovering: false }));
          return;
        }

        const nextMethod = attempt <= MAX_RETRIES ? "reload_source" : "exhausted";
        onLog({ type: "stall_recovery_attempt", postId, attempt, method: nextMethod });

        if (attempt <= MAX_RETRIES) {
          if (!videoRef.current) {
            recoveringRef.current = false;
            setStallState((s) => ({ ...s, recovering: false }));
            return;
          }
          videoRef.current
            .unloadAsync()
            .then(() =>
              videoRef.current!.loadAsync(
                { uri: sourceUri },
                { shouldPlay: true, isLooping: true },
                false,
              ),
            )
            .then(() => {
              lastReloadTimeRef.current = Date.now();
              onLog({ type: "stall_recovered", postId, afterMs: 0 });
              recoveringRef.current = false;
              retryCountRef.current = 0;
              setStallState((s) => ({ ...s, recovering: false }));
            })
            .catch(() => {
              recoveringRef.current = false;
              setStallState((s) => ({ ...s, recovering: false }));
            });
        }
      });
  }, [postId, sourceUri, onLog]);

  // ── Exposed onPlaybackStatusUpdate handler ──────────────────────────
  const handlePlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;

      const now = Date.now();
      const pos = status.positionMillis;

      // Track playback start time for grace period
      if (status.isPlaying && playbackStartTimeRef.current === 0) {
        playbackStartTimeRef.current = now;
      } else if (!status.isPlaying) {
        playbackStartTimeRef.current = 0;
      }

      // Detect buffering state changes (use ref to avoid stale closure)
      if (status.isBuffering && !isBufferingRef.current) {
        isBufferingRef.current = true;
        onLog({ type: "buffering_start", postId, positionMs: pos });
        setStallState((s) => ({ ...s, isBuffering: true }));
      } else if (!status.isBuffering && isBufferingRef.current) {
        isBufferingRef.current = false;
        onLog({ type: "buffering_end", postId, positionMs: pos });
        setStallState((s) => ({ ...s, isBuffering: false }));
      }

      // Stall detection: if playing and position hasn't changed.
      // Skip during grace period to avoid false positives during initial buffering.
      const inGracePeriod = playbackStartTimeRef.current > 0 && (now - playbackStartTimeRef.current) < STALL_GRACE_PERIOD_MS;

      if (status.isPlaying && !status.isBuffering && active && !inGracePeriod) {
        if (pos === lastPositionRef.current) {
          // Position frozen — start/continue stall timer
          if (!stallTimerRef.current) {
            lastPositionTimeRef.current = now;
            startStallTimer(pos, true);
          }
        } else {
          // Position advancing — reset stall timer
          lastPositionRef.current = pos;
          lastPositionTimeRef.current = now;
          clearStallTimer();
          startStallTimer(pos, true);
          // Reset recovery state since we're advancing
          if (recoveringRef.current) {
            if (retryCountRef.current > 0) {
              onLog({ type: "stall_recovered", postId, afterMs: 0 });
              retryCountRef.current = 0;
              recoveringRef.current = false;
              setStallState((s) => ({ ...s, recovering: false }));
            }
          }
        }
      } else {
        // Not playing or buffering or in grace period — clear stall timer
        clearStallTimer();
      }
    },
    [active, clearStallTimer, onLog, postId, sourceUri, startStallTimer],
  );

  // ── AppState listener: auto-recover when returning to foreground ──
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      onLog({ type: "app_state_change", postId, newState: nextState });
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev === "background" && nextState === "active" && active) {
        wasBackgroundedRef.current = true;
        // Returning from background — many native players are in a bad state.
        // Attempt recovery after a short delay for the native player to settle.
        const t = setTimeout(() => {
          if (!videoRef.current) return;
          onLog({ type: "stall_recovery_attempt", postId, attempt: 0, method: "app_foreground_resume" });
          videoRef.current
            .playAsync()
            .catch(() => {
              // If playAsync fails, try a full reload
              if (!videoRef.current) return;
              videoRef.current
                .unloadAsync()
                .then(() =>
                  videoRef.current!.loadAsync(
                    { uri: sourceUri },
                    { shouldPlay: true, isLooping: true },
                    false,
                  ),
                )
                .catch(() => {});
            });
        }, 300);
        return () => clearTimeout(t);
      }
    });

    return () => sub.remove();
  }, [active, onLog, postId, sourceUri]);

  // ── Reset when active toggles or source changes ─────────────────────
  useEffect(() => {
    retryCountRef.current = 0;
    recoveringRef.current = false;
    lastPositionRef.current = 0;
    lastPositionTimeRef.current = Date.now();
    playbackStartTimeRef.current = 0;
    isBufferingRef.current = false;
    clearStallTimer();
    setStallState({ isBuffering: false, stallCount: 0, lastStallPos: 0, recovering: false });
  }, [active, sourceUri, clearStallTimer, postId]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearStallTimer();
    };
  }, [clearStallTimer, postId]);

  return {
    videoRef,
    stallState,
    handlePlaybackStatus,
    attemptRecovery,
  };
}
