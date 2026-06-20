import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { ArrowLeft, Play, Pause, RotateCcw, ArrowRight } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { supabase } from "@/lib/supabase";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const SCRUB_BAR_HEIGHT = 40;

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function WatchAndReactScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { postId } = useLocalSearchParams<{ postId: string }>();

  const [post, setPost] = useState<{
    media_url: string;
    media_type: string;
    caption: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Playback
  const videoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [hasFinished, setHasFinished] = useState(false);
  const isPlayingRef = useRef(true);
  const scrubTrackWidthRef = useRef(SCREEN_W);

  // ── Fetch post ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!postId) {
      setFetchError("No post specified.");
      setLoading(false);
      return;
    }
    supabase
      .from("posts")
      .select("media_url, media_type, caption")
      .eq("id", postId)
      .single()
      .then(({ data, error }) => {
        if (error) {
          console.error("[watch-and-react] Failed to fetch post:", error.message);
          setFetchError("Could not load this clip.");
        } else if (data) {
          setPost(data as { media_url: string; media_type: string; caption: string | null });
        }
        setLoading(false);
      });
  }, [postId]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // ── Playback status ────────────────────────────────────────────────────
  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    setPositionMs(status.positionMillis);
    if (status.durationMillis && status.durationMillis > 0) {
      setDurationMs(status.durationMillis);
    }
    if (status.didJustFinish) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      setHasFinished(true);
    }
  }, []);

  // ── Toggle play/pause ──────────────────────────────────────────────────
  const togglePlayback = useCallback(() => {
    if (hasFinished) {
      // Restart from beginning
      videoRef.current?.setPositionAsync(0).then(() => {
        videoRef.current?.playAsync().catch(() => {});
      }).catch(() => {});
      setHasFinished(false);
      setIsPlaying(true);
      isPlayingRef.current = true;
      setPositionMs(0);
      return;
    }
    if (isPlayingRef.current) {
      videoRef.current?.pauseAsync().catch(() => {});
      setIsPlaying(false);
      isPlayingRef.current = false;
    } else {
      videoRef.current?.playAsync().catch(() => {});
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  }, [hasFinished]);

  // ── Replay ─────────────────────────────────────────────────────────────
  const handleReplay = useCallback(() => {
    videoRef.current?.setPositionAsync(0).then(() => {
      videoRef.current?.playAsync().catch(() => {});
    }).catch(() => {});
    setHasFinished(false);
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPositionMs(0);
  }, []);

  // ── Scrub ──────────────────────────────────────────────────────────────
  const handleScrub = useCallback((x: number) => {
    if (durationMs <= 0) return;
    const pct = Math.max(0, Math.min(1, x / (scrubTrackWidthRef.current || SCREEN_W)));
    const targetMs = Math.round(pct * durationMs);
    setPositionMs(targetMs);
    videoRef.current?.setPositionAsync(targetMs).catch(() => {});
    setHasFinished(false);
  }, [durationMs]);

  const scrubPan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      handleScrub(e.nativeEvent.locationX);
    },
    onPanResponderMove: (e) => {
      handleScrub(e.nativeEvent.locationX);
    },
  });

  const progressPct = durationMs > 0 ? positionMs / durationMs : 0;

  // ── Start Reacting ─────────────────────────────────────────────────────
  const handleStartReacting = useCallback(() => {
    // Pause the video before navigating so audio doesn't bleed
    videoRef.current?.pauseAsync().catch(() => {});
    router.push(`/camera?reactingTo=${postId}` as never);
  }, [postId, router]);

  // ── Loading / error states ──────────────────────────────────────────────
  if (loading) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.loadingText}>Loading clip…</Text>
      </View>
    );
  }

  if (fetchError || !post) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <StatusBar style="light" />
        <Text style={styles.errorText}>{fetchError ?? "Clip not found."}</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden />

      {/* ── Full-screen video ────────────────────────────────────────── */}
      <Pressable style={StyleSheet.absoluteFill} onPress={togglePlayback}>
        {post.media_type === "video" ? (
          <Video
            ref={videoRef}
            source={{ uri: post.media_url }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={isPlaying}
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
      </Pressable>

      {/* ── Top bar: back button ─────────────────────────────────────── */}
      <SafeAreaView edges={["top"]} style={styles.topSafe}>
        <Pressable
          onPress={() => {
            videoRef.current?.unloadAsync().catch(() => {});
            router.back();
          }}
          style={styles.iconBtn}
          hitSlop={8}
          accessibilityLabel="Go back"
        >
          <ArrowLeft color="#fff" size={20} strokeWidth={2.5} />
        </Pressable>
      </SafeAreaView>

      {/* ── Center play/pause overlay ─────────────────────────────────── */}
      {(!isPlaying || hasFinished) && (
        <Pressable
          onPress={togglePlayback}
          style={styles.centerOverlay}
        >
          <View style={styles.playCircleLarge}>
            {hasFinished ? (
              <RotateCcw size={32} color="#fff" strokeWidth={2} />
            ) : (
              <Play size={32} color="#fff" fill="#fff" style={{ left: 2 }} />
            )}
          </View>
        </Pressable>
      )}

      {/* ── Bottom controls ───────────────────────────────────────────── */}
      <View
        style={[styles.bottomSection, { paddingBottom: insets.bottom + 12 }]}
        pointerEvents="box-none"
      >
        {/* Caption */}
        {post.caption ? (
          <Text style={styles.caption} numberOfLines={2}>
            {post.caption}
          </Text>
        ) : null}

        {/* Scrub bar */}
        <View style={styles.scrubRow}>
          <Text style={styles.timeLabel}>{formatTime(positionMs)}</Text>
          <View
            style={styles.scrubTrack}
            onLayout={(e) => {
              scrubTrackWidthRef.current = e.nativeEvent.layout.width;
            }}
            {...scrubPan.panHandlers}
          >
            {/* Track background */}
            <View style={styles.scrubTrackBg} />
            {/* Progress fill */}
            <View
              style={[
                styles.scrubTrackFill,
                { width: `${progressPct * 100}%` as any },
              ]}
            />
            {/* Thumb */}
            <View
              style={[
                styles.scrubThumb,
                { left: `${progressPct * 100}%` as any, marginLeft: -6 },
              ]}
            />
          </View>
          <Text style={styles.timeLabel}>{formatTime(durationMs)}</Text>
        </View>

        {/* Start Reacting button */}
        <Pressable
          onPress={handleStartReacting}
          style={({ pressed }) => [
            styles.reactBtn,
            pressed && styles.reactBtnPressed,
          ]}
        >
          <Text style={styles.reactBtnText}>Start Reacting</Text>
          <ArrowRight color="#fff" size={18} strokeWidth={2.5} />
        </Pressable>
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

  reactBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  reactBtnPressed: {
    opacity: 0.75,
  },
  reactBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
});
