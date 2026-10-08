import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

import { deleteAsync } from "@/lib/fileSystemCompat";
import { deleteLastRun, type CameraSegment } from "@/lib/cameraSegments";
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
/** A camera switch is given this long to settle (onCameraReady does not fire again on a facing change). */
const FLIP_SETTLE_MS = 700;
const FLIP_AFTER_SETTLE_MS = 120;
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

  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cameraMountError, setCameraMountError] = useState<string | null>(null);

  const [clips, setClips] = useState<Clip[]>([]);
  const clipsRef = useRef<Clip[]>([]);
  const [recordState, setRecordState] = useState<RecState>("idle");
  const recordStateRef = useRef<RecState>("idle");
  const [switching, setSwitching] = useState(false);
  const recordingStartedAtRef = useRef<number | null>(null);
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
        // expo-camera does not fire onCameraReady again on a facing change: wait for it if it does, else a fixed settle time.
        afterFlipSettled: async () => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, FLIP_SETTLE_MS);
            readyWaitersRef.current.push(() => {
              clearTimeout(t);
              resolve();
            });
          });
          await new Promise((r) => setTimeout(r, FLIP_AFTER_SETTLE_MS));
        },
        getSegments: () => clipsRef.current as CameraSegment[],
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
          if (s === "idle") recordingStartedAtRef.current = null;
        },
        onError: setError,
        onSwitching: setSwitching,
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

  const toggleTorch = useCallback(() => {
    haptic(Haptics.ImpactFeedbackStyle.Light);
    setTorch((t) => !t);
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

  return {
    cameraRef,
    facingRef,
    permission,
    requestPermission,
    micPermission,
    requestMicPermission,
    facing,
    facingLoaded,
    torch,
    toggleTorch,
    flipCamera,
    switching,
    recordState,
    recordStateRef,
    isRecording,
    handleCameraReady,
    isCameraReady,
    recordingStartedAtRef,
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
