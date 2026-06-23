import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import * as MediaLibrary from "expo-media-library";
import { cacheDirectory, documentDirectory, getInfoAsync } from "@/lib/fileSystemCompat";
import * as Haptics from "expo-haptics";
import { concatMP4Files } from "@/lib/concatMP4";

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
  /** Resolves when onCameraReady fires after a flip — avoids spin-waiting */
  const cameraReadyResolveRef = useRef<(() => void) | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [mediaPermission, requestMediaPermission] =
    MediaLibrary.usePermissions();

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
      console.log("[camera] blocked rapid transition, elapsed:", elapsed);
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
      console.log("[camera] safeStop skipped — camera is mid-flip, no active recording");
      return;
    }
    // If recordState is idle, there's nothing to stop.
    if (recordStateRef.current === "idle") {
      console.log("[camera] safeStop skipped — already idle");
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
      await MediaLibrary.saveToLibraryAsync(uri);
      console.log("[camera] saved to gallery:", uri.slice(0, 60));
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
      console.log("[camera] Cannot start recording — merge in progress");
      return;
    }

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
        console.log("[camera] Camera not ready — waiting for onCameraReady");
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
        console.log("[camera] Camera ready — starting recordAsync");
      }

      try {
        const result = await cam.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });

        if (result?.uri) {
          accumulatedSegmentUrisRef.current.push(result.uri);
          console.log(`[camera] recordAsync resolved — collected URI: ${result.uri.slice(0, 60)}`);

          // ── RAW RECORDING DIAGNOSTICS ──────────────────────────────
          // Verify the file is valid immediately after recordAsync returns,
          // BEFORE any processing (merge, export, upload) touches it.
          const rawInfo = await getInfoAsync(result.uri);
          console.log(`[camera] RAW FILE — path: ${result.uri}`);
          console.log(`[camera] RAW FILE — exists: ${rawInfo.exists}, size: ${rawInfo.exists ? (rawInfo.size ?? 0) : 'N/A'} bytes`);
        } else {
          // recordAsync resolved without a URI — the native session likely
          // wasn't fully ready.  Surface this as a visible error instead of
          // silently dropping the clip.
          console.warn("[camera] recordAsync resolved with NO URI — clip will be lost");
          setError("Recording could not be saved. Please try again.");
        }

        // When the camera flips mid-recording, the session rebuilds.
        // Wait for onCameraReady (via a promise, not spin-wait) before
        // calling recordAsync on the new camera.
        if (isFlippingRef.current) {
          console.log("[camera] Flip detected — session may have rebuilt");
          isFlippingRef.current = false;
          cameraSwitchingRef.current = false;

          // If the user already requested stop while we were flipping,
          // don't restart recording — just finalize and exit.
          if (stopRequestedRef.current) {
            console.log("[camera] Stop requested during flip — finalizing");
            keepRecording = false;
            break;
          }

          // Check if onCameraReady has ALREADY fired (the new session
          // finished building before recordAsync resolved). In that
          // case the camera is live right now — skip the wait.
          if (!cameraReadyRef.current) {
            console.log("[camera] Flip — waiting for camera to be ready");
            cameraReadyRef.current = false;

            // Resolve via onCameraReady (or timeout after 4 s)
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
                  }, 4000)
                ),
              ]);
            } catch {
              // Timeout — camera didn't come back
            }
            cameraReadyResolveRef.current = null;

            // Re-check stopRequested after the wait — user may have
            // tapped stop while we were waiting for onCameraReady.
            if (stopRequestedRef.current) {
              console.log("[camera] Stop requested during flip-wait — finalizing");
              keepRecording = false;
              break;
            }

            if (timedOut || !cameraReadyRef.current) {
              console.warn("[camera] Camera not ready after flip — aborting");
              setError("Camera failed to restart after flip.");
              keepRecording = false;
              break;
            }
          } else {
            console.log("[camera] Camera already ready — resuming immediately");
          }

          console.log("[camera] Camera ready — resuming recording");
          continue;
        }

        // Normal stop — user released or max duration reached
        keepRecording = false;
      } catch (e) {
        if (isFlippingRef.current) {
          console.log("[camera] Flip error detected — session may have rebuilt");
          isFlippingRef.current = false;
          cameraSwitchingRef.current = false;

          // If the user already requested stop, don't restart.
          if (stopRequestedRef.current) {
            console.log("[camera] Stop requested during flip error — finalizing");
            keepRecording = false;
            break;
          }

          // Check if onCameraReady has ALREADY fired (the new session
          // finished building before recordAsync threw). In that
          // case the camera is live right now — skip the wait.
          if (!cameraReadyRef.current) {
            console.log("[camera] Flip error — waiting for camera to be ready");
            cameraReadyRef.current = false;

            // Wait for onCameraReady (or timeout after 4 s)
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
                  }, 4000)
                ),
              ]);
            } catch {
              // Timeout
            }
            cameraReadyResolveRef.current = null;

            // Re-check after the wait.
            if (stopRequestedRef.current) {
              console.log("[camera] Stop requested during flip-error wait — finalizing");
              keepRecording = false;
              break;
            }

            if (timedOut || !cameraReadyRef.current) {
              console.warn("[camera] Camera not ready after flip — aborting");
              setError("Camera failed to restart after flip.");
              keepRecording = false;
              break;
            }
          } else {
            console.log("[camera] Camera already ready — resuming immediately");
          }

          console.log("[camera] Camera ready — resuming recording");
          continue;
        }
        if (recordStateRef.current !== "idle") {
          const msg = e instanceof Error ? e.message : "Recording failed.";
          setError(msg);
        }
        keepRecording = false;
      }
    }

    // IMMEDIATELY mark recording as finished so the REC indicator and
    // recording UI disappear BEFORE the merge/processing starts. The
    // merge overlay (isMerging) is the only thing the user should see
    // while we concatenate segments.
    console.log("[camera] RECORDING FINISHED");
    setRecordStateSync("idle");
    setIsLockedSync(false);

    // Finalize: merge all accumulated segments into ONE continuous video file.
    // This eliminates playback gaps in the editor and ensures the editor always
    // receives a single merged file — just like TikTok/Snapchat.
    const uris = accumulatedSegmentUrisRef.current;
    if (uris.length > 0) {
      const sessionId = recordSessionIdRef.current ?? undefined;
      console.log(`[camera] Finalize — ${uris.length} segment(s) to process`);

      try {
        let finalUri: string;
        if (uris.length === 1) {
          // Single segment — no merge needed
          finalUri = uris[0]!;
          console.log(`[camera] Single segment, no merge needed: ${finalUri.slice(0, 60)}`);

          // Verify the single segment file exists and has content
          const segInfo = await getInfoAsync(finalUri);
          console.log(
            `[camera] Segment file check — exists: ${segInfo.exists}, size: ${segInfo.exists ? (segInfo.size ?? 0) : 'N/A'} bytes`,
          );
          if (!segInfo.exists) {
            throw new Error("Recording file was not saved. Please try recording again.");
          }
          if ((segInfo.size ?? 0) === 0) {
            throw new Error("Recording file is empty (0 bytes). Please try recording again.");
          }
        } else {
          // Multiple segments (camera flips) — merge into one file
          setIsMergingSync(true);
          console.log(`[camera] Merging ${uris.length} segments into one video...`);

          const mergedUri = `${cacheDirectory || documentDirectory}merged_${Date.now()}.mp4`;
          finalUri = await concatMP4Files(uris, mergedUri);
          console.log(`[camera] Merge complete — output: ${finalUri.slice(0, 60)}`);
          setIsMergingSync(false);

          // Verify the merged output file exists and has content
          const mergedInfo = await getInfoAsync(finalUri);
          console.log(
            `[camera] Merged file check — exists: ${mergedInfo.exists}, size: ${mergedInfo.exists ? (mergedInfo.size ?? 0) : 'N/A'} bytes`,
          );
          if (!mergedInfo.exists) {
            throw new Error("Merged video file was not created. Please try recording again.");
          }
          if ((mergedInfo.size ?? 0) === 0) {
            throw new Error("Merged video file is empty (0 bytes). Please try recording again.");
          }
        }

        const clip: Clip = {
          id: newClipId(),
          uri: finalUri,
          type: "video",
          durationMs: undefined, // editor computes it from the merged file
          recordingSessionId: sessionId,
        };
        appendClip(clip);
        saveToGallery(finalUri);
        console.log(`[camera] Clip created — id: ${clip.id}, uri: ${finalUri.slice(0, 60)}`);
      } catch (mergeErr) {
        const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        console.error("[camera] Finalize failed:", errMsg, mergeErr);
        setIsMergingSync(false);

        // Fallback: create individual clips only if the error is from the merge step.
        // If the error is a file-not-found / empty-file validation error, do NOT
        // create clips — the underlying files are missing/corrupted.
        const isValidationError =
          errMsg.includes("not saved") ||
          errMsg.includes("empty (0 bytes)") ||
          errMsg.includes("not created");

        if (!isValidationError) {
          console.warn("[camera] Merge failed — falling back to individual clips");
          for (const uri of uris) {
            const clip: Clip = {
              id: newClipId(),
              uri,
              type: "video",
              durationMs: undefined,
              recordingSessionId: sessionId,
            };
            appendClip(clip);
            saveToGallery(uri).catch(() => {});
          }
          setError("Video merge failed. Clips are saved individually.");
        } else {
          setError(errMsg);
        }
      }
    }

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
      console.log("[camera] STOP RECORDING SKIPPED — not recording (state:", recordStateRef.current, ")");
      return;
    }
    console.log("[camera] STOP RECORDING");
    stopRequestedRef.current = true;
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
    try { cameraRef.current?.stopRecording(); } catch {}
  }, []);

  /** Handle the CameraView.onCameraReady event — signals the recording
   *  loop that the camera is ready to accept recordAsync. Also resolves
   *  any pending flip-wait promise so the loop wakes immediately. */
  const handleCameraReady = useCallback((): void => {
    cameraReadyRef.current = true;
    if (cameraReadyResolveRef.current) {
      cameraReadyResolveRef.current();
      cameraReadyResolveRef.current = null;
    }
    console.log("[camera] onCameraReady — session is live");
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
