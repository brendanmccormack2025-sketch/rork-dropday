import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useRouter, useLocalSearchParams } from "expo-router";
import { CameraView } from "expo-camera";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import {
  Camera as CameraIcon,
  Clock,
  X,
  Zap,
  ZapOff,
  ChevronUp,
  Lock,
  Repeat,
  Square,
  ArrowRight,
  Reply,
} from "lucide-react-native";

import PrimaryButton from "@/components/PrimaryButton";
import { getInfoAsync } from "@/lib/fileSystemCompat";
import { supabase } from "@/lib/supabase";
import { theme, getDropWindowState } from "@/constants/theme";
import { useCameraRecorder, type Clip, MAX_VIDEO_SECONDS } from "@/hooks/useCameraRecorder";

const LOCK_DRAG_DISTANCE = 70;

/** Wraps a View, stripping `collapsable` only on web so it
 *  never reaches the DOM. On native, `collapsable={false}` is
 *  required by react-native-gesture-handler to prevent the
 *  underlying native view from being collapsed/optimized away
 *  — stripping it on native breaks gesture recognizer attachment. */
const GestureView = React.forwardRef<
  View,
  React.ComponentProps<typeof View> & { collapsable?: boolean }
>((props, ref) => {
  if (Platform.OS === "web") {
    const { collapsable: _, ...rest } = props;
    return <View ref={ref} {...rest} />;
  }
  return <View ref={ref} {...props} />;
});
const RING_SIZE = 96;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const RING_WRAP = RING_SIZE + 28;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const triggerHaptic = (style: Haptics.ImpactFeedbackStyle) => {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(style).catch(() => {});
  }
};

export default function CameraScreen() {
  const router = useRouter();
  const { reactingTo, rootDropId } = useLocalSearchParams<{ reactingTo?: string; rootDropId?: string }>();

  // Log received params on mount
  useEffect(() => {
    console.log("[camera] mounted with params:", {
      reactingTo: reactingTo?.slice(0, 12) ?? "(none)",
      rootDropId: rootDropId?.slice(0, 12) ?? "(none)",
    });
  }, []);
  const insets = useSafeAreaInsets();

  const {
    cameraRef,
    permission,
    requestPermission,
    micPermission,
    requestMicPermission,
    facing,
    torch,
    toggleTorch,
    flipCamera,
    recordStateRef,
    isRecording,
    isLocked,
    isLockedRef,
    recordingStartedAtRef,
    startRecording,
    stopRecording,
    lockRecording,
    takePicture,
    clips,
    zoom,
    setZoom,
    isMerging,
    error,
    setError,
    cameraMountError,
    setCameraMountError,
    handleMountError,
    teardown,
    handleCameraReady,
  } = useCameraRecorder();

  const [now, setNow] = useState<Date>(new Date());

  // Recording progress — driven by real elapsed time, NOT an independent timer
  const progress = useRef(new Animated.Value(0)).current;
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buttonScale = useRef(new Animated.Value(1)).current;
  const lockDrag = useRef(new Animated.Value(0)).current;
  const flipFlashOpacity = useRef(new Animated.Value(0)).current;
  const frontFlashOpacity = useRef(new Animated.Value(0)).current;
  const frontFlashHighlightOpacity = useRef(new Animated.Value(0)).current;

  // Gesture-local refs
  const didLongPress = useRef<boolean>(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const frontFlashAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  // Vertical pan zoom: track the baseline zoom at gesture start so zoom
  // accumulates naturally across multiple swipes (Snapchat-style).
  const zoomBaselineRef = useRef<number>(0);
  // Stable ref mirror of `zoom` state — read by gesture callbacks so the
  // pan gesture is never recreated mid-interaction.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Vertical pan zoom indicator state — visible during swipe + 1s after
  const [panZoomActive, setPanZoomActive] = useState(false);
  const panZoomHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPanZoomTimeout = useCallback(() => {
    if (panZoomHideRef.current) {
      clearTimeout(panZoomHideRef.current);
      panZoomHideRef.current = null;
    }
  }, []);

  const scheduleHideZoomIndicator = useCallback(() => {
    clearPanZoomTimeout();
    panZoomHideRef.current = setTimeout(() => {
      setPanZoomActive(false);
    }, 1000);
  }, [clearPanZoomTimeout]);

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Audio session: allow recording while camera is mounted ──────────
  useEffect(() => {
    console.log("[camera] Setting audio mode → allowsRecording");
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    }).catch(() => {});
    return () => {
      console.log("[camera] Restoring audio mode → playback-only");
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      }).catch(() => {});
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
      if (flipAnimRef.current) flipAnimRef.current.stop();
      if (frontFlashAnimRef.current) frontFlashAnimRef.current.stop();
      if (panZoomHideRef.current) clearTimeout(panZoomHideRef.current);

      setZoom(0);
      setPanZoomActive(false);
      teardown();
    };
  }, [setZoom, teardown]);

  const win = useMemo(() => getDropWindowState(now), [now]);

  // ─── Recording progress — driven by real elapsed time ───────────
  useEffect(() => {
    if (isRecording && !isLocked) {
      console.log("[camera] RING ANIMATION START");
      progress.setValue(0);

      progressIntervalRef.current = setInterval(() => {
        // Read recordingStartedAtRef.current LIVE each tick so the ring
        // smoothly resets if the camera flips mid-recording (auto-restart).
        const segStart = recordingStartedAtRef.current ?? Date.now();
        const elapsed = Date.now() - segStart;
        const pct = Math.min(elapsed / (MAX_VIDEO_SECONDS * 1000), 1);
        progress.setValue(pct);
      }, 50);

      return () => {
        console.log("[camera] RING ANIMATION STOP");
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
        progress.setValue(0);
      };
    } else if (!isRecording) {
      progress.setValue(0);
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    }
  }, [isRecording, isLocked, progress, recordingStartedAtRef]);

  // ─── Button scale animation ─────────────────────────────────────
  useEffect(() => {
    if (isRecording) {
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
  }, [isRecording, buttonScale]);

  // ─── Front flash for photo capture ───────────────────────────

  const triggerFrontFlashPhoto = useCallback(() => {
    if (frontFlashAnimRef.current) frontFlashAnimRef.current.stop();
    frontFlashHighlightOpacity.setValue(1);
    frontFlashAnimRef.current = Animated.timing(frontFlashHighlightOpacity, {
      toValue: 0,
      duration: 380,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    frontFlashAnimRef.current.start();
  }, [frontFlashHighlightOpacity]);

  // ─── Recording screen flash for front camera ─────────────────

  useEffect(() => {
    if (torch && facing === "front" && isRecording) {
      Animated.timing(frontFlashOpacity, {
        toValue: 0.55,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(frontFlashOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [torch, facing, isRecording, frontFlashOpacity]);

  // ─── Gesture handlers ──────────────────────────────────────────

  const handleLongPressStart = useCallback(() => {
    try {
      if (isLockedRef.current) {
        stopRecording();
        return;
      }
      didLongPress.current = false;
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      longPressTimer.current = setTimeout(() => {
        didLongPress.current = true;
        startRecording().catch((e) => {
          console.error("[camera] startRecording failed:", e);
          setError(e instanceof Error ? e.message : "Recording failed to start.");
        });
      }, 260);
    } catch (e) {
      console.error("[camera] handleLongPressStart error:", e);
      setError("Something went wrong. Please try again.");
    }
  }, [startRecording, stopRecording, setError]);

  const handleDragMove = useCallback(
    (_: unknown, g: { dy: number }) => {
      try {
        if (recordStateRef.current !== "recording" && recordStateRef.current !== "stopping") return;
        if (isLockedRef.current) return;
        const upward = -g.dy;
        const pct = Math.max(0, Math.min(1, upward / LOCK_DRAG_DISTANCE));
        lockDrag.setValue(pct);
        if (upward >= LOCK_DRAG_DISTANCE) {
          lockRecording();
          Animated.spring(lockDrag, {
            toValue: 1,
            useNativeDriver: false,
            friction: 6,
          }).start();
        }
      } catch (e) {
        console.error("[camera] handleDragMove error:", e);
      }
    },
    [lockDrag, lockRecording]
  );

  const handleRelease = useCallback(() => {
    try {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      if (isLockedRef.current) return;
      if (didLongPress.current || recordStateRef.current === "recording") {
        stopRecording();
      } else {
        if (torch && facing === "front") {
          triggerFrontFlashPhoto();
        }
        takePicture().catch((e) => {
          console.error("[camera] takePicture failed:", e);
        });
      }
      Animated.timing(lockDrag, {
        toValue: 0,
        duration: 180,
        useNativeDriver: false,
      }).start();
    } catch (e) {
      console.error("[camera] handleRelease error:", e);
      setError("Something went wrong. Please try again.");
    }
  }, [stopRecording, takePicture, lockDrag, torch, facing, triggerFrontFlashPhoto, setError]);

  const handleTerminate = useCallback(() => {
    try {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      if (!isLockedRef.current && recordStateRef.current === "recording") {
        stopRecording();
      }
      Animated.timing(lockDrag, {
        toValue: isLockedRef.current ? 1 : 0,
        duration: 180,
        useNativeDriver: false,
      }).start();
    } catch (e) {
      console.error("[camera] handleTerminate error:", e);
    }
  }, [stopRecording, lockDrag]);

  const capturePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: handleLongPressStart,
        onPanResponderMove: (_e, g) => handleDragMove(_e, g),
        onPanResponderRelease: handleRelease,
        onPanResponderTerminate: handleTerminate,
      }),
    [handleLongPressStart, handleDragMove, handleRelease, handleTerminate]
  );

  // ─── Flip camera with flash ───────────────────────────────────

  const triggerFlipFlash = useCallback(() => {
    if (flipAnimRef.current) flipAnimRef.current.stop();
    flipFlashOpacity.setValue(0.5);
    flipAnimRef.current = Animated.timing(flipFlashOpacity, {
      toValue: 0,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    flipAnimRef.current.start();
  }, [flipFlashOpacity]);

  const handleFlip = useCallback(() => {
    console.log("[camera] DOUBLE TAP — executing flip");
    flipCamera();
    setZoom(0);
    triggerFlipFlash();
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
  }, [flipCamera, setZoom, triggerFlipFlash]);

  // Double-tap anywhere on the preview to flip cameras.
  // react-native-gesture-handler TapGestureHandler configured for
  // numberOfTaps(2) with runOnJS so the callback fires on the JS
  // thread. This gesture wraps the full-screen CameraView overlay.
  const flipGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(300)
        .runOnJS(true)
        .onStart(() => {
          console.log("[camera] DOUBLE TAP DETECTED");
        })
        .onEnd(() => {
          console.log("[camera] DOUBLE TAP — firing handleFlip");
          handleFlip();
        }),
    [handleFlip]
  );

  // ─── Vertical pan zoom (Snapchat-style) ──────────────────────
  // One-finger vertical swipe on the camera viewfinder:
  //   Swipe UP   → zoom in
  //   Swipe DOWN → zoom out
  // Runs on the UI thread (worklet) for low-latency tracking.
  // Reads zoomRef.current (not `zoom` state) so the gesture stays
  // alive throughout the entire swipe lifecycle.
  const updateZoomOnJS = useCallback((next: number) => {
    setZoom(next);
  }, [setZoom]);

  const panZoomGesture = useMemo(
    () =>
      Gesture.Pan()
        .minPointers(1)
        .maxPointers(1)
        .activeOffsetY([-12, 12])
        .onBegin(() => {
          zoomBaselineRef.current = zoomRef.current;
          runOnJS(setPanZoomActive)(true);
          runOnJS(clearPanZoomTimeout)();
        })
        .onUpdate((e) => {
          // Swipe UP (negative translationY) → zoom increase
          const sensitivity = 0.004;
          const delta = -e.translationY * sensitivity;
          const next = Math.min(1, Math.max(0, zoomBaselineRef.current + delta));
          runOnJS(updateZoomOnJS)(next);
        })
        .onEnd(() => {
          runOnJS(scheduleHideZoomIndicator)();
        })
        .onFinalize(() => {
          runOnJS(scheduleHideZoomIndicator)();
        }),
    [updateZoomOnJS, clearPanZoomTimeout, scheduleHideZoomIndicator],
  );

  // Simultaneous gesture composition: pan-zoom and double-tap coexist.
  // Vertical swipe zoom does not interfere with the tap-to-record workflow.
  const previewGestures = useMemo(
    () => Gesture.Simultaneous(panZoomGesture, flipGesture),
    [flipGesture, panZoomGesture],
  );

  // ─── Navigation ────────────────────────────────────────────────

  const closeCamera = useCallback(() => {
    teardown();
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  }, [router, teardown]);

  const goToEdit = useCallback(async () => {
    if (clips.length === 0) return;

    // Verify every clip's file exists and is non-empty before navigating.
    // If the merge step produced a corrupt / empty / missing file, surface
    // a visible error instead of sending the editor a dead URI (black screen).
    for (const clip of clips) {
      if (clip.type === "video" && clip.uri) {
        try {
          const info = await getInfoAsync(clip.uri);
          console.log(
            `[camera] goToEdit — clip ${clip.id}: ${clip.uri.slice(0, 60)}, exists: ${info.exists}, size: ${info.exists ? (info.size ?? 0) : "N/A"}`,
          );
          if (!info.exists) {
            setError("Video file is missing. Please record again.");
            return;
          }
          if ((info.size ?? 0) === 0) {
            setError("Video file is empty. Please record again.");
            return;
          }
        } catch (e) {
          console.error("[camera] goToEdit — file check failed", e);
          setError("Could not verify video file. Please try again.");
          return;
        }
      }
    }

    const params: Record<string, string> = {
      clips: JSON.stringify(clips),
    };
    if (reactingTo) params.reactingTo = reactingTo;
    if (rootDropId) params.rootDropId = rootDropId;

    console.log("[camera] goToEdit — navigating to edit with:", {
      clipsCount: clips.length,
      reactingTo: reactingTo?.slice(0, 12) ?? "(none)",
      rootDropId: rootDropId?.slice(0, 12) ?? "(none)",
    });

    router.push({
      pathname: "/edit",
      params,
    });
  }, [clips, reactingTo, rootDropId, router, setError]);


  // ─── Permissions: loading ──────────────────────────────────────

  if (!permission) {
    return (
      <View style={[styles.fullscreen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  // ─── Permissions: denied ───────────────────────────────────────

  if (!permission.granted) {
    return (
      <View style={[styles.fullscreen, styles.centered]}>
        <StatusBar style="light" />
        <CameraIcon color={theme.accent} size={48} />
        <UiText style={styles.permTitle}>Camera Access</UiText>
        <UiText style={styles.permSub}>
          DropDay needs your camera to capture content. You can prep anytime and
          post during The Drop.
        </UiText>
        <PrimaryButton
          label="Grant Permission"
          onPress={async () => {
            await requestPermission();
            if (!micPermission?.granted) await requestMicPermission();
          }}
        />
        <Pressable
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
          style={{ marginTop: 12, padding: 12 }}
        >
          <UiText style={styles.permCancel}>Not now</UiText>
        </Pressable>
      </View>
    );
  }



  // ─── Helpers ──────────────────────────────────────────────────



  const shortCountdown = (ms: number): string => {
    if (ms < 0) ms = 0;
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    const s = Math.floor((ms % 60000) / 1000);
    return `${s}s`;
  };

  /** Convert zoom (0–1) to a human-readable label like "2.5×" */
  const zoomToLabel = (z: number): string => {
    // Map 0–1 to roughly 1×–10× (common smartphone max zoom range)
    const factor = 1 + z * 9;
    return `${factor.toFixed(1)}×`;
  };

  const ringOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [RING_CIRC, 0],
  });

  // ─── Camera UI ────────────────────────────────────────────────

  return (
    <GestureHandlerRootView style={styles.fullscreen}>
      <StatusBar style="light" hidden={false} />

      {/* Single CameraView with dynamic facing. The native session
          rebuilds when facing changes — the flip-flash animation
          covers the brief gap seamlessly. */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode="video"
        mute={false}
        enableTorch={torch && facing === "back"}
        zoom={zoom}
        mirror={facing === "front"}
        responsiveOrientationWhenOrientationLocked
        onCameraReady={handleCameraReady}
        onMountError={handleMountError}
      />

      {/* Camera mount error */}
      {cameraMountError && (
        <View style={[StyleSheet.absoluteFill, styles.cameraErrorBanner]} pointerEvents="none">
          <UiText style={styles.cameraErrorBannerText}>{cameraMountError}</UiText>
        </View>
      )}

      {/* Gesture zone — double-tap to flip, vertical swipe to zoom.
          Simultaneous() allows both gestures to coexist on the same layer. */}
      <View style={[StyleSheet.absoluteFill, { zIndex: 5 }]} pointerEvents="box-none">
        <GestureDetector gesture={previewGestures}>
          <GestureView
            style={{ flex: 1 }}
            accessibilityRole="button"
            accessibilityLabel="Double-tap to flip camera, swipe up or down to zoom"
          />
        </GestureDetector>
      </View>

      {/* Flip flash — brief white flash on successful camera switch */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 6, backgroundColor: "#fff", opacity: flipFlashOpacity },
        ]}
      />

      {/* Front flash — persistent screen fill during front-camera recording */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 4, backgroundColor: "#fff", opacity: frontFlashOpacity },
        ]}
      />

      {/* Front flash highlight — brief bright flash for photo capture */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { zIndex: 7, backgroundColor: "#fff", opacity: frontFlashHighlightOpacity },
        ]}
      />

      {/* Top bar */}
      <View
        style={[styles.cameraTop, { top: insets.top + 14 }]}
        pointerEvents="box-none"
      >
        <View style={styles.topSideLeft}>
          <Pressable
            onPress={closeCamera}
            style={styles.camIconBtn}
            hitSlop={10}
            accessibilityLabel="Close camera"
          >
            <X color="#fff" size={20} />
          </Pressable>
        </View>

        {/* ── Center pill: countdown for regular drops ── */}
        <View style={styles.countdownPill}>
          {win.isOpen ? (
            <>
              <View style={styles.liveDot} />
              <UiText style={styles.countdownPillTextLive}>LIVE</UiText>
            </>
          ) : (
            <>
              <Clock color={theme.accent} size={11} />
              <UiText style={styles.countdownPillText}>
                Drop opens in {shortCountdown(win.msUntilOpen)}
              </UiText>
            </>
          )}
        </View>

        <View style={styles.topSideRight}>
          <Pressable
            onPress={toggleTorch}
            style={styles.camIconBtn}
            hitSlop={10}
            accessibilityLabel={facing === "back" ? "Toggle LED flash" : "Toggle screen flash"}
          >
            {torch ? (
              <Zap color={theme.accent} size={18} fill={theme.accent} />
            ) : (
              <ZapOff color="#fff" size={18} />
            )}
          </Pressable>
          {/* Fallback flip button — always visible */}
          <Pressable
            onPress={handleFlip}
            style={styles.camIconBtn}
            hitSlop={10}
            accessibilityLabel="Flip camera"
          >
            <Repeat color="#fff" size={18} />
          </Pressable>
        </View>
      </View>

      {/* Recording hint */}
      {!isRecording && clips.length === 0 && (
        <View
          style={[styles.hintWrap, { bottom: insets.bottom + 210 }]}
          pointerEvents="none"
        >
          <UiText style={styles.hintText}>Tap to capture  ·  Hold to record  ·  Double-tap to flip</UiText>
        </View>
      )}

      {/* Zoom bar — vertical indicator on the right side, Snapchat-style.
          Visible while actively swiping (panZoomActive) or when zoomed in.
          Hides 1 second after the user stops swiping. */}
      {(panZoomActive || zoom > 0.01) && (
        <View style={styles.zoomBarWrap} pointerEvents="none">
          <View style={styles.zoomBarTrack}>
            <View
              style={[
                styles.zoomBarFill,
                { height: `${Math.round(zoom * 100)}%` },
              ]}
            />
          </View>
          <UiText style={styles.zoomBarLabel}>{zoomToLabel(zoom)}</UiText>
        </View>
      )}

      {/* Recording indicator — hidden during merge so only the processing overlay shows */}
      {isRecording && !isMerging && (
        <View
          style={[styles.recTimerWrap, { top: insets.top + 74 }]}
          pointerEvents="none"
        >
          <View style={styles.recDot} />
          <UiText style={styles.recTimerText}>REC</UiText>
        </View>
      )}

      {/* Merging indicator — shown while multiple segments are being combined */}
      {isMerging && (
        <View
          style={[styles.mergeOverlay, { paddingBottom: insets.bottom + 40 }]}
          pointerEvents="none"
        >
          <ActivityIndicator color={theme.accent} size="large" />
          <UiText style={styles.mergeText}>Processing video...</UiText>
        </View>
      )}

      {/* Next button — appears when clips are ready and not actively recording or merging */}
      {clips.length > 0 && !isRecording && !isMerging && (
        <View
          style={[styles.nextBtnRow, { bottom: insets.bottom + 170 }]}
          pointerEvents="box-none"
        >
          <Pressable
            onPress={goToEdit}
            style={styles.nextBtn}
            accessibilityLabel="Proceed to editor"
          >
            <UiText style={styles.nextBtnText}>Next</UiText>
            <ArrowRight color="#fff" size={15} strokeWidth={2.5} />
          </Pressable>
        </View>
      )}

      {/* Bottom: capture button + lock UI — hidden during merge */}
      {!isMerging && (
      <View
        style={[styles.cameraBottom, { paddingBottom: insets.bottom + 28 }]}
        pointerEvents="box-none"
      >

        {/* Drag-to-lock hint */}
        {isRecording && !isLocked && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.lockHint,
              {
                opacity: lockDrag.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.7, 1],
                }),
                transform: [
                  {
                    translateY: lockDrag.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -22],
                    }),
                  },
                ],
              },
            ]}
          >
            <Animated.View
              style={{
                opacity: lockDrag.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.4, 1],
                }),
              }}
            >
              <ChevronUp color={theme.accent} size={22} strokeWidth={2.5} />
            </Animated.View>
            <UiText style={styles.lockHintText}>Slide up to lock</UiText>
          </Animated.View>
        )}

        {/* Locked indicator */}
        {isRecording && isLocked && (
          <View style={styles.lockedPill} pointerEvents="none">
            <Lock color={theme.accent} size={11} />
            <UiText style={styles.lockedPillText}>LOCKED · TAP TO STOP</UiText>
          </View>
        )}

        {/* Capture button */}
        <Animated.View
          style={[styles.captureWrap, { transform: [{ scale: buttonScale }] }]}
          {...capturePan.panHandlers}
        >
          <Svg
            width={RING_WRAP}
            height={RING_WRAP}
            style={StyleSheet.absoluteFill}
          >
            <Circle
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

          <View
            pointerEvents="none"
            style={[
              styles.captureBtn,
              isRecording && styles.captureBtnRecording,
              isLocked && styles.captureBtnLocked,
            ]}
          >
            {isLocked ? (
              <Square color="#fff" size={22} fill="#fff" />
            ) : (
              <View
                style={[
                  styles.captureInner,
                  isRecording && styles.captureInnerRecording,
                ]}
              />
            )}
          </View>
        </Animated.View>

        {error && <UiText style={styles.cameraErrorText}>{error}</UiText>}
      </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  fullscreen: { flex: 1, backgroundColor: "#0A0A14" },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: 32,
    backgroundColor: theme.bg,
  },
  permTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "700" as const,
  },
  permSub: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 4,
  },
  permCancel: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: "600" as const,
  },

  cameraTop: {
    position: "absolute",
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
  },
  topSideLeft: {
    flex: 1,
    alignItems: "flex-start",
  },
  topSideRight: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  camIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(10,10,10,0.5)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },

  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 10,
  },
  nextBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
  countdownPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(10,10,10,0.5)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  countdownPillText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600" as const,
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.2,
  },
  countdownPillTextLive: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 1.1,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },

  nextBtnRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
  },

  recTimerWrap: {
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
  recTimerText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 1.2,
  },

  hintWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 5,
  },
  hintText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 6,
  },

  cameraBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    gap: 20,
    zIndex: 8,
  },

  captureWrap: {
    width: RING_WRAP,
    height: RING_WRAP,
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtn: {
    width: RING_SIZE - 12,
    height: RING_SIZE - 12,
    borderRadius: (RING_SIZE - 12) / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 3,
    borderColor: "#fff",
  },
  captureBtnRecording: {
    borderColor: theme.accent,
    backgroundColor: "rgba(10,132,255,0.22)",
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
  },
  captureBtnLocked: {
    backgroundColor: theme.accent,
    borderColor: "#fff",
  },
  captureInner: {
    width: RING_SIZE - 30,
    height: RING_SIZE - 30,
    borderRadius: (RING_SIZE - 30) / 2,
    backgroundColor: "#fff",
  },
  captureInnerRecording: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: theme.accent,
  },

  lockHint: {
    position: "absolute",
    bottom: RING_WRAP + 18,
    alignSelf: "center",
    alignItems: "center",
    gap: 2,
    zIndex: 9,
  },
  lockHintText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 10,
    fontWeight: "700" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  lockedPill: {
    position: "absolute",
    bottom: RING_WRAP + 22,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(10,10,10,0.6)",
    borderWidth: 1,
    borderColor: theme.accent,
    zIndex: 9,
  },
  lockedPillText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 1,
  },

  cameraErrorText: {
    color: theme.danger,
    fontSize: 12,
    fontWeight: "600" as const,
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
  },

  zoomBarWrap: {
    position: "absolute",
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    zIndex: 10,
  },
  zoomBarTrack: {
    width: 4,
    height: 132,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.18)",
    overflow: "hidden",
  },
  zoomBarFill: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.accent,
    borderRadius: 2,
  },
  zoomBarLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700" as const,
    fontVariant: ["tabular-nums"],
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 4,
  },

  cameraErrorBanner: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.85)",
    padding: 32,
  },
  cameraErrorBannerText: {
    color: theme.danger,
    fontSize: 14,
    fontWeight: "600" as const,
    textAlign: "center",
    lineHeight: 20,
  },

  mergeOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    zIndex: 20,
  },
  mergeText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600" as const,
    letterSpacing: 0.3,
  },

});
