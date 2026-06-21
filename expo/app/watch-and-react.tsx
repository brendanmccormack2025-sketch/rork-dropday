import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Video,
  ResizeMode,
  type AVPlaybackStatus,
  type AVPlaybackStatusSuccess,
} from "expo-av";
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import Svg, { Circle as SvgCircle } from "react-native-svg";
import { ArrowLeft, Play, Pause, RotateCcw, Square } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import { concatMP4Files } from "@/lib/concatMP4";
import { cacheDirectory, documentDirectory, getInfoAsync, downloadAsync, makeDirectoryAsync } from "@/lib/fileSystemCompat";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const SCRUB_BAR_HEIGHT = 40;
const MAX_VIDEO_SECONDS = 300;

// ── Capture ring constants (matching camera.tsx) ────────────────────────
const RING_SIZE = 96;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const RING_WRAP = RING_SIZE + 28;

const AnimatedCircle = Animated.createAnimatedComponent(SvgCircle);

/** Recording states for the unified watch-and-react screen */
type ScreenState = "loading" | "watching" | "recording" | "processing";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function triggerHaptic(style: Haptics.ImpactFeedbackStyle): void {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(style).catch(() => {});
  }
}

export default function WatchAndReactScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { postId } = useLocalSearchParams<{ postId: string }>();

  // ── Parent post data ──────────────────────────────────────────────────────
  const [post, setPost] = useState<{
    id: string;
    media_url: string;
    media_type: string;
    caption: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screenState, setScreenState] = useState<ScreenState>("loading");

  // ── Permissions ───────────────────────────────────────────────────────────
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  // ── Parent video playback ─────────────────────────────────────────────────
  const parentVideoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [hasFinished, setHasFinished] = useState(false);
  const isPlayingRef = useRef(true);
  const scrubTrackWidthRef = useRef(SCREEN_W);
  // Track whether the parent clip has been started at least once from the beginning
  const parentStartedFromBeginning = useRef(false);

  // ── Camera recording ──────────────────────────────────────────────────────
  const cameraRef = useRef<CameraView>(null);
  /** Synchronous ref — TRUE source of truth for camera ready state.
   *  React state (camReady) is derived from this and used for UI gating.
   *  The ref is read by async callbacks; the state drives button disabled states. */
  const cameraReadyRef = useRef<boolean>(false);
  /** Resolves when onCameraReady fires — used by the recording start flow
   *  to await camera readiness without spin-polling React state (stale closure). */
  const cameraReadyResolveRef = useRef<(() => void) | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordedUriRef = useRef<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  // Track parent duration for offset-based playback in reaction feeds
  const parentDurationMsRef = useRef<number>(0);
  // Ref mirror of screenState so playback callback can read it without stale closures
  const screenStateRef = useRef<ScreenState>("loading");
  screenStateRef.current = screenState;

  // ── Ring animation (matching camera.tsx capture button) ─────────────────
  const ringProgress = useRef(new Animated.Value(0)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;
  const ringProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch parent post ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!postId) {
      setLoadError("No post specified.");
      setScreenState("watching"); // will show error
      return;
    }
    supabase
      .from("posts")
      .select("id, media_url, media_type, caption")
      .eq("id", postId)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          console.error("[watch-and-react] Failed to fetch post:", error?.message);
          setLoadError("Could not load this clip.");
          setScreenState("watching");
        } else {
          setPost(data as {
            id: string;
            media_url: string;
            media_type: string;
            caption: string | null;
          });
          setScreenState("watching");
        }
      });
  }, [postId]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cameraReadyRef.current = false;
      try { cameraRef.current?.stopRecording(); } catch {}
      parentVideoRef.current?.unloadAsync().catch(() => {});
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (ringProgressIntervalRef.current) clearInterval(ringProgressIntervalRef.current);
    };
  }, []);

  // ── Restart parent clip from beginning when screen first shows ────────────
  useEffect(() => {
    if (screenState === "watching" && post && !parentStartedFromBeginning.current) {
      parentStartedFromBeginning.current = true;
      // Small delay to ensure Video is mounted
      const t = setTimeout(() => {
        parentVideoRef.current?.setPositionAsync(0).catch(() => {});
        parentVideoRef.current?.playAsync().catch(() => {});
        setIsPlaying(true);
        isPlayingRef.current = true;
        setHasFinished(false);
      }, 100);
      return () => clearTimeout(t);
    }
  }, [screenState, post]);

  // ── Ring progress animation (matching camera.tsx) ──────────────────────
  useEffect(() => {
    if (screenState === "recording") {
      ringProgress.setValue(0);
      ringProgressIntervalRef.current = setInterval(() => {
        const segStart = recordingStartTimeRef.current ?? Date.now();
        const elapsed = Date.now() - segStart;
        const pct = Math.min(elapsed / (MAX_VIDEO_SECONDS * 1000), 1);
        ringProgress.setValue(pct);
      }, 50);
      return () => {
        if (ringProgressIntervalRef.current) {
          clearInterval(ringProgressIntervalRef.current);
          ringProgressIntervalRef.current = null;
        }
        ringProgress.setValue(0);
      };
    } else {
      ringProgress.setValue(0);
      if (ringProgressIntervalRef.current) {
        clearInterval(ringProgressIntervalRef.current);
        ringProgressIntervalRef.current = null;
      }
    }
  }, [screenState, ringProgress]);

  // ── Button scale animation (matching camera.tsx) ──────────────────────
  useEffect(() => {
    if (screenState === "recording") {
      Animated.spring(buttonScale, {
        toValue: 1.15,
        useNativeDriver: true,
        friction: 6,
      }).start();
    } else {
      Animated.spring(buttonScale, {
        toValue: 1,
        useNativeDriver: true,
        friction: 6,
      }).start();
    }
  }, [screenState, buttonScale]);

  const ringOffset = ringProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [RING_CIRC, 0],
  });

  // ── Playback status updates ──────────────────────────────────────────────
  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    setPositionMs(status.positionMillis);
    if (status.durationMillis && status.durationMillis > 0) {
      setDurationMs(status.durationMillis);
      // Track the parent clip's full duration for offset-based reaction playback
      parentDurationMsRef.current = status.durationMillis;
    }
    if (status.didJustFinish) {
      const state = screenStateRef.current;
      if (state === "watching") {
        setIsPlaying(false);
        isPlayingRef.current = false;
        setHasFinished(true);
      } else if (state === "recording") {
        // Parent clip ended during recording — auto-stop via the ref callback
        stopRecordingRef.current?.();
      }
    }
  }, []);

  // ── Toggle play/pause (watching state only) ───────────────────────────────
  const togglePlayback = useCallback(() => {
    if (screenState !== "watching") return;
    if (hasFinished) {
      parentVideoRef.current?.setPositionAsync(0).then(() => {
        parentVideoRef.current?.playAsync().catch(() => {});
      }).catch(() => {});
      setHasFinished(false);
      setIsPlaying(true);
      isPlayingRef.current = true;
      setPositionMs(0);
      return;
    }
    if (isPlayingRef.current) {
      parentVideoRef.current?.pauseAsync().catch(() => {});
      setIsPlaying(false);
      isPlayingRef.current = false;
    } else {
      parentVideoRef.current?.playAsync().catch(() => {});
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  }, [screenState, hasFinished]);

  // ── Replay ────────────────────────────────────────────────────────────────
  const handleReplay = useCallback(() => {
    if (screenState !== "watching") return;
    parentVideoRef.current?.setPositionAsync(0).then(() => {
      parentVideoRef.current?.playAsync().catch(() => {});
    }).catch(() => {});
    setHasFinished(false);
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPositionMs(0);
  }, [screenState]);

  // ── Scrub ─────────────────────────────────────────────────────────────────
  const handleScrub = useCallback((x: number) => {
    if (screenState !== "watching") return;
    if (durationMs <= 0) return;
    const pct = Math.max(0, Math.min(1, x / (scrubTrackWidthRef.current || SCREEN_W)));
    const targetMs = Math.round(pct * durationMs);
    setPositionMs(targetMs);
    parentVideoRef.current?.setPositionAsync(targetMs).catch(() => {});
    setHasFinished(false);
  }, [screenState, durationMs]);

  const scrubPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => screenState === "watching",
        onMoveShouldSetPanResponder: () => screenState === "watching",
        onPanResponderGrant: (e) => {
          handleScrub(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => {
          handleScrub(e.nativeEvent.locationX);
        },
      }),
    [handleScrub, screenState],
  );

  const progressPct = durationMs > 0 ? positionMs / durationMs : 0;

  // ── Start recording ──────────────────────────────────────────────────────
  const handleStartRecording = useCallback(async () => {
    if (screenState !== "watching") return;

    // Ensure permissions
    if (!camPermission?.granted) {
      const res = await requestCamPermission();
      if (!res.granted) {
        setRecordError("Camera permission is required to record.");
        return;
      }
    }
    if (!micPermission?.granted) {
      const res = await requestMicPermission();
      if (!res.granted) {
        setRecordError("Microphone permission is required to record.");
        return;
      }
    }

    // Restart parent clip from beginning for sync
    parentVideoRef.current?.setPositionAsync(0).catch(() => {});
    parentVideoRef.current?.playAsync().catch(() => {});
    setIsPlaying(true);
    isPlayingRef.current = true;
    setHasFinished(false);
    setPositionMs(0);

    setScreenState("recording");
    setRecordError(null);
    recordedUriRef.current = null;
    triggerHaptic(Haptics.ImpactFeedbackStyle.Heavy);

    // Wait for the native camera session to be ready BEFORE calling
    // recordAsync. Uses a ref+promise pattern (not React state polling)
    // so the wait is never stale — same approach as useCameraRecorder.
    if (!cameraReadyRef.current) {
      console.log("[watch-and-react] Camera not ready — waiting for onCameraReady");
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
            }, 3000),
          ),
        ]);
      } catch {
        // Timeout or rejection
      }
      cameraReadyResolveRef.current = null;

      if (timedOut || !cameraReadyRef.current) {
        console.warn("[watch-and-react] Camera not ready before recordAsync — aborting");
        setRecordError("Camera not ready. Please try again.");
        setScreenState("watching");
        parentVideoRef.current?.pauseAsync().catch(() => {});
        return;
      }
      console.log("[watch-and-react] Camera ready — proceeding to recordAsync");
    }

    try {
      const cam = cameraRef.current;
      if (!cam) {
        setRecordError("Camera not ready. Please try again.");
        setScreenState("watching");
        parentVideoRef.current?.pauseAsync().catch(() => {});
        return;
      }

      recordingStartTimeRef.current = Date.now();
      setRecordingElapsedMs(0);

      // Start elapsed timer
      recordingTimerRef.current = setInterval(() => {
        setRecordingElapsedMs(Date.now() - recordingStartTimeRef.current);
      }, 100);

      console.log("[watch-and-react] Calling recordAsync...");
      const result = await cam.recordAsync({
        maxDuration: MAX_VIDEO_SECONDS,
      });

      // Recording finished (user stopped or max duration)
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }

      if (result?.uri) {
        recordedUriRef.current = result.uri;
        console.log(`[watch-and-react] Recording saved: ${result.uri.slice(0, 60)}`);
      } else {
        console.warn("[watch-and-react] recordAsync returned no URI");
      }

      // Verify the file
      if (recordedUriRef.current) {
        const info = await getInfoAsync(recordedUriRef.current);
        if (!info.exists || (info.size ?? 0) === 0) {
          console.error("[watch-and-react] Recorded file is missing or empty");
          setRecordError("Recording could not be saved. Please try again.");
          recordedUriRef.current = null;
        }
      }

      // Move to processing (stitching)
      setScreenState("processing");
    } catch (e) {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      // Log the FULL error object — not just message — to surface the real cause
      const errAny = e as Record<string, unknown> | undefined;
      console.error("[watch-and-react] recordAsync FAILED — FULL ERROR:", {
        message: (e as Error)?.message,
        name: (e as Error)?.name,
        code: errAny?.code,
        nativeError: errAny?.nativeError,
        stack: (e as Error)?.stack?.slice(0, 300),
      });
      const msg = (e as Error)?.message ?? "Recording failed.";
      setRecordError(msg);
      setScreenState("watching");
      // Stop parent clip
      parentVideoRef.current?.pauseAsync().catch(() => {});
    }
  }, [screenState, camPermission, micPermission, requestCamPermission, requestMicPermission]);

  // ── Stop recording ────────────────────────────────────────────────────────
  const handleStopRecording = useCallback(() => {
    if (screenStateRef.current !== "recording") return;
    try {
      cameraRef.current?.stopRecording();
    } catch {
      // May already be stopped
    }
    // Pause parent clip
    parentVideoRef.current?.pauseAsync().catch(() => {});
  }, []);

  // Stable ref for the stop function so the playback callback can call it
  const stopRecordingRef = useRef<(() => void) | null>(null);
  stopRecordingRef.current = handleStopRecording;

  // ── Processing → stitch parent + reaction, then navigate to editor ───
  useEffect(() => {
    if (screenState !== "processing") return;
    if (!recordedUriRef.current || !postId) {
      setRecordError("Recording was not saved. Please try again.");
      setScreenState("watching");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const reactionUri = recordedUriRef.current!;
        const parentDurationMs = parentDurationMsRef.current;

        // Create output directory
        const outDir = `${documentDirectory}stitched/`;
        await makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});
        const stitchedUri = `${outDir}reaction_${Date.now()}.mp4`;

        // Download the parent clip to a local file
        console.log("[watch-and-react] Downloading parent clip for stitching...");
        const parentLocalUri = `${documentDirectory}parent_${Date.now()}.mp4`;
        const downloadResult = await downloadAsync(post!.media_url, parentLocalUri);
        if (!downloadResult || downloadResult.status !== 200) {
          throw new Error("Failed to download parent clip for stitching.");
        }

        if (cancelled) return;

        // Concatenate: parent first, then reaction
        console.log("[watch-and-react] Stitching parent + reaction...");
        await concatMP4Files([parentLocalUri, reactionUri], stitchedUri);

        if (cancelled) return;

        console.log(`[watch-and-react] Stitched video ready: ${stitchedUri.slice(0, 60)}`);
        console.log(`[watch-and-react] Parent duration: ${parentDurationMs}ms — reaction starts at this offset`);

        const clip = {
          id: `r_${Date.now()}`,
          uri: stitchedUri,
          type: "video" as const,
        };

        router.replace({
          pathname: "/edit",
          params: {
            clips: JSON.stringify([clip]),
            reactingTo: postId,
            originalDurationMs: String(parentDurationMs),
          },
        });
      } catch (stitchErr) {
        if (cancelled) return;
        const msg = stitchErr instanceof Error ? stitchErr.message : "Stitching failed.";
        console.error("[watch-and-react] Stitch error:", msg);

        // Graceful fallback: post the solo reaction clip with parent_post_id set
        console.log("[watch-and-react] Falling back to solo reaction clip...");
        const clip = {
          id: `r_${Date.now()}`,
          uri: recordedUriRef.current!,
          type: "video" as const,
        };

        router.replace({
          pathname: "/edit",
          params: {
            clips: JSON.stringify([clip]),
            reactingTo: postId,
            originalDurationMs: "0",
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [screenState, postId, router, post]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (screenState === "loading") {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.loadingText}>Loading clip…</Text>
      </View>
    );
  }

  // ── Error / no post ───────────────────────────────────────────────────────
  if (loadError || !post) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <Text style={styles.errorText}>{loadError ?? "Clip not found."}</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // ── Processing overlay ────────────────────────────────────────────────────
  if (screenState === "processing") {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.processingText}>Preparing your reaction…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden />

      {/* ── Parent clip: always mounted, plays audio during recording too ── */}
      {post.media_type === "video" ? (
        <Video
          ref={parentVideoRef}
          source={{ uri: post.media_url }}
          style={[
            StyleSheet.absoluteFill,
            // Hide visually during recording but keep mounted for audio
            screenState === "recording" && styles.hiddenVideo,
          ]}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={isPlaying || screenState === "recording"}
          isLooping={false}
          isMuted={false}
          onPlaybackStatusUpdate={onPlaybackStatusUpdate}
          progressUpdateIntervalMillis={100}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.imagePlaceholder]}>
          <Text style={styles.imageText}>Photo</Text>
        </View>
      )}

      {/* ── Camera: pre-mounted hidden during watching so it's ready ──── */}
      {/*     when the user taps Record. Gated on camReady for recordAsync. */}
      {(screenState === "watching" || screenState === "recording") && (
        <View
          style={[
            StyleSheet.absoluteFill,
            screenState === "watching" && styles.cameraHidden,
          ]}
          pointerEvents={screenState === "watching" ? "none" : "auto"}
        >
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="front"
            mode="video"
            mute={false}
            mirror
            videoQuality="1080p"
            onCameraReady={() => {
              cameraReadyRef.current = true;
              setCamReady(true);
              if (cameraReadyResolveRef.current) {
                cameraReadyResolveRef.current();
                cameraReadyResolveRef.current = null;
              }
              console.log("[watch-and-react] onCameraReady — camera session is live");
            }}
            onMountError={(e) => {
              cameraReadyRef.current = false;
              console.error("[watch-and-react] Camera mount error:", e?.message);
              setRecordError("Camera failed to start.");
              setScreenState("watching");
            }}
          />
        </View>
      )}

      {/* ── Top bar: back button ────────────────────────────────────────── */}
      <SafeAreaView edges={["top"]} style={styles.topSafe}>
        <Pressable
          onPress={() => {
            if (screenState === "recording") {
              handleStopRecording();
            }
            parentVideoRef.current?.unloadAsync().catch(() => {});
            router.back();
          }}
          style={styles.iconBtn}
          hitSlop={8}
          accessibilityLabel="Go back"
        >
          <ArrowLeft color="#fff" size={20} strokeWidth={2.5} />
        </Pressable>
      </SafeAreaView>

      {/* ── Center play/pause overlay (watching only) ────────────────────── */}
      {screenState === "watching" && (!isPlaying || hasFinished) && (
        <Pressable onPress={togglePlayback} style={styles.centerOverlay}>
          <View style={styles.playCircleLarge}>
            {hasFinished ? (
              <RotateCcw size={32} color="#fff" strokeWidth={2} />
            ) : (
              <Play size={32} color="#fff" fill="#fff" style={{ left: 2 }} />
            )}
          </View>
        </Pressable>
      )}

      {/* ── Recording indicator ──────────────────────────────────────────── */}
      {screenState === "recording" && (
        <View style={[styles.recIndicator, { top: insets.top + 20 }]} pointerEvents="none">
          <View style={styles.recDot} />
          <Text style={styles.recText}>
            REC {formatTime(recordingElapsedMs)}
          </Text>
        </View>
      )}

      {/* ── Recording error ──────────────────────────────────────────────── */}
      {recordError && (
        <View style={[styles.recErrorBanner, { top: insets.top + 60 }]} pointerEvents="none">
          <Text style={styles.recErrorText}>{recordError}</Text>
        </View>
      )}

      {/* ── Bottom controls ──────────────────────────────────────────────── */}
      <View
        style={[styles.bottomSection, { paddingBottom: insets.bottom + 12 }]}
        pointerEvents="box-none"
      >
        {/* Caption (watching only) */}
        {screenState === "watching" && post.caption ? (
          <Text style={styles.caption} numberOfLines={2}>
            {post.caption}
          </Text>
        ) : null}

        {/* Scrub bar (watching only) */}
        {screenState === "watching" && (
          <View style={styles.scrubRow}>
            <Text style={styles.timeLabel}>{formatTime(positionMs)}</Text>
            <View
              style={styles.scrubTrack}
              onLayout={(e) => {
                scrubTrackWidthRef.current = e.nativeEvent.layout.width;
              }}
              {...scrubPan.panHandlers}
            >
              <View style={styles.scrubTrackBg} />
              <View
                style={[
                  styles.scrubTrackFill,
                  { width: `${progressPct * 100}%` as any },
                ]}
              />
              <View
                style={[
                  styles.scrubThumb,
                  { left: `${progressPct * 100}%` as any, marginLeft: -6 },
                ]}
              />
            </View>
            <Text style={styles.timeLabel}>{formatTime(durationMs)}</Text>
          </View>
        )}

        {/* Record / Stop button — circular SVG ring (matching camera.tsx) */}
        {screenState === "watching" ? (
          <View style={styles.captureRow}>
            <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
              <Pressable
                onPress={handleStartRecording}
                disabled={!camReady}
                style={({ pressed }) => [
                  styles.captureWrap,
                  !camReady && { opacity: 0.4 },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Svg
                  width={RING_WRAP}
                  height={RING_WRAP}
                  style={StyleSheet.absoluteFill}
                >
                  <SvgCircle
                    cx={RING_WRAP / 2}
                    cy={RING_WRAP / 2}
                    r={RING_RADIUS}
                    stroke="rgba(255,255,255,0.18)"
                    strokeWidth={RING_STROKE}
                    fill="transparent"
                  />
                </Svg>
                <View style={styles.captureBtnInner}>
                  {!camReady ? (
                    <ActivityIndicator color="rgba(255,255,255,0.7)" size="small" />
                  ) : (
                    <View style={styles.captureBtnDot} />
                  )}
                </View>
              </Pressable>
            </Animated.View>
            {!camReady ? (
              <Text style={styles.captureHint}>Preparing camera…</Text>
            ) : (
              <Text style={styles.captureHint}>Tap to record reaction</Text>
            )}
          </View>
        ) : screenState === "recording" ? (
          <View style={styles.captureRow}>
            <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
              <Pressable
                onPress={handleStopRecording}
                style={({ pressed }) => [
                  styles.captureWrap,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Svg
                  width={RING_WRAP}
                  height={RING_WRAP}
                  style={StyleSheet.absoluteFill}
                >
                  <SvgCircle
                    cx={RING_WRAP / 2}
                    cy={RING_WRAP / 2}
                    r={RING_RADIUS}
                    stroke="rgba(255,255,255,0.18)"
                    strokeWidth={RING_STROKE}
                    fill="transparent"
                  />
                  <AnimatedCircle
                    cx={RING_WRAP / 2}
                    cy={RING_WRAP / 2}
                    r={RING_RADIUS}
                    stroke={theme.accent}
                    strokeWidth={RING_STROKE}
                    strokeLinecap="round"
                    fill="transparent"
                    strokeDasharray={`${RING_CIRC}, ${RING_CIRC}`}
                    strokeDashoffset={ringOffset}
                    transform={`rotate(-90 ${RING_WRAP / 2} ${RING_WRAP / 2})`}
                  />
                </Svg>
                <View style={[styles.captureBtnInner, styles.captureBtnInnerRecording]}>
                  <Square color="#fff" size={22} fill="#fff" />
                </View>
              </Pressable>
            </Animated.View>
            <Text style={styles.captureHint}>Tap to stop</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#000",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
    backgroundColor: theme.bg,
  },
  loadingText: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  processingText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 15,
    fontWeight: "600" as const,
  },
  errorText: {
    color: theme.danger,
    fontSize: 15,
    fontWeight: "600" as const,
    textAlign: "center",
  },
  backBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
  backBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },
  hiddenVideo: {
    opacity: 0,
  },
  cameraHidden: {
    opacity: 0,
    zIndex: -1,
  },
  imagePlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111",
  },
  imageText: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 16,
    fontWeight: "600" as const,
  },

  /* Top bar */
  topSafe: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(10,10,10,0.5)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },

  /* Center play overlay */
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  playCircleLarge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.15)",
  },

  /* Recording indicator */
  recIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    zIndex: 10,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.danger,
  },
  recText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 1.2,
  },

  /* Recording error */
  recErrorBanner: {
    position: "absolute",
    left: 20,
    right: 20,
    alignItems: "center",
    zIndex: 10,
  },
  recErrorText: {
    color: theme.danger,
    fontSize: 12,
    fontWeight: "600" as const,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
  },

  /* Bottom section */
  bottomSection: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    paddingHorizontal: 20,
    gap: 14,
  },
  caption: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 14,
    fontWeight: "600" as const,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
    marginBottom: 4,
  },

  /* Scrub bar */
  scrubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  timeLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "600" as const,
    fontVariant: ["tabular-nums"],
    minWidth: 32,
  },
  scrubTrack: {
    flex: 1,
    height: SCRUB_BAR_HEIGHT,
    justifyContent: "center",
  },
  scrubTrackBg: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  scrubTrackFill: {
    position: "absolute",
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },
  scrubThumb: {
    position: "absolute",
    top: (SCRUB_BAR_HEIGHT - 14) / 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },

  /* Capture button row (matching camera.tsx) */
  captureRow: {
    alignItems: "center",
    gap: 10,
  },
  captureWrap: {
    width: RING_WRAP,
    height: RING_WRAP,
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtnInner: {
    width: RING_SIZE - 12,
    height: RING_SIZE - 12,
    borderRadius: (RING_SIZE - 12) / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 3,
    borderColor: "#fff",
  },
  captureBtnInnerRecording: {
    borderColor: theme.accent,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
  },
  captureBtnDot: {
    width: RING_SIZE - 30,
    height: RING_SIZE - 30,
    borderRadius: (RING_SIZE - 30) / 2,
    backgroundColor: "#fff",
  },
  captureHint: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 6,
  },
});
