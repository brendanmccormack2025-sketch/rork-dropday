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
  /** True briefly after a camera flip during recording — keeps isRecording visually continuous */
  const cameraSwitchingRef = useRef<boolean>(false);
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
   *  During recording: flips the camera without stopping — the recording
   *  continues as a single continuous clip, same as Snapchat/Instagram.
   *  When idle: flips immediately. */
  const flipCamera = useCallback((): boolean => {
    // Toggle facing — CameraView handles the prop change at the native level.
    // If the platform supports mid-recording camera switch (iOS multi-cam,
    // Android CameraX), the flip is seamless. Otherwise the camera switches
    // on the next recording start.
    setFacing((f) => {
      const next = f === "back" ? "front" : "back";
      return next;
    });

    // Keep isRecording visually stable during the brief camera transition
    if (recordStateRef.current === "recording" || recordStateRef.current === "stopping") {
      cameraSwitchingRef.current = true;
      setTimeout(() => {
        cameraSwitchingRef.current = false;
      }, 400);
    }

    return true;
  }, []);

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

  /** Ensure recording is stopped — call on unmount or navigation. */
  const teardown = useCallback((): void => {
    safeStop();
  }, [safeStop]);

  /** Handle the CameraView.onCameraReady event */
  const handleCameraReady = useCallback((): void => {
    // No-op: camera ready tracking for potential future use
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
