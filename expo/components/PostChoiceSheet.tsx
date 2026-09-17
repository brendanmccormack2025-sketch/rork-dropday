import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Camera, Images, X } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { MAX_VIDEO_SECONDS } from "@/hooks/useCameraRecorder";

/** Mirrors the Clip shape the camera flow hands to /edit — same pipeline. */
type PickedClip = {
  id: string;
  uri: string;
  type: "image" | "video";
  durationMs?: number;
};

let clipSeq = 0;
function newClipId(): string {
  clipSeq += 1;
  return `clip-${Date.now()}-${clipSeq}`;
}

type PostChoiceSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export default function PostChoiceSheet({ visible, onClose }: PostChoiceSheetProps) {
  const router = useRouter();
  const [isPicking, setIsPicking] = useState<boolean>(false);

  const openCamera = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onClose();
    router.push("/camera");
  }, [onClose, router]);

  const openLibrary = useCallback(async () => {
    if (isPicking) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photo library access needed",
          "Allow access to your photo library to import a photo or video for your drop.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                if (Platform.OS === "ios") {
                  Linking.openURL("app-settings:").catch(() => {});
                } else {
                  Linking.openSettings().catch(() => {});
                }
              },
            },
          ],
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: false,
        quality: 1,
        videoMaxDuration: MAX_VIDEO_SECONDS,
      });
      if (result.canceled || result.assets.length === 0) return;

      const asset = result.assets[0];
      const isVideo = asset.type === "video";

      // Keep the editing pipeline identical to camera content: videos longer
      // than the camera's hard cap can't be produced by the recorder, so
      // reject them here instead of feeding /edit something new.
      if (isVideo && (asset.duration ?? 0) > MAX_VIDEO_SECONDS) {
        Alert.alert(
          "Video too long",
          `Clips can be up to ${MAX_VIDEO_SECONDS / 60} minutes. Trim the video in your photo library and try again.`,
        );
        return;
      }

      const clip: PickedClip = {
        id: newClipId(),
        uri: asset.uri,
        type: isVideo ? "video" : "image",
        ...(isVideo && asset.duration
          ? { durationMs: Math.round(asset.duration * 1000) }
          : {}),
      };

      onClose();
      router.push({
        pathname: "/edit",
        params: { clips: JSON.stringify([clip]) },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not open your library.";
      Alert.alert("Library", msg);
    } finally {
      setIsPicking(false);
    }
  }, [isPicking, onClose, router]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <UiText weight={800} style={styles.title}>
            Create
          </UiText>

          <Pressable
            onPress={openCamera}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
            android_ripple={null}
          >
            <View style={styles.optionIcon}>
              <Camera color={theme.accent} size={22} />
            </View>
            <View style={styles.optionCopy}>
              <UiText weight={700} style={styles.optionTitle}>
                Camera
              </UiText>
              <UiText style={styles.optionSubtitle}>Record a new drop</UiText>
            </View>
          </Pressable>

          <Pressable
            onPress={openLibrary}
            disabled={isPicking}
            style={({ pressed }) => [
              styles.option,
              pressed && styles.optionPressed,
              isPicking && styles.optionDisabled,
            ]}
            android_ripple={null}
          >
            <View style={styles.optionIcon}>
              {isPicking ? (
                <ActivityIndicator color={theme.accent} size="small" />
              ) : (
                <Images color={theme.accent} size={22} />
              )}
            </View>
            <View style={styles.optionCopy}>
              <UiText weight={700} style={styles.optionTitle}>
                Camera Roll
              </UiText>
              <UiText style={styles.optionSubtitle}>
                Choose a photo or video from your library
              </UiText>
            </View>
          </Pressable>

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.cancel, pressed && styles.optionPressed]}
            android_ripple={null}
          >
            <X color={theme.textDim} size={18} />
            <UiText weight={700} style={styles.cancelText}>
              Cancel
            </UiText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(10, 10, 10, 0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: theme.border,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginBottom: 14,
  },
  title: {
    fontSize: 20,
    color: theme.text,
    marginBottom: 14,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 10,
    minHeight: 64,
  },
  optionPressed: {
    opacity: 0.7,
  },
  optionDisabled: {
    opacity: 0.6,
  },
  optionIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  optionCopy: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    fontSize: 16,
    color: theme.text,
  },
  optionSubtitle: {
    fontSize: 13,
    color: theme.textDim,
  },
  cancel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 16,
    minHeight: 48,
  },
  cancelText: {
    fontSize: 15,
    color: theme.textDim,
  },
});
