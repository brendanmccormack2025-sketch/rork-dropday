import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

import { deleteAsync } from "@/lib/fileSystemCompat";
import { recordClientError } from "@/lib/clientErrors";
import { deleteLastRun, type CameraSegment } from "@/lib/cameraSegments";
import { flashMode } from "@/lib/cameraFlash";
import { RecordingController, type RecState } from "@/lib/recordingController";

export type Clip = {
  id: string;
  uri: string;
  type: "image" | "video";
  durationMs?: number;
  draftId?: string;
  /** The segment (tap to start -> tap to stop) this clip is. */
  recordingSessionId?: string;
  /** How long the recorder ran for this file (ms, measured on the phone's clock; the editor measures the real length). */
  measuredMs?: number;
};

/** Longest video the camera roll accepts (seconds). The camera itself records at most 60 s (lib/cameraSegments). */
export const MAX_VIDEO_SECONDS = 300;

/** The camera used last time (default: front). */
const FACING_KEY = "trial:cameraFacing";
/**
 * Device data: onCameraReady never fires after a facing change, and the camera is ready well before 450 ms. So the
 * first try at the next recording is made after this short delay (earlier if onCameraReady does fire); if the camera
 * refuses, the controller retries every 50 ms.
 */
const FLIP_FIRST_TRY_MS = 150;
const READY_TIMEOUT_MS = 2000;

const newId = (): string => `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function haptic(style: Haptics.ImpactFeedbackStyle): void {
  if (Platform.OS !== "web") Haptics.impactAsync(style).catch(() => {});
}

export function useCameraRecorder() {
  // One CameraView, always mounted. Flipping only changes its `facing` prop.
  const cameraRef = useRef<CameraView>(null);
  const cameraReadyRef = useRef(false);
  const readyWaitersRef = useRef<Array<() => void>>([]);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const micPermissionRef = useRef(micPermission);
  micPermissionRef.current = micPermission;

  // The last used camera (default front). The camera view waits for it, so it never opens on the wrong one.
  const [facing, setFacingState] = useState<"back" | "front">("front");
  const [facingLoaded, setFacingLoaded] = useState(false);
  const facingRef = useRef<"back" | "front">("front");
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(FACING_KEY)
      .then((v) => {
        if (cancelled) return;
        if (v === "back" || v === "front") {
          facingRef.current = v;
          setFacingState(v);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFacingLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const setFacing = useCallback((next: "back" | "front") => {
    facingRef.current = next;
    setFacingState(next);
    AsyncStorage.setItem(FACING_KEY, next).catch(() => {});
  }, []);

  // One flash switch for both cameras: it survives flips (also mid-recording); the camera decides what it does.
  const [flashOn, setFlashOn] = useState(false);
  const flash = flashMode(facing, flashOn);
  const [zoom, setZoom] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cameraMountError, setCameraMountError] = useState<string | null>(null);

  const [clips, setClips] = useState<Clip[]>([]);
  const clipsRef = useRef<Clip[]>([]);
  const [recordState, setRecordState] = useState<RecState>("idle");
  const recordStateRef = useRef<RecState>("idle");
  const [switching, setSwitching] = useState(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  /** The take in progress (tap to start -> tap to stop, flips included): when it began and its id. */
  const takeRef = useRef<{ id: string; startedAt: number } | null>(null);
  const startingRef = useRef(false);

  const handleCameraReady = useCallback((): void => {
    cameraReadyRef.current = true;
    setIsCameraReady(true);
    const waiters = readyWaitersRef.current;
    readyWaitersRef.current = [];
    waiters.forEach((w) => w());
  }, []);

  const handleMountError = useCallback((event: { message: string }) => {
    const msg = event?.message ?? "Camera failed to start.";
    console.error("[camera] onMountError:", msg);
    setCameraMountError(msg);
  }, []);

  const controller = useMemo(
    () =>
      new RecordingController({
        record: async (maxDuration) => {
          const cam = cameraRef.current;
          if (!cam) return null;
          return cam.recordAsync({ maxDuration });
        },
        stopNative: () => {
          try {
            cameraRef.current?.stopRecording();
          } catch {
            // already stopped
          }
        },
        ensureReady: async () => {
          if (cameraReadyRef.current && cameraRef.current) return true;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, READY_TIMEOUT_MS);
            readyWaitersRef.current.push(() => {
              clearTimeout(t);
              resolve();
            });
          });
          return cameraReadyRef.current && !!cameraRef.current;
        },
        switchFacing: () => setFacing(facingRef.current === "back" ? "front" : "back"),
        // onCameraReady as an early trigger if it ever fires; otherwise the first try after FLIP_FIRST_TRY_MS.
        afterFlipSettled: () =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, FLIP_FIRST_TRY_MS);
            readyWaitersRef.current.push(() => {
              clearTimeout(t);
              resolve();
            });
          }),
        getSegments: () => clipsRef.current as CameraSegment[],
        discardFile: (uri) => {
          deleteAsync(uri, { idempotent: true }).catch(() => {});
        },
        onSegment: (seg) => {
          const clip: Clip = { id: seg.id, uri: seg.uri, type: "video", recordingSessionId: seg.runId, measuredMs: seg.measuredMs };
          clipsRef.current = [...clipsRef.current, clip];
          setClips(clipsRef.current);
        },
        onState: (s) => {
          if (s === "recording" && recordStateRef.current === "idle") haptic(Haptics.ImpactFeedbackStyle.Medium);
          if (s === "stopping" && recordStateRef.current === "recording") haptic(Haptics.ImpactFeedbackStyle.Medium);
          recordStateRef.current = s;
          setRecordState(s);
          if (s === "idle") {
            recordingStartedAtRef.current = null;
            takeRef.current = null;
          }
        },
        onError: setError,
        onSwitching: setSwitching,
        onTakeStart: (id, startedAt) => {
          takeRef.current = { id, startedAt };
        },
        // How long the flip handoff really took, so the numbers can be read in dev and from client_errors.
        onFlipGap: (gapMs, info) => {
          if (__DEV__) console.log(`[camera] flip gap ${Math.round(gapMs)} ms (retries ${info.retries})`);
          void recordClientError(new Error("camera flip gap"), { kind: "flipGap", gapMs: Math.round(gapMs), retries: info.retries, facing: facingRef.current });
        },
        onRunStart: (t) => {
          recordingStartedAtRef.current = t;
        },
        now: () => Date.now(),
        newId,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
    [setFacing],
  );

  /** Tap on the record button: start a segment, or stop the one in progress. Ignored while stopping. */
  const toggleRecording = useCallback(async (): Promise<void> => {
    if (recordStateRef.current !== "idle") {
      controller.toggle();
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      if (!micPermissionRef.current?.granted) {
        const res = await requestMicPermission();
        if (!res.granted) {
          Alert.alert(
            "Microphone Access",
            "Trial needs microphone access to record video with sound. You can grant this in Settings.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => (Platform.OS === "ios" ? Linking.openURL("app-settings:") : Linking.openSettings()) },
            ],
          );
          setError("Microphone permission is required to record video with sound.");
          return;
        }
      }
      controller.toggle();
    } finally {
      startingRef.current = false;
    }
  }, [controller, requestMicPermission]);

  /** Flip the camera (while recording: ends the segment, flips, starts a new one when ready). */
  const flipCamera = useCallback((): boolean => {
    const did = controller.flip();
    if (did) setZoom(0);
    return did;
  }, [controller]);

  const toggleFlash = useCallback(() => {
    haptic(Haptics.ImpactFeedbackStyle.Light);
    setFlashOn((on) => !on);
  }, []);

  /** "Delete last": the most recent segment (and its file) goes. Not while recording. Repeatable. */
  const deleteLastClip = useCallback((): void => {
    if (recordStateRef.current !== "idle") return;
    const { kept, removed } = deleteLastRun(clipsRef.current);
    if (removed.length === 0) return;
    clipsRef.current = kept;
    setClips(kept);
    setError(null);
    for (const c of removed) deleteAsync(c.uri, { idempotent: true }).catch(() => {});
  }, []);

  const clearClips = useCallback((): void => {
    clipsRef.current = [];
    setClips([]);
    setError(null);
  }, []);

  /** Stop any recording on unmount or navigation. */
  const teardown = useCallback((): void => {
    cameraReadyRef.current = false;
    setIsCameraReady(false);
    try {
      cameraRef.current?.stopRecording();
    } catch {
      // nothing to stop
    }
  }, []);

  const isRecording = recordState !== "idle";

  /**
   * How long the take in progress has run (ms), flips included: wall clock since the tap, minus what its finished
   * segments already count for. The progress bar uses it, so it keeps advancing through a flip.
   */
  const takeLiveMs = useCallback((): number => {
    const take = takeRef.current;
    if (!take) return 0;
    const done = clipsRef.current.filter((c) => c.recordingSessionId === take.id).reduce((n, c) => n + (c.measuredMs ?? 0), 0);
    return Math.max(0, Date.now() - take.startedAt - done);
  }, []);

  return {
    cameraRef,
    facingRef,
    permission,
    requestPermission,
    micPermission,
    requestMicPermission,
    facing,
    facingLoaded,
    flashOn,
    flash,
    toggleFlash,
    flipCamera,
    switching,
    recordState,
    recordStateRef,
    isRecording,
    handleCameraReady,
    isCameraReady,
    recordingStartedAtRef,
    takeLiveMs,
    takeRef,
    toggleRecording,
    clips,
    clearClips,
    deleteLastClip,
    zoom,
    setZoom,
    error,
    setError,
    cameraMountError,
    setCameraMountError,
    handleMountError,
    teardown,
  } as const;
}
