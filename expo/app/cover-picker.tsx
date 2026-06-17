import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { getThumbnailAsync } from "expo-video-thumbnails";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import { ArrowLeft, Check } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { coverState } from "@/lib/coverState";

const { width: SCREEN_W } = Dimensions.get("window");
const ASPECT = 9 / 16;
const THUMB_PREVIEW_H = 160;
const SCRUBBER_H_PAD = 16;
const TRACK_HEIGHT = 38;

function triggerHaptic(style: Haptics.ImpactFeedbackStyle) {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(style).catch(() => {});
  }
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function CoverPickerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    // Screen mounted
  }, []);
  const {
    videoUri,
    totalDurationMs: totalDurationMsParam,
    mode,
  } = useLocalSearchParams<{
    videoUri: string;
    totalDurationMs: string;
    mode: "save-draft" | "publish";
  }>();

  const totalDurationMs = Number(totalDurationMsParam ?? "0");
  const videoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(totalDurationMs);
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [thumbTimeMs, setThumbTimeMs] = useState<number | null>(null);
  const [trackWidth, setTrackWidth] = useState(SCREEN_W - SCRUBBER_H_PAD * 2);
  const trackWidthRef = useRef(trackWidth);
  const lastGenRef = useRef<number>(0);
  const genTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef(totalDurationMs);
  const isScrubbingRef = useRef(false);

  useEffect(() => {
    positionRef.current = positionMs;
  }, [positionMs]);

  useEffect(() => {
    durationRef.current = durationMs;
  }, [durationMs]);

  useEffect(() => {
    trackWidthRef.current = trackWidth;
  }, [trackWidth]);

  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  const indicatorLeft = trackWidth * progress;

  // ── Thumbnail generation ─────────────────────────────────────────────────

  const generateAtTime = useCallback(
    async (timeMs: number) => {
      if (!videoUri || timeMs < 0) return;
      lastGenRef.current = timeMs;
      try {
        const result = await getThumbnailAsync(videoUri, { time: timeMs });
        const generatedUri = result.uri;
        const permanentDir = `${FileSystem.documentDirectory}thumbnails/`;
        await FileSystem.makeDirectoryAsync(permanentDir, { intermediates: true });
        const permanentUri = `${permanentDir}cover_${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: generatedUri, to: permanentUri });
        if (lastGenRef.current === timeMs) {
          setPreviewUri(permanentUri);
          setThumbUri(permanentUri);
          setThumbTimeMs(timeMs);
        }
      } catch (e) {
        console.warn("[cover-picker] thumbnail gen failed", e);
      }
    },
    [videoUri],
  );

  const debouncedGenerate = useCallback(
    (timeMs: number) => {
      if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current);
      genTimeoutRef.current = setTimeout(() => {
        generateAtTime(timeMs);
      }, 150);
    },
    [generateAtTime],
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current);
    };
  }, []);

  // ── Video status ─────────────────────────────────────────────────────────

  const handlePlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      if (
        typeof status.durationMillis === "number" &&
        status.durationMillis > 0
      ) {
        setDurationMs(status.durationMillis);
      }
      if (typeof status.positionMillis === "number") {
        setPositionMs(status.positionMillis);
      }
      if (status.didJustFinish) {
        setIsPlaying(false);
      }
    },
    [],
  );

  // ── Seek helper ──────────────────────────────────────────────────────────

  const seekToRatio = useCallback(
    async (ratio: number) => {
      const clamped = Math.max(0, Math.min(1, ratio));
      const timeMs = clamped * durationRef.current;
      try {
        await videoRef.current?.setPositionAsync(timeMs);
        setPositionMs(timeMs);
      } catch {
        // seek may fail on web or certain codecs — ignore
      }
      return timeMs;
    },
    [],
  );

  // ── Drag-to-scrub PanResponder ───────────────────────────────────────────

  const lastScrubRatioRef = useRef(0);

  const scrubPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        isScrubbingRef.current = true;
        if (isPlaying) {
          videoRef.current?.pauseAsync().catch(() => {});
          setIsPlaying(false);
        }
        const tw = trackWidthRef.current || 1;
        const x = evt.nativeEvent.locationX;
        const ratio = Math.max(0, Math.min(1, x / tw));
        lastScrubRatioRef.current = ratio;
        seekToRatio(ratio);
        triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (evt) => {
        const tw = trackWidthRef.current || 1;
        const x = evt.nativeEvent.locationX;
        const ratio = Math.max(0, Math.min(1, x / tw));
        lastScrubRatioRef.current = ratio;
        const timeMs = ratio * durationRef.current;
        setPositionMs(timeMs);
        debouncedGenerate(timeMs);
      },
      onPanResponderRelease: () => {
        isScrubbingRef.current = false;
        const timeMs = lastScrubRatioRef.current * durationRef.current;
        // Final seek to exact position
        seekToRatio(lastScrubRatioRef.current);
        // Generate final thumbnail at release position
        generateAtTime(timeMs);
      },
      onPanResponderTerminate: () => {
        isScrubbingRef.current = false;
      },
    }),
  ).current;

  // ── Play / Pause ─────────────────────────────────────────────────────────

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      videoRef.current?.pauseAsync().catch(() => {});
      setIsPlaying(false);
      // Generate thumbnail at pause position
      generateAtTime(positionRef.current);
    } else {
      videoRef.current?.playAsync().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, generateAtTime]);

  // ── Confirm cover ────────────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    setIsGenerating(true);
    try {
      let finalUri = thumbUri;
      let finalTime = thumbTimeMs;

      if (!finalUri || finalTime !== Math.round(positionMs)) {
        await generateAtTime(positionMs);
        // Wait for async gen to settle
        await new Promise((r) => setTimeout(r, 350));
        finalUri = previewUri ?? thumbUri;
        finalTime = positionMs;
      }

      if (!finalUri) {
        alert("Could not generate cover image. Try scrubbing to a different frame.");
        return;
      }

      triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
      coverState.resultThumbnailUri = finalUri;
      coverState.resultThumbnailMs = finalTime;
      router.back();
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, [thumbUri, thumbTimeMs, positionMs, previewUri, generateAtTime, router]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  // ── Preview area ─────────────────────────────────────────────────────────

  const previewH = useMemo(() => SCREEN_W * ASPECT, []);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />

      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
        <Pressable
          onPress={handleBack}
          style={styles.topBtn}
          hitSlop={12}
          accessibilityLabel="Back"
        >
          <ArrowLeft color="#fff" size={20} />
        </Pressable>
        <Text style={styles.topTitle}>Choose cover</Text>
        <View style={styles.topSpacer} />
      </View>

      {/* ── Video preview ── */}
      <View style={styles.previewWrap}>
        <View style={[styles.previewFrame, { height: previewH }]}>
          {videoUri ? (
            <Video
              ref={videoRef}
              source={{ uri: videoUri }}
              style={StyleSheet.absoluteFill}
              resizeMode={ResizeMode.CONTAIN}
              isLooping
              shouldPlay={isPlaying}
              isMuted={false}
              useNativeControls={false}
              progressUpdateIntervalMillis={100}
              onPlaybackStatusUpdate={handlePlaybackStatus}
            />
          ) : (
            <View style={styles.previewPlaceholder}>
              <Text style={styles.placeholderText}>No video</Text>
            </View>
          )}

          {/* Play/pause tap area */}
          <Pressable style={StyleSheet.absoluteFill} onPress={handlePlayPause}>
            {!isPlaying && (
              <View style={styles.playOverlay}>
                <View style={styles.playCircle}>
                  <Text style={styles.playIcon}>▶</Text>
                </View>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {/* ── Cover thumbnail preview ── */}
      <View style={styles.thumbSection}>
        <Text style={styles.thumbLabel}>Cover preview</Text>
        <View style={styles.thumbFrame}>
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={80}
            />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Text style={styles.thumbHintText}>
                Scrub the timeline to choose a cover
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Scrubber ── */}
      <View style={styles.scrubberSection}>
        {/* Track */}
        <View
          style={styles.scrubTrackOuter}
          onLayout={(e) => {
            setTrackWidth(e.nativeEvent.layout.width);
          }}
          {...scrubPan.panHandlers}
        >
          {/* Background bar */}
          <View style={styles.scrubTrackBg} />
          {/* Filled progress */}
          <View
            style={[
              styles.scrubProgress,
              { width: trackWidth > 0 ? indicatorLeft : 0 },
            ]}
          />
          {/* Blue indicator line */}
          <View
            style={[
              styles.indicatorLine,
              {
                left: trackWidth > 0 ? indicatorLeft - 1 : -1,
              },
            ]}
            pointerEvents="none"
          />
        </View>

        {/* Time labels */}
        <View style={styles.timeRow}>
          <Text style={styles.timeLabel}>{formatTime(positionMs)}</Text>
          <Text style={styles.timeLabel}>{formatTime(durationMs)}</Text>
        </View>
      </View>

      {/* ── Action button ── */}
      <View
        style={[styles.actionSection, { paddingBottom: insets.bottom + 16 }]}
      >
        <Pressable
          onPress={handleConfirm}
          style={styles.confirmBtn}
          disabled={isGenerating}
        >
          {isGenerating ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Check color="#fff" size={18} strokeWidth={2.5} />
              <Text style={styles.confirmBtnText}>Set Cover</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#08080B",
  },

  // ── Top bar ──
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 6,
    backgroundColor: "#08080B",
  },
  topBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  topTitle: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 15,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },
  topSpacer: {
    width: 38,
  },

  // ── Video preview ──
  previewWrap: {
    paddingHorizontal: 8,
    marginBottom: 16,
  },
  previewFrame: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#0D0D12",
  },
  previewPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 14,
    fontWeight: "600" as const,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  playCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  playIcon: {
    color: "#fff",
    fontSize: 20,
    marginLeft: 3,
  },

  // ── Thumbnail preview ──
  thumbSection: {
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  thumbLabel: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.3,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  thumbFrame: {
    height: THUMB_PREVIEW_H,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#0D0D12",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  thumbPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  thumbHintText: {
    color: "rgba(255,255,255,0.25)",
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center",
    lineHeight: 18,
  },

  // ── Scrubber ──
  scrubberSection: {
    paddingHorizontal: SCRUBBER_H_PAD,
    gap: 6,
  },
  scrubTrackOuter: {
    height: TRACK_HEIGHT,
    justifyContent: "center",
  },
  scrubTrackBg: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  scrubProgress: {
    position: "absolute",
    top: (TRACK_HEIGHT - 3) / 2,
    height: 3,
    borderTopLeftRadius: 1.5,
    borderBottomLeftRadius: 1.5,
    backgroundColor: theme.accent,
    opacity: 0.4,
  },
  indicatorLine: {
    position: "absolute",
    top: (TRACK_HEIGHT - 24) / 2,
    width: 2,
    height: 24,
    borderRadius: 1,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 4,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timeLabel: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 11,
    fontWeight: "600" as const,
    fontVariant: ["tabular-nums"] as const,
    letterSpacing: 0.2,
  },

  // ── Action ──
  actionSection: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 4,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },
});
