import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import * as MediaLibrary from "expo-media-library";
import * as Haptics from "expo-haptics";

export type Clip = {
  id: string;
  uri: string;
  type: "image" | "video";
  durationMs?: number;
  draftId?: string;
  recordingSessionId?: string;
};

/** Prevent rapid-fire start/stop causing corrupted recordings */
const MIN_STATE_MS = 400;

/** Maximum recording duration in seconds — one continuous take, no segment splitting */
export const MAX_VIDEO_SECONDS = 300;

type RecordState = "idle" | "recording" | "stopping";

/** Generate a unique clip ID */
const newClipId = (): string =>
  `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function triggerHaptic(style: Haptics.ImpactFeedbackStyle): void {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(style).catch(() => {});
  }
}

export function useCameraRecorder() {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [mediaPermission, requestMediaPermission] =
    MediaLibrary.usePermissions();

  const [facing, setFacing] = useState<"back" | "front">("back");
  const [torch, setTorch] = useState<boolean>(false);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(0);

  // ─── Synchronous refs — the TRUE single source of truth for gesture handlers ───
  // State setters below always update BOTH the ref AND the React state atomically.
  // Never call setRecordState / setIsLocked directly — use the helpers below.
  const recordStateRef = useRef<RecordState>("idle");
  const isLockedRef = useRef<boolean>(false);
  const lastTransitionRef = useRef<number>(0);
  const recordSessionIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const shouldAutoRestartRef = useRef<boolean>(false);
  /** True during the entire flip+restart window — keeps isRecording visually continuous */
  const cameraSwitchingRef = useRef<boolean>(false);
  /** Callback set by the auto-restart effect, invoked by CameraView.onCameraReady */
  const onCameraReadyCallbackRef = useRef<(() => void) | null>(null);
  /** Stable ref mirror of micPermission — gesture callbacks read this, never the state */
  const micPermissionRef = useRef(micPermission);

  /** Synchronously set recordState AND the ref — zero gap, gesture-safe */
  const setRecordStateSync = useCallback((next: RecordState): void => {
    recordStateRef.current = next;
    setRecordState(next);
  }, []);

  /** Synchronously set isLocked AND the ref */
  const setIsLockedSync = useCallback((next: boolean): void => {
    isLockedRef.current = next;
    setIsLocked(next);
  }, []);

  // Keep micPermissionRef in sync with the latest micPermission state
  micPermissionRef.current = micPermission;

  /** Guard against rapid state transitions */
  const canTransition = useCallback((): boolean => {
    const elapsed = Date.now() - lastTransitionRef.current;
    if (elapsed < MIN_STATE_MS) {
      console.log("[camera] blocked rapid transition, elapsed:", elapsed);
      return false;
    }
    lastTransitionRef.current = Date.now();
    return true;
  }, []);

  /** Toggle front/back camera.
   *  During recording: stops the current clip (saved), flags for auto-restart
   *  after the recording finalizes, then flips + resumes. Returns true when the
   *  flip was initiated (or deferred via auto-restart). Returns false when
   *  blocked (auto-restart already pending). */
  const flipCamera = useCallback((): boolean => {
    // Guard: don't allow flip while auto-restart is already pending
    if (shouldAutoRestartRef.current) {
      console.log("[camera] SWITCH CAMERA — blocked, auto-restart pending");
      return false;
    }

    console.log("[camera] SWITCH CAMERA CALLED (state:", recordStateRef.current, ")");

    if (recordStateRef.current === "recording" || recordStateRef.current === "stopping") {
      // Mid-recording: stop to save the clip, then flip + restart after finalization.
      // Set the switching flag immediately so isRecording stays true visually.
      console.log("[camera] SWITCH CAMERA — mid-recording, stopping to save clip");
      shouldAutoRestartRef.current = true;
      cameraSwitchingRef.current = true;
      // Use safeStop directly (via ref) to avoid dependency on stopRecording which is declared later
      try {
        cameraRef.current?.stopRecording();
      } catch {
        // Swallow — recording may already be stopped
      }
      setRecordStateSync("stopping");
      return true;
    }

    // Not recording: flip immediately
    setFacing((f) => {
      const next = f === "back" ? "front" : "back";
      console.log("[camera] SWITCH CAMERA EXECUTED —", f, "→", next);
      return next;
    });
    return true;
  }, [setRecordStateSync]);

  /** Toggle torch */
  const toggleTorch = useCallback(() => {
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    setTorch((t) => !t);
  }, []);

  /** Safely stop the camera recording */
  const safeStop = useCallback((): void => {
    try {
      cameraRef.current?.stopRecording();
    } catch {
      // Swallow — recording may already be stopped
    }
  }, []);

  /** Append a clip to the session */
  const appendClip = useCallback((clip: Clip) => {
    setClips((prev) => [...prev, clip]);
  }, []);

  /** Save a video to the device gallery */
  const saveToGallery = useCallback(async (uri: string): Promise<void> => {
    try {
      if (!mediaPermission?.granted) {
        const result = await requestMediaPermission();
        if (!result.granted) return;
      }
      await MediaLibrary.saveToLibraryAsync(uri);
      console.log("[camera] saved to gallery:", uri.slice(0, 60));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown save error";
      console.warn("[camera] gallery save failed:", msg);
    }
  }, [mediaPermission?.granted, requestMediaPermission]);

  /** Start a single continuous recording up to MAX_VIDEO_SECONDS.
   *  isRecording stays true the entire time; the ring animation reads
   *  recordingStartedAtRef.current live for smooth progress. Call
   *  stopRecording() to end the recording early. */
  const startRecording = useCallback(async (): Promise<void> => {
    if (!cameraRef.current) return;
    if (recordStateRef.current !== "idle") return;
    if (!canTransition()) return;

    // Ensure microphone permission — read from the stable ref, not reactive state,
    // so that this callback never becomes stale when micPermission changes.
    const currentMic = micPermissionRef.current;
    if (!currentMic?.granted) {
      console.log("[camera] Requesting microphone permission...");
      const res = await requestMicPermission();
      if (!res.granted) {
        setError("Microphone permission is required to record video.");
        return;
      }
      console.log("[camera] Microphone permission granted");
    }

    console.log("[camera] START RECORDING");
    setRecordStateSync("recording");
    setError(null);
    recordSessionIdRef.current = `rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    recordingStartedAtRef.current = Date.now();
    triggerHaptic(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const result = await cameraRef.current.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });

      if (result?.uri) {
        const dur = Date.now() - (recordingStartedAtRef.current ?? Date.now());
        const clip: Clip = {
          id: newClipId(),
          uri: result.uri,
          type: "video",
          durationMs: dur,
          recordingSessionId: recordSessionIdRef.current ?? undefined,
        };
        appendClip(clip);
        saveToGallery(result.uri);
      }
    } catch (e) {
      if (recordStateRef.current !== "idle") {
        const msg = e instanceof Error ? e.message : "Recording failed.";
        setError(msg);
      }
    }

    console.log("[camera] RECORDING FINISHED");
    setRecordStateSync("idle");
    setIsLockedSync(false);
    recordingStartedAtRef.current = null;
    recordSessionIdRef.current = null;
    // Reset transition guard so the user can immediately record again
    lastTransitionRef.current = 0;
  }, [requestMicPermission, canTransition, appendClip, saveToGallery, setError, setRecordStateSync, setIsLockedSync]);

  /** Stop the current recording. Safe to call at any time. */
  const stopRecording = useCallback((): void => {
    if (recordStateRef.current !== "recording" && recordStateRef.current !== "stopping") {
      console.log("[camera] STOP RECORDING SKIPPED — not recording (state:", recordStateRef.current, ")");
      return;
    }
    console.log("[camera] STOP RECORDING");
    setRecordStateSync("stopping");
    safeStop();
  }, [safeStop]);

  /** Lock recording (hands-free) */
  const lockRecording = useCallback((): void => {
    if (recordStateRef.current !== "recording") return;
    console.log("[camera] LOCK RECORDING");
    setIsLockedSync(true);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Heavy);
  }, []);

  /** Take a photo */
  const takePicture = useCallback(async (): Promise<void> => {
    if (!cameraRef.current) return;
    if (recordStateRef.current !== "idle") return;
    if (!canTransition()) return;

    try {
      triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: false,
      });
      if (photo?.uri) {
        appendClip({
          id: newClipId(),
          uri: photo.uri,
          type: "image",
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not take photo.";
      setError(msg);
    } finally {
      lastTransitionRef.current = Date.now();
    }
  }, [canTransition, appendClip]);

  /** Clear clip list (e.g., after navigating away) */
  const clearClips = useCallback((): void => {
    setClips([]);
    setError(null);
  }, []);

  /** Ensure recording is stopped — call on unmount or navigation.
   *  Sets flags so the while-loop breaks naturally; does NOT force state
   *  to idle (the loop's cleanup block handles that). */
  const teardown = useCallback((): void => {
    shouldAutoRestartRef.current = false;
    safeStop();
  }, [safeStop]);

  // ─── Auto-restart recording after mid-recording camera flip ─────
  // When shouldAutoRestartRef is set (by flipCamera during recording),
  // this effect waits for the recording to finalize (state → "idle"),
  // then flips the camera. Instead of a blind timeout, it registers a
  // callback on onCameraReadyCallbackRef that fires as soon as the
  // CameraView's native AVCaptureSession is ready — typically 100–300ms.
  // Falls back to a 1000ms safety timeout if onCameraReady never fires.
  useEffect(() => {
    if (!shouldAutoRestartRef.current) return;
    if (recordState !== "idle") return;

    console.log("[camera] AUTO-RESTART: recording finalized, flipping camera");

    // Clear canTransition's MIN_STATE_MS guard manually so startRecording
    // can fire immediately without the 400ms cooldown.
    lastTransitionRef.current = 0;

    setFacing((f) => {
      const next = f === "back" ? "front" : "back";
      console.log("[camera] AUTO-RESTART FLIP —", f, "→", next);
      return next;
    });

    // Register the restart callback — CameraView.onCameraReady will fire it.
    // Fallback timeout in case onCameraReady never fires (e.g. web or buggy native).
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    onCameraReadyCallbackRef.current = () => {
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      console.log("[camera] AUTO-RESTART: camera ready, starting new recording");
      shouldAutoRestartRef.current = false;
      cameraSwitchingRef.current = false;
      startRecording();
    };

    fallbackTimer = setTimeout(() => {
      if (onCameraReadyCallbackRef.current) {
        console.log("[camera] AUTO-RESTART: fallback timeout — starting recording anyway");
        const cb = onCameraReadyCallbackRef.current;
        onCameraReadyCallbackRef.current = null;
        shouldAutoRestartRef.current = false;
        cameraSwitchingRef.current = false;
        cb();
      }
    }, 1000);

    return () => {
      shouldAutoRestartRef.current = false;
      cameraSwitchingRef.current = false;
      onCameraReadyCallbackRef.current = null;
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [recordState, startRecording]);

  /** Handle the CameraView.onCameraReady event — fires the pending auto-restart callback */
  const handleCameraReady = useCallback((): void => {
    if (onCameraReadyCallbackRef.current) {
      console.log("[camera] onCameraReady fired — executing pending auto-restart");
      const cb = onCameraReadyCallbackRef.current;
      onCameraReadyCallbackRef.current = null;
      cb();
    }
  }, []);

  /** Synchronous recording check — use the ref for gesture handlers, not the derived boolean.
   *  Stays true during camera flip transition so the recording indicator never flickers. */
  const isRecording =
    recordState === "recording" ||
    recordState === "stopping" ||
    cameraSwitchingRef.current;
  const recordingElapsedMs =
    recordingStartedAtRef.current != null
      ? Date.now() - recordingStartedAtRef.current
      : 0;

  return {
    // Camera ref
    cameraRef,
    // Permissions
    permission,
    requestPermission,
    micPermission,
    requestMicPermission,
    // Camera state
    facing,
    setFacing,
    torch,
    toggleTorch,
    flipCamera,
    // Recording — synchronous refs for gesture handlers
    recordState,
    recordStateRef,
    isRecording,
    cameraSwitchingRef,
    handleCameraReady,
    isLocked,
    isLockedRef,
    recordingStartedAtRef,
    recordingElapsedMs,
    startRecording,
    stopRecording,
    lockRecording,
    takePicture,
    // Clips
    clips,
    clearClips,
    // Zoom
    zoom,
    setZoom,
    // Error
    error,
    setError,
    // Lifecycle
    teardown,
  } as const;
}
