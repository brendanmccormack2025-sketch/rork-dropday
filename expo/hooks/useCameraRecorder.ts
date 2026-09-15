import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import {
  saveToLibraryAsync,
  useMediaLibraryPermissions,
} from "@/lib/mediaLibraryCompat";
import { cacheDirectory, documentDirectory, getInfoAsync } from "@/lib/fileSystemCompat";
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
  // Single CameraView with dynamic facing prop.
  // The native session rebuilds when facing changes — the flip-flash
  // animation in camera.tsx covers the brief gap. The recording loop
  // waits for onCameraReady before calling recordAsync on the new camera.
  const cameraRef = useRef<CameraView>(null);
  /** True when the native camera session is ready for recording */
  const cameraReadyRef = useRef<boolean>(false);
  /** Reactive mirror of cameraReadyRef — lets the UI (flip cover overlay)
   *  react when the new camera session reports ready after a flip. */
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);
  /** Resolves when onCameraReady fires after a flip — avoids spin-waiting */
  const cameraReadyResolveRef = useRef<(() => void) | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [mediaPermission, requestMediaPermission] =
    useMediaLibraryPermissions();

  const [facing, setFacing] = useState<"back" | "front">("back");
  /** Stable ref mirror of `facing` — gesture & async callbacks read this, never the state */
  const facingRef = useRef<"back" | "front">("back");
  const [torch, setTorch] = useState<boolean>(false);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(0);
  const [isMerging, setIsMerging] = useState<boolean>(false);
  /** Synchronous ref mirror of isMerging — prevents starting a new recording during merge */
  const isMergingRef = useRef<boolean>(false);
  const setIsMergingSync = useCallback((val: boolean): void => {
    isMergingRef.current = val;
    setIsMerging(val);
  }, []);

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
  /** Set true when a flip happens mid-recording — tells the recordAsync loop to restart, not finalize */
  const isFlippingRef = useRef<boolean>(false);
  /** Set true by stopRecording() — the recording loop checks this after flip-wait before restarting */
  const stopRequestedRef = useRef<boolean>(false);
  /** Accumulates URIs from each segment of a multi-flip recording session */
  const accumulatedSegmentUrisRef = useRef<string[]>([]);
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

  // Keep facingRef in sync with the latest facing state
  useEffect(() => { facingRef.current = facing; }, [facing]);

  // Keep micPermissionRef in sync with the latest micPermission state
  micPermissionRef.current = micPermission;

  /** Return the single CameraView ref. Always uses facingRef.current so
   *  async loops read the live value after a facing change. */
  const getActiveCamera = useCallback((): CameraView | null => {
    return cameraRef.current;
  }, []);

  /** Guard against rapid state transitions */
  const canTransition = useCallback((): boolean => {
    const elapsed = Date.now() - lastTransitionRef.current;
    if (elapsed < MIN_STATE_MS) {
      console.warn("[camera] blocked rapid transition, elapsed:", elapsed);
      return false;
    }
    lastTransitionRef.current = Date.now();
    return true;
  }, []);

  /** Toggle front/back camera.
   *  When idle: just swaps facing immediately.
   *  During recording: sets the flip flag so the recording loop restarts
   *  on the new camera. Does NOT call stopRecording() — expo-camera
   *  handles the session rebuild internally when facing changes.
   *  recordAsync will resolve/reject naturally; the loop catches it. */
  const flipCamera = useCallback((): boolean => {
    const recording = recordStateRef.current === "recording" || recordStateRef.current === "stopping";

    if (recording) {
      // Signal the recording loop to restart after facing rebuild.
      // We do NOT stop the recording ourselves — expo-camera tears
      // down the old session and builds a new one when facing changes,
      // which causes recordAsync to resolve/reject. Stopping manually
      // races with that teardown and can crash the session.
      isFlippingRef.current = true;
      cameraSwitchingRef.current = true;
    }

    // CRITICAL: Do NOT set cameraReadyRef to false here. expo-camera's
    // onCameraReady only fires ONCE on initial mount. When facing changes,
    // the session reconfigures but onCameraReady is NOT re-dispatched.
    // Setting ready=false creates a permanent "not ready" state.

    // Swap facing — CameraView re-renders with the new prop.
    const next = facingRef.current === "back" ? "front" : "back";
    facingRef.current = next;
    setFacing(next);

    return true;
  }, []);

  /** Toggle torch */
  const toggleTorch = useCallback(() => {
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    setTorch((t) => !t);
  }, []);

  /** Safely stop the currently active camera recording.
   *  Only calls native stopRecording() when the camera is actually in a
   *  recording state — calling it mid-flip (session rebuild in progress)
   *  crashes the native camera process and kills the entire app. */
  const safeStop = useCallback((): void => {
    // If we're mid-flip, the old session is already torn down and the
    // new session hasn't started recording yet. Calling native
    // stopRecording() at this point crashes the camera process.
    if (isFlippingRef.current) {
      return;
    }
    // If recordState is idle, there's nothing to stop.
    if (recordStateRef.current === "idle") {
      return;
    }
    try {
      getActiveCamera()?.stopRecording();
    } catch {
      // Swallow — recording may already be stopped
    }
  }, [getActiveCamera]);

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
      const _saveStart = Date.now();
      await saveToLibraryAsync(uri);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown save error";
      console.warn("[camera] gallery save failed:", msg);
    }
  }, [mediaPermission?.granted, requestMediaPermission]);

  /** Start a single continuous recording up to MAX_VIDEO_SECONDS.
   *  Uses a loop so that camera flips mid-recording auto-restart on the
   *  new (pre-warmed) camera instead of ending the clip. Only user
   *  release or max duration stops the loop. */
  const startRecording = useCallback(async (): Promise<void> => {
    const activeCam = getActiveCamera();
    if (!activeCam) return;
    if (recordStateRef.current !== "idle") return;
    if (!canTransition()) return;
    if (isMergingRef.current) {
      console.warn("[camera] Cannot start recording — merge in progress");
      return;
    }

    const currentMic = micPermissionRef.current;
    if (!currentMic?.granted) {
      const res = await requestMicPermission();
      if (!res.granted) {
        // iOS: once denied, requestMicPermission() no-ops. Give the user
        // an actual path forward via Settings instead of a dead-end error.
        Alert.alert(
          "Microphone Access",
          "DropDay needs microphone access to record video with sound. You can grant this in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                if (Platform.OS === "ios") {
                  Linking.openURL("app-settings:");
                } else {
                  Linking.openSettings();
                }
              },
            },
          ],
        );
        setError("Microphone permission is required to record video with sound.");
        return;
      }
    }

    setRecordStateSync("recording");
    setError(null);
    isFlippingRef.current = false;
    stopRequestedRef.current = false;
    recordSessionIdRef.current = `rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    recordingStartedAtRef.current = Date.now();
    accumulatedSegmentUrisRef.current = [];
    triggerHaptic(Haptics.ImpactFeedbackStyle.Heavy);

    // Recording loop — restarts on camera flip, exits on user stop or max duration.
    // Each iteration calls recordAsync on the CURRENTLY active camera (via
    // getActiveCamera() which reads facingRef.current updated by flipCamera).
    let keepRecording = true;
    while (keepRecording) {
      const cam = getActiveCamera();
      if (!cam) {
        // Camera ref not attached yet — brief wait then retry
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      // Wait for the native camera session to be ready before calling
      // recordAsync.  After a previous recording finishes the native
      // session may briefly need time to reset.  Calling recordAsync
      // on an unready session can resolve with a null URI — producing
      // a "phantom" recording that never appears in the timeline.
      if (!cameraReadyRef.current) {
        let timedOut = false;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              cameraReadyResolveRef.current = resolve;
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => {
                timedOut = true;
                reject(new Error("timeout"));
              }, 2000)
            ),
          ]);
        } catch {
          // Timeout — camera didn't come back
        }
        cameraReadyResolveRef.current = null;
        if (timedOut || !cameraReadyRef.current) {
          console.warn("[camera] Camera not ready before recordAsync — aborting");
          setError("Camera not ready. Please try again.");
          keepRecording = false;
          break;
        }
      }

      try {
        const result = await cam.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });

        if (result?.uri) {
          accumulatedSegmentUrisRef.current.push(result.uri);
          // File validation is deferred to the finalize phase to avoid
          // blocking the recording loop at every flip boundary.
        } else {
          // recordAsync resolved without a URI — the native session likely
          // wasn't fully ready.  Surface this as a visible error instead of
          // silently dropping the clip.
          console.warn("[camera] recordAsync resolved with NO URI — clip will be lost");
          setError("Recording could not be saved. Please try again.");
        }

        // When the camera flips mid-recording, the session rebuilds.
        // onCameraReady does NOT re-fire on facing change (expo-camera only
        // dispatches it once on initial mount). So we wait a brief fixed
        // delay for the native session to settle after the device swap,
        // then resume recording on the new camera.
        if (isFlippingRef.current) {
          isFlippingRef.current = false;
          cameraSwitchingRef.current = false;

          // If the user already requested stop while we were flipping,
          // don't restart recording — just finalize and exit.
          if (stopRequestedRef.current) {
            keepRecording = false;
            break;
          }

          // Brief delay for the native session to finish swapping devices.
          // sessionManager.updateDevice() runs on a serial queue — this
          // gives it time to complete without depending on onCameraReady
          // (which won't fire). 150ms is sufficient on most devices; the
          // swap typically completes in 50-100ms.
          await new Promise((r) => setTimeout(r, 150));

          // Re-check stopRequested after the wait — user may have
          // tapped stop while we were waiting.
          if (stopRequestedRef.current) {
            keepRecording = false;
            break;
          }

          continue;
        }

        // Normal stop — user released or max duration reached
        keepRecording = false;
      } catch (e) {
        if (isFlippingRef.current) {
          isFlippingRef.current = false;
          cameraSwitchingRef.current = false;

          // If the user already requested stop, don't restart.
          if (stopRequestedRef.current) {
            keepRecording = false;
            break;
          }

          // Brief delay for the native session to settle after the device swap.
          // Same as the success path — onCameraReady won't re-fire.
          await new Promise((r) => setTimeout(r, 150));

          // Re-check after the wait.
          if (stopRequestedRef.current) {
            keepRecording = false;
            break;
          }

          continue;
        }
        if (recordStateRef.current !== "idle") {
          console.error("[camera] recordAsync threw — error object:", e);
          const msg = e instanceof Error ? e.message : "Recording failed.";
          setError(msg);
        }
        keepRecording = false;
      }
    }

    setIsLockedSync(false);

    // Append clips IMMEDIATELY — no getInfoAsync validation here.
    // The files were just written by recordAsync; if we got a URI, the file
    // exists. The redundant getInfoAsync check that used to run here created
    // a 100-250ms gap where the UI showed a bare idle camera screen (no REC
    // indicator, no Next button, no merge overlay) — a visible black flash.
    // goToEdit() already validates all files before navigating, so the
    // check here was purely defensive and not worth the UI regression.
    const uris = accumulatedSegmentUrisRef.current;
    if (uris.length > 0) {
      const sessionId = recordSessionIdRef.current ?? undefined;
      for (const uri of uris) {
        const clip: Clip = {
          id: newClipId(),
          uri,
          type: "video",
          durationMs: undefined, // editor computes it per clip
          recordingSessionId: sessionId,
        };
        appendClip(clip);
        // Save each segment to the gallery — fire-and-forget, never blocks UI.
        saveToGallery(uri).catch(() => {});
      }
    }

    // NOW mark recording as idle — after clips are appended so the Next
    // button appears in the same frame the REC indicator disappears.
    setRecordStateSync("idle");

    recordingStartedAtRef.current = null;
    recordSessionIdRef.current = null;
    // Reset transition guard to allow back-to-back recordings.
    // The 260ms long-press timer provides most of the natural delay;
    // we give a 300ms credit so the MIN_STATE_MS guard passes as soon
    // as the timer fires, while still blocking sub-100ms re-triggers
    // that could race the native session reset.
    lastTransitionRef.current = Date.now() - 300;
  }, [requestMicPermission, canTransition, appendClip, saveToGallery, setError, setRecordStateSync, setIsLockedSync]);

  /** Stop the current recording. Safe to call at any time.
   *  Sets stopRequestedRef so the recording loop won't restart after a flip. */
  const stopRecording = useCallback((): void => {
    if (recordStateRef.current !== "recording" && recordStateRef.current !== "stopping") {
      return;
    }
    stopRequestedRef.current = true;
    setRecordStateSync("stopping");
    safeStop();
  }, [safeStop]);

  /** Lock recording (hands-free) */
  const lockRecording = useCallback((): void => {
    if (recordStateRef.current !== "recording") return;
    setIsLockedSync(true);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Heavy);
  }, []);

  /** Take a photo from the currently active camera */
  const takePicture = useCallback(async (): Promise<void> => {
    const cam = getActiveCamera();
    if (!cam) return;
    if (recordStateRef.current !== "idle") return;
    if (!canTransition()) return;

    try {
      triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
      const photo = await cam.takePictureAsync({
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
  }, [canTransition, appendClip, getActiveCamera]);

  /** Clear clip list (e.g., after navigating away) */
  const clearClips = useCallback((): void => {
    setClips([]);
    setError(null);
  }, []);

  /** Ensure recording is stopped — call on unmount or navigation. */
  const teardown = useCallback((): void => {
    cameraReadyRef.current = false;
    setIsCameraReady(false);
    try { cameraRef.current?.stopRecording(); } catch {}
  }, []);

  /** Handle the CameraView.onCameraReady event — signals the recording
   *  loop that the camera is ready to accept recordAsync. Also resolves
   *  any pending flip-wait promise so the loop wakes immediately. */
  const handleCameraReady = useCallback((): void => {
    cameraReadyRef.current = true;
    setIsCameraReady(true);
    if (cameraReadyResolveRef.current) {
      cameraReadyResolveRef.current();
      cameraReadyResolveRef.current = null;
    }
  }, []);

  /** Handle CameraView.onMountError — capture and display camera failures */
  const [cameraMountError, setCameraMountError] = useState<string | null>(null);
  const handleMountError = useCallback((event: { message: string }) => {
    const msg = event?.message ?? "Camera failed to start.";
    console.error("[camera] onMountError:", msg);
    setCameraMountError(msg);
  }, []);

  /** Synchronous recording check — use the ref for gesture handlers, not the derived boolean.
   *  Stays true during camera flip transition so the recording indicator never flickers.
   *  NOTE: cameraSwitchingRef is now set in flipCamera and cleared by the recordAsync loop
   *  on restart, rather than via a setTimeout — no stale flags that outlive the flip. */
  const isRecording =
    recordState === "recording" ||
    recordState === "stopping" ||
    isFlippingRef.current ||
    cameraSwitchingRef.current;
  const recordingElapsedMs =
    recordingStartedAtRef.current != null
      ? Date.now() - recordingStartedAtRef.current
      : 0;

  return {
    // Camera ref — single dynamic-facing CameraView
    cameraRef,
    facingRef,
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
    stopRequestedRef,
    isRecording,
    cameraSwitchingRef,
    handleCameraReady,
    isCameraReady,
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
    // Merge state
    isMerging,
    isMergingRef,
    // Error
    error,
    setError,
    cameraMountError,
    setCameraMountError,
    handleMountError,
    // Lifecycle
    teardown,
  } as const;
}
