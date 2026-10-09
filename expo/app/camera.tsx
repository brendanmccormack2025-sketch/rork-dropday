import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useRouter, useLocalSearchParams, useNavigation } from "expo-router";
import { CameraView } from "expo-camera";
import { BlurView } from "expo-blur";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { setAudioModeAsync } from "expo-audio";
import { Camera as CameraIcon, Check, Delete, RefreshCw, X, Zap, ZapOff } from "lucide-react-native";

import PrimaryButton from "@/components/PrimaryButton";
import { theme } from "@/constants/theme";
import { useCameraRecorder } from "@/hooks/useCameraRecorder";
import { MAX_CAMERA_MS, barSegments, canProceed, totalMs, usableSegments } from "@/lib/cameraSegments";

/** Record button: a 76 pt circle inside an 88 pt touch target (the minimum is 72). */
const RECORD_SIZE = 76;
const RECORD_TOUCH = 88;
/** Tool buttons (flip, flash) and the side buttons beside record. */
const TOOL_SIZE = 48;
/** Height of the area at the bottom that belongs to the record controls: the double-tap zone stays clear of it. */
const CONTROLS_ZONE = 190;
/** Width of the right-hand tool column: the double-tap zone stays clear of it too. */
const TOOLS_ZONE = 76;

const hapticLight = () => {
  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

export default function CameraScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { reactingTo, rootDropId } = useLocalSearchParams<{ reactingTo?: string; rootDropId?: string }>();
  const insets = useSafeAreaInsets();

  const {
    cameraRef,
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
    isRecording,
    recordState,
    takeLiveMs,
    takeRef,
    toggleRecording,
    deleteLastClip,
    clips,
    zoom,
    setZoom,
    error,
    cameraMountError,
    handleMountError,
    teardown,
    handleCameraReady,
  } = useCameraRecorder();

  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  /** Length of the segment in progress (ms), for the bar and the timer. */
  const [liveMs, setLiveMs] = useState(0);

  // Record button: red with a gentle pulse while recording.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isRecording) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isRecording, pulse]);

  // Flip icon: a short spin.
  const spin = useRef(new Animated.Value(0)).current;
  // The blur over the preview while a flip switches cameras (never white).
  const blurOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Brief and subtle: it comes in fast and goes as soon as the new camera records.
    Animated.timing(blurOpacity, { toValue: switching ? 1 : 0, duration: switching ? 60 : 90, useNativeDriver: true }).start();
  }, [switching, blurOpacity]);

  // The take in progress: ticks while recording, and keeps going through a flip (the take is one recording to the user).
  useEffect(() => {
    if (!isRecording) {
      setLiveMs(0);
      return;
    }
    const id = setInterval(() => setLiveMs(takeLiveMs()), 100);
    return () => clearInterval(id);
  }, [isRecording, takeLiveMs]);

  // Audio session: allow recording while the camera is mounted.
  useEffect(() => {
    setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
    return () => {
      setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    return () => {
      setZoom(0);
      teardown();
    };
  }, [setZoom, teardown]);

  // ─── Zoom indicator ────────────────────────────────────────────
  const zoomBaselineRef = useRef(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
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
    panZoomHideRef.current = setTimeout(() => setPanZoomActive(false), 1000);
  }, [clearPanZoomTimeout]);
  useEffect(() => () => clearPanZoomTimeout(), [clearPanZoomTimeout]);

  // ─── Flip ──────────────────────────────────────────────────────
  const handleFlip = useCallback(() => {
    if (!flipCamera()) return; // ignored while a flip is already switching
    hapticLight();
    spin.setValue(0);
    Animated.timing(spin, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [flipCamera, spin]);

  // Double-tap flips, but only on the preview area (the gesture zone below leaves the controls out); a single tap does nothing.
  const flipGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(300)
        .runOnJS(true)
        .onEnd(() => handleFlip()),
    [handleFlip],
  );
  const updateZoomOnJS = useCallback((next: number) => setZoom(next), [setZoom]);
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
          const next = Math.min(1, Math.max(0, zoomBaselineRef.current + -e.translationY * 0.004));
          runOnJS(updateZoomOnJS)(next);
        })
        .onEnd(() => runOnJS(scheduleHideZoomIndicator)())
        .onFinalize(() => runOnJS(scheduleHideZoomIndicator)()),
    [updateZoomOnJS, clearPanZoomTimeout, scheduleHideZoomIndicator],
  );
  const previewGestures = useMemo(() => Gesture.Simultaneous(panZoomGesture, flipGesture), [flipGesture, panZoomGesture]);

  // ─── Navigation ────────────────────────────────────────────────
  const closeCamera = useCallback(() => {
    teardown();
    if (navigation.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router, teardown, navigation]);

  const goToEdit = useCallback(() => {
    if (!canProceed(clips) || isRecording) return;
    // The recorder's own timing is only for the bar; the editor measures the real lengths.
    const forEditor = usableSegments(clips).map(({ measuredMs: _m, ...clip }) => clip);
    const params: Record<string, string> = { clips: JSON.stringify(forEditor) };
    if (reactingTo) params.reactingTo = reactingTo;
    if (rootDropId) params.rootDropId = rootDropId;
    router.push({ pathname: "/edit", params });
  }, [clips, isRecording, reactingTo, rootDropId, router]);

  // "Delete last": confirm, then the most recent segment (and its file) is removed. Repeatable.
  const confirmDeleteLast = useCallback(() => {
    if (isRecording) return;
    Alert.alert("Delete last clip?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: deleteLastClip },
    ]);
  }, [deleteLastClip, isRecording]);

  const onRecordPress = useCallback(() => {
    void toggleRecording();
  }, [toggleRecording]);

  // ─── Permissions ───────────────────────────────────────────────
  if (!permission) {
    return (
      <View style={[styles.fullscreen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <UiText style={styles.permSub}>Loading camera…</UiText>
      </View>
    );
  }

  if (!permission.granted) {
    const wasPrompted = permission.status === "denied";
    return (
      <View style={[styles.fullscreen, styles.centered]}>
        <StatusBar style="light" />
        <CameraIcon color={theme.accent} size={48} />
        <UiText style={styles.permTitle}>Camera Access</UiText>
        <UiText style={styles.permSub}>Trial needs your camera to capture content.</UiText>
        {wasPrompted ? (
          <PrimaryButton
            label="Open Settings"
            onPress={() => {
              if (Platform.OS === "ios") Linking.openURL("app-settings:");
              else Linking.openSettings();
            }}
          />
        ) : (
          <>
            <PrimaryButton
              label="Continue"
              onPress={async () => {
                await requestPermission();
                if (!micPermission?.granted) await requestMicPermission();
              }}
            />
            <Pressable
              onPress={async () => {
                await requestPermission();
                if (!micPermission?.granted) await requestMicPermission();
              }}
              style={{ marginTop: 12, padding: 12 }}
            >
              <UiText style={styles.permCancel}>Not now</UiText>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  const zoomToLabel = (z: number): string => `${(1 + z * 9).toFixed(1)}×`;
  const stopping = recordState === "stopping";
  const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const showNext = canProceed(clips);
  const takeSeconds = Math.min(60, Math.floor((totalMs(clips) + liveMs) / 1000));

  return (
    <GestureHandlerRootView style={styles.fullscreen}>
      <StatusBar style="light" hidden={false} />

      {/* One CameraView, mounted for the whole screen and never replaced: a flip only changes `facing`. */}
      {facingLoaded && (
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
      )}

      {cameraMountError && (
        <View style={[StyleSheet.absoluteFill, styles.cameraErrorBanner]} pointerEvents="none">
          <UiText style={styles.cameraErrorBannerText}>{cameraMountError}</UiText>
        </View>
      )}

      {/* Preview gestures (double-tap to flip, swipe to zoom): the preview only, clear of the tools and the record controls. */}
      <View style={[styles.previewZone, { bottom: insets.bottom + CONTROLS_ZONE, right: TOOLS_ZONE }]}>
        <GestureDetector gesture={previewGestures}>
          <View style={{ flex: 1 }} accessibilityLabel="Camera preview. Double-tap to flip the camera, swipe up or down to zoom" />
        </GestureDetector>
      </View>

      {/* While a flip switches cameras: a dark blur over the preview, never white. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: blurOpacity, zIndex: 6 }]}>
        <BlurView intensity={22} tint="dark" style={StyleSheet.absoluteFill} />
      </Animated.View>

      {/* Segmented progress bar: the take against 60 s, a notch where each segment starts */}
      <View style={[styles.segBar, { top: insets.top + 6 }]} pointerEvents="none" accessibilityLabel="Recording progress">
        {barSegments(clips, isRecording ? { ms: liveMs, runId: takeRef.current?.id } : undefined).map((seg, i) => (
          <View
            key={i}
            style={[
              styles.segFill,
              { left: `${seg.startFrac * 100}%`, width: `${Math.max(0.4, seg.widthFrac * 100)}%` },
              seg.live && styles.segFillLive,
              i > 0 && styles.segNotch,
            ]}
          />
        ))}
      </View>

      {/* Close */}
      <View style={[styles.closeWrap, { top: insets.top + 22 }]} pointerEvents="box-none">
        <Pressable onPress={closeCamera} style={styles.toolBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel="Close camera">
          <X color="#fff" size={22} />
        </Pressable>
      </View>

      {/* Right-side tool column: flash (back camera only) and flip */}
      <View style={[styles.toolColumn, { top: insets.top + 22 }]} pointerEvents="box-none">
        {facing === "back" && (
          <Pressable
            onPress={toggleTorch}
            style={styles.toolBtn}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Toggle flash"
          >
            {torch ? <Zap color={theme.accent} size={22} fill={theme.accent} /> : <ZapOff color="#fff" size={22} />}
          </Pressable>
        )}
        <Pressable
          onPress={handleFlip}
          disabled={switching}
          style={styles.toolBtn}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
        >
          <Animated.View style={{ transform: [{ rotate: spinDeg }] }}>
            <RefreshCw color="#fff" size={22} />
          </Animated.View>
        </Pressable>
      </View>

      {!isRecording && clips.length === 0 && (
        <View style={[styles.hintWrap, { bottom: insets.bottom + CONTROLS_ZONE - 10 }]} pointerEvents="none">
          <UiText style={styles.hintText}>Tap to record  ·  Tap again to stop</UiText>
        </View>
      )}

      {(panZoomActive || zoom > 0.01) && (
        <View style={styles.zoomBarWrap} pointerEvents="none">
          <View style={styles.zoomBarTrack}>
            <View style={[styles.zoomBarFill, { height: `${Math.round(zoom * 100)}%` }]} />
          </View>
          <UiText style={styles.zoomBarLabel}>{zoomToLabel(zoom)}</UiText>
        </View>
      )}

      {isRecording && (
        <View style={[styles.recTimerWrap, { top: insets.top + 30 }]} pointerEvents="none">
          <View style={styles.recDot} />
          <UiText style={styles.recTimerText}>{`REC  ${takeSeconds}s`}</UiText>
        </View>
      )}

      {/* Bottom: delete last (left), record, Next (right) */}
      <View style={[styles.bottomRow, { paddingBottom: insets.bottom + 24 }]} pointerEvents="box-none">
        <View style={styles.sideSlot}>
          {clips.length > 0 && (
            <Pressable
              onPress={confirmDeleteLast}
              disabled={isRecording}
              style={[styles.sideBtn, isRecording && styles.sideBtnDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: isRecording }}
              accessibilityLabel="Delete last clip"
            >
              <Delete color="#fff" size={24} />
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={onRecordPress}
          disabled={stopping}
          style={styles.recordTouch}
          accessibilityRole="button"
          accessibilityLabel={isRecording ? "Stop recording" : "Start recording"}
        >
          <Animated.View style={[styles.recordRing, { transform: [{ scale: isRecording ? pulseScale : 1 }] }]}>
            <View style={[styles.recordDisc, isRecording && styles.recordDiscRecording]} />
          </Animated.View>
        </Pressable>

        <View style={styles.sideSlot}>
          {showNext && (
            <Pressable
              onPress={goToEdit}
              disabled={isRecording}
              style={[styles.sideBtn, styles.nextBtn, isRecording && styles.sideBtnDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: isRecording }}
              accessibilityLabel="Proceed to editor"
            >
              <Check color="#fff" size={26} strokeWidth={3} />
            </Pressable>
          )}
        </View>
      </View>
      {error && (
        <View style={[styles.errorWrap, { bottom: insets.bottom + CONTROLS_ZONE - 40 }]} pointerEvents="none">
          <UiText style={styles.cameraErrorText}>{error}</UiText>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Black, not the light app background: a gap in the preview must never flash white.
  fullscreen: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 32, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: "900" as const },
  permSub: { color: theme.textMuted, fontSize: 14, textAlign: "center", lineHeight: 20, marginBottom: 4 },
  permCancel: { color: theme.textMuted, fontSize: 14, fontWeight: "600" as const },

  previewZone: { position: "absolute", top: 0, left: 0, zIndex: 5 },

  segBar: { position: "absolute", left: 12, right: 12, height: 4, backgroundColor: "rgba(255,255,255,0.28)", zIndex: 11 },
  segFill: { position: "absolute", top: 0, bottom: 0, backgroundColor: theme.accent },
  segFillLive: { opacity: 0.9 },
  // A notch (a white gap) at the start of each segment after the first.
  segNotch: { borderLeftWidth: 2, borderLeftColor: "#fff" },

  closeWrap: { position: "absolute", left: 14, zIndex: 10 },
  toolColumn: { position: "absolute", right: 14, gap: 12, alignItems: "center", zIndex: 10 },
  toolBtn: {
    width: TOOL_SIZE,
    height: TOOL_SIZE,
    borderRadius: TOOL_SIZE / 2,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },

  hintWrap: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 5 },
  hintText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 6,
  },

  recTimerWrap: { position: "absolute", left: 0, right: 0, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6, zIndex: 10 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.danger },
  recTimerText: { color: "#fff", fontSize: 12, fontWeight: "900" as const, letterSpacing: 1.2 },

  bottomRow: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 28,
    zIndex: 12,
  },
  sideSlot: { width: 64, height: RECORD_TOUCH, alignItems: "center", justifyContent: "center" },
  sideBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  nextBtn: { backgroundColor: theme.accent, borderColor: theme.accent },
  sideBtnDisabled: { opacity: 0.4 },

  recordTouch: { width: RECORD_TOUCH, height: RECORD_TOUCH, alignItems: "center", justifyContent: "center" },
  recordRing: {
    width: RECORD_SIZE + 8,
    height: RECORD_SIZE + 8,
    borderRadius: (RECORD_SIZE + 8) / 2,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  recordDisc: { width: RECORD_SIZE - 12, height: RECORD_SIZE - 12, borderRadius: (RECORD_SIZE - 12) / 2, backgroundColor: "#fff" },
  recordDiscRecording: { backgroundColor: theme.danger },

  errorWrap: { position: "absolute", left: 24, right: 24, alignItems: "center", zIndex: 12 },
  cameraErrorText: { color: theme.danger, fontSize: 12, fontWeight: "600" as const, textAlign: "center", textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6 },

  zoomBarWrap: { position: "absolute", right: 16, top: 0, bottom: 0, justifyContent: "center", alignItems: "center", gap: 8, zIndex: 9 },
  zoomBarTrack: { width: 4, height: 132, backgroundColor: "rgba(255,255,255,0.18)", overflow: "hidden" },
  zoomBarFill: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: theme.accent },
  zoomBarLabel: { color: "#fff", fontSize: 11, fontWeight: "700" as const, fontVariant: ["tabular-nums"], textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 4 },

  cameraErrorBanner: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.85)", padding: 32 },
  cameraErrorBannerText: { color: theme.danger, fontSize: 14, fontWeight: "600" as const, textAlign: "center", lineHeight: 20 },
});
