import React, { useEffect, useState } from "react";
import { Dimensions, Modal, Pressable, StyleSheet, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import CaptionPreview from "@/components/CaptionPreview";
import FeedChromeReplica from "@/components/FeedChromeReplica";
import { FeedTextOverlay } from "@/components/FeedItem";
import type { CaptionStyle } from "@/lib/editModel";
import { VIDEO_ASPECT, computeCoverCrop } from "@/lib/feedLayout";
import type { EditorCaptionLine } from "@/lib/transcription/captionLines";
import type { TextOverlay } from "@/providers/PostsProvider";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const noop = () => {};

/**
 * Full-screen playback of the current edit as the feed shows it: the preview render, filled to the
 * screen the way the feed fills it, with the caption and text overlays drawn over it and a
 * non-interactive copy of the feed's chrome. Closing returns to the editor untouched.
 */
export default function EditPreviewModal({
  visible,
  uri,
  onClose,
  captionLines,
  captionStyle,
  textOverlays,
  username,
}: {
  visible: boolean;
  uri: string | null;
  onClose: () => void;
  captionLines: EditorCaptionLine[] | null;
  captionStyle: CaptionStyle | null;
  textOverlays: TextOverlay[];
  username: string;
}) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.timeUpdateEventInterval = 0.05;
  });
  const [positionMs, setPositionMs] = useState(0);

  useEffect(() => {
    const sub = player.addListener("timeUpdate", (e) => setPositionMs(Math.round(e.currentTime * 1000)));
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    if (visible && uri) {
      player.replace({ uri });
      player.currentTime = 0;
      player.muted = false;
      player.play();
    } else {
      player.pause();
      player.replace(null);
    }
  }, [visible, uri, player]);

  const crop = computeCoverCrop(SCREEN_W, SCREEN_H, VIDEO_ASPECT);
  const videoW = SCREEN_W / crop.visibleW;
  const videoH = SCREEN_H / crop.visibleH;

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.screen}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} pointerEvents="none" />

        {captionLines && captionLines.length > 0 && (
          <View pointerEvents="none" style={styles.clip}>
            <View style={{ position: "absolute", left: -crop.cropLeft * videoW, top: -crop.cropTop * videoH, width: videoW, height: videoH }}>
              <CaptionPreview
                lines={captionLines}
                positionMs={positionMs}
                frameW={videoW}
                frameH={videoH}
                invisible={false}
                style={captionStyle}
                isPlaying
                selected={false}
                onSelectedChange={noop}
                onEditStart={noop}
                onEdit={noop}
              />
            </View>
          </View>
        )}

        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {textOverlays.map((ov) => (
            <FeedTextOverlay key={ov.id} overlay={ov} containerW={SCREEN_W} containerH={SCREEN_H} />
          ))}
        </View>

        <FeedChromeReplica username={username} />

        <Pressable
          onPress={onClose}
          style={[styles.close, { top: insets.top + 56 }]}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close preview"
        >
          <X color="#fff" size={20} strokeWidth={2.5} />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  clip: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  close: {
    position: "absolute",
    left: 18,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
});
