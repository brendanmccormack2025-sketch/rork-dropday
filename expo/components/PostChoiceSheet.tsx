import React, { useCallback, useEffect, useRef, useState } from "react";
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
import ArrangeClips from "@/components/ArrangeClips";
import { MAX_VIDEO_SECONDS } from "@/hooks/useCameraRecorder";
import { MAX_IMPORT_VIDEOS, validateSelection, type ImportClip } from "@/lib/importSelection";
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import { PICKER_ERROR_MESSAGES, classifyPickerError } from "@/lib/pickerErrors";

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
  const [isRetrying, setIsRetrying] = useState<number>(0);
  // Several videos picked: the "Arrange" step (order them) comes before the editor.
  const [arranging, setArranging] = useState<ImportClip[] | null>(null);

  const openCamera = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onClose();
    router.push("/camera");
  }, [onClose, router]);

  // The error alert's "Try again" reopens the picker.
  const openLibraryRef = useRef<(photoCompatible?: boolean) => void>(() => {});

  // photoCompatible: the retry after an unreadable photo. Only photos are offered and
  // iOS converts them to a readable (JPEG) representation; video options are untouched.
  // Cancel while "Getting your video..." is showing: the native pick cannot be
  // aborted, so its result is ignored. pendingRef stops a new pick until it ends.
  const cancelledRef = useRef(false);
  const pendingRef = useRef(false);

  const openLibrary = useCallback(async (photoCompatible?: boolean) => {
    if (isPicking || pendingRef.current) return;
    cancelledRef.current = false;
    pendingRef.current = true;
    setIsPicking(true);
    setIsRetrying(0);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photo library access needed",
          "Allow access to your photo library to import a photo or video for your post.",
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

      const result = await launchLibraryWithRetry({
        mediaTypes: photoCompatible ? ["images"] : ["images", "videos"],
        ...(photoCompatible
          ? {
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
            }
          : {}),
        // Several videos can be combined (in the order they were picked); a photo stays a single pick.
        allowsMultipleSelection: !photoCompatible,
        ...(photoCompatible ? {} : { orderedSelection: true, selectionLimit: MAX_IMPORT_VIDEOS }),
        quality: 1,
        videoMaxDuration: MAX_VIDEO_SECONDS,
        // Without this, iCloud-hosted assets fail with PHPhotosErrorDomain 3164
        // (NETWORK_ACCESS_REQUIRED) — the native default is false.
        shouldDownloadFromNetwork: true,
      }, (attempt) => setIsRetrying(attempt));
      if (cancelledRef.current || result.canceled || result.assets.length === 0) return;

      // One photo or video as before, or several videos in the order they were picked. The total length of
      // the videos must fit the same limit as one recording (expo-image-picker durations are milliseconds).
      const checked = validateSelection(result.assets, MAX_VIDEO_SECONDS * 1000, newClipId);
      if (!checked.ok) {
        Alert.alert(checked.title, checked.message);
        return;
      }
      if (checked.kind === "multi") {
        setArranging(checked.clips);
        return;
      }
      const clip: PickedClip = checked.clips[0]!;

      onClose();
      router.push({
        pathname: "/edit",
        params: { clips: JSON.stringify([clip]) },
      });
    } catch (e) {
      if (__DEV__) console.log("[PostChoiceSheet] picker error:", e);
      const kind = classifyPickerError(e);
      if (kind === "cancelled" || cancelledRef.current) return;
      const buttons =
        kind === "no_permission"
          ? [
              { text: "Cancel", style: "cancel" as const },
              {
                text: "Open Settings",
                onPress: () => {
                  if (Platform.OS === "ios") Linking.openURL("app-settings:").catch(() => {});
                  else Linking.openSettings().catch(() => {});
                },
              },
            ]
          : [
              { text: "Cancel", style: "cancel" as const },
              {
                text: "Try again",
                onPress: () => openLibraryRef.current(kind === "unreadable_photo"),
              },
            ];
      Alert.alert("Library", PICKER_ERROR_MESSAGES[kind], buttons);
    } finally {
      pendingRef.current = false;
      setIsPicking(false);
      setIsRetrying(0);
    }
  }, [isPicking, onClose, router]);
  openLibraryRef.current = openLibrary;

  useEffect(() => {
    if (!visible) setArranging(null);
  }, [visible]);

  const finishArranging = useCallback(() => {
    const list = arranging;
    setArranging(null);
    if (!list || list.length === 0) return;
    onClose();
    router.push({ pathname: "/edit", params: { clips: JSON.stringify(list) } });
  }, [arranging, onClose, router]);

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
          {arranging ? (
            <ArrangeClips clips={arranging} onChange={setArranging} onContinue={finishArranging} onBack={() => setArranging(null)} />
          ) : (
          <>
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
              <UiText style={styles.optionSubtitle}>Record a new post</UiText>
            </View>
          </Pressable>

          <Pressable
            onPress={() => openLibrary()}
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
                {isPicking
                  ? isRetrying >= 3
                    ? "Almost there…"
                    : isRetrying >= 2
                    ? "Still downloading, trying again…"
                    : "Downloading from iCloud…"
                  : "Choose a photo, or up to 10 videos to combine"}
              </UiText>
            </View>
          </Pressable>

          {isPicking && (
            <View style={styles.gettingOverlay}>
              <ActivityIndicator color={theme.accent} />
              <UiText weight={700} style={styles.gettingText}>
                Getting your video...
              </UiText>
              <Pressable
                onPress={() => {
                  cancelledRef.current = true;
                  setIsPicking(false);
                  setIsRetrying(0);
                }}
                hitSlop={10}
              >
                <UiText weight={700} style={styles.cancelText}>
                  Cancel
                </UiText>
              </Pressable>
            </View>
          )}

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
          </>
          )}
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
  gettingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    backgroundColor: theme.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  gettingText: {
    fontSize: 16,
    color: theme.text,
  },
  cancelText: {
    fontSize: 15,
    color: theme.textDim,
  },
});
