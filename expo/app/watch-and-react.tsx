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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import * as Haptics from "expo-haptics";
import { ArrowLeft, Play, RotateCcw, VideoIcon } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { supabase } from "@/lib/supabase";

const { width: SCREEN_W } = Dimensions.get("window");
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

  // ── Parent post data ──────────────────────────────────────────────────────
  const [post, setPost] = useState<{
    id: string;
    media_url: string;
    media_type: string;
    caption: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Parent video playback ─────────────────────────────────────────────────
  const parentVideoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [hasFinished, setHasFinished] = useState(false);
  const isPlayingRef = useRef(true);
  const scrubTrackWidthRef = useRef(SCREEN_W);
  const parentStartedFromBeginning = useRef(false);
  /** Capture parent duration for passing to camera/edit as originalDurationMs */
  const parentDurationMsRef = useRef(0);

  // ── Fetch parent post ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!postId) {
      setLoadError("No post specified.");
      setLoading(false);
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
        } else {
          setPost(data as {
            id: string;
            media_url: string;
            media_type: string;
            caption: string | null;
          });
        }
        setLoading(false);
      });
  }, [postId]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      parentVideoRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // ── Restart parent clip from beginning on first mount ─────────────────────
  useEffect(() => {
    if (!loading && post && !parentStartedFromBeginning.current) {
      parentStartedFromBeginning.current = true;
      const t = setTimeout(() => {
        parentVideoRef.current?.setPositionAsync(0).catch(() => {});
        parentVideoRef.current?.playAsync().catch(() => {});
        setIsPlaying(true);
        isPlayingRef.current = true;
        setHasFinished(false);
      }, 100);
      return () => clearTimeout(t);
    }
  }, [loading, post]);

  // ── Playback status updates ──────────────────────────────────────────────
  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    setPositionMs(status.positionMillis);
    if (status.durationMillis && status.durationMillis > 0) {
      setDurationMs(status.durationMillis);
      parentDurationMsRef.current = status.durationMillis;
    }
    if (status.didJustFinish) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      setHasFinished(true);
    }
  }, []);

  // ── Toggle play/pause ─────────────────────────────────────────────────────
  const togglePlayback = useCallback(() => {
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
  }, [hasFinished]);

  // ── Replay ────────────────────────────────────────────────────────────────
  const handleReplay = useCallback(() => {
    parentVideoRef.current?.setPositionAsync(0).then(() => {
      parentVideoRef.current?.playAsync().catch(() => {});
    }).catch(() => {});
    setHasFinished(false);
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPositionMs(0);
  }, []);

  // ── Scrub ─────────────────────────────────────────────────────────────────
  const handleScrub = useCallback((x: number) => {
    if (durationMs <= 0) return;
    const pct = Math.max(0, Math.min(1, x / (scrubTrackWidthRef.current || SCREEN_W)));
    const targetMs = Math.round(pct * durationMs);
    setPositionMs(targetMs);
    parentVideoRef.current?.setPositionAsync(targetMs).catch(() => {});
    setHasFinished(false);
  }, [durationMs]);

  const scrubPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          handleScrub(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => {
          handleScrub(e.nativeEvent.locationX);
        },
      }),
    [handleScrub],
  );

  const progressPct = durationMs > 0 ? positionMs / durationMs : 0;

  // ── Record Reaction → navigate to camera with reaction context ────────────
  const handleRecordReaction = useCallback(() => {
    if (!postId) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    parentVideoRef.current?.pauseAsync().catch(() => {});
    router.push({
      pathname: "/camera",
      params: {
        reactingTo: postId,
      },
    });
  }, [postId, router]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
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
        <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden />

      {/* ── Parent clip playback ────────────────────────────────────────── */}
      {post.media_type === "video" ? (
        <Video
          ref={parentVideoRef}
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

      {/* ── Top bar: back button ────────────────────────────────────────── */}
      <SafeAreaView edges={["top"]} style={styles.topSafe}>
        <Pressable
          onPress={() => {
            parentVideoRef.current?.unloadAsync().catch(() => {});
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace("/(tabs)");
            }
          }}
          style={styles.iconBtn}
          hitSlop={8}
          accessibilityLabel="Go back"
        >
          <ArrowLeft color="#fff" size={20} strokeWidth={2.5} />
        </Pressable>
      </SafeAreaView>

      {/* ── Center play/pause overlay ────────────────────────────────────── */}
      {(!isPlaying || hasFinished) && (
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

      {/* ── Bottom controls ──────────────────────────────────────────────── */}
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

        {/* Record Reaction button */}
        <Pressable
          onPress={handleRecordReaction}
          style={({ pressed }) => [
            styles.recordBtn,
            pressed && { opacity: 0.8 },
          ]}
          accessibilityLabel="Record a reaction"
        >
          <VideoIcon size={18} color="#fff" strokeWidth={2.5} />
          <Text style={styles.recordBtnText}>Record Reaction</Text>
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

  /* Record Reaction button */
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  recordBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800" as const,
    letterSpacing: 0.3,
  },
});
