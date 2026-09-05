import { useCallback, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { Alert, Linking, Platform } from "react-native";
import { type DraftClip } from "@/providers/PostsProvider";

/** Default duration for photo clips (3 seconds) */
export const DEFAULT_PHOTO_DURATION_MS = 3000;

function newClipId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface MediaPickerResult {
  clips: DraftClip[];
  /** True when the user cancelled the picker */
  cancelled: boolean;
}

export function useMediaPicker() {
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState("");

  const pickFromCameraRoll = useCallback(async (): Promise<MediaPickerResult> => {
    setIsLoading(true);
    setProgress("");

    try {
      // Pre-flight permission check — iOS needs explicit permission for
      // video passthrough exports before the picker opens.
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Media Library Access",
          "DropDay needs access to your photo library to import media. You can grant this in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                if (Platform.OS === "ios") {
                  Linking.openURL("app-settings:");
                } else {
                  Linking.openSettings();
                }
              },
            },
          ],
        );
        setIsLoading(false);
        return { clips: [], cancelled: true };
      }

      setProgress("Opening library…");

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: true,
        quality: 1,
        // Passthrough preserves original quality for videos
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        // Request EXIF metadata so we get accurate durations
        exif: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        setIsLoading(false);
        return { clips: [], cancelled: true };
      }

      const assetCount = result.assets.length;
      setProgress(`Processing ${assetCount} item${assetCount > 1 ? "s" : ""}…`);

      const clips: DraftClip[] = result.assets.map((asset) => {
        const isVideo =
          (asset as { type?: string }).type === "video" ||
          asset.uri.toLowerCase().endsWith(".mp4") ||
          asset.uri.toLowerCase().endsWith(".mov");

        // expo-image-picker returns duration in seconds for videos
        const durationSec = (asset as { duration?: number }).duration;
        const durationMs =
          isVideo && durationSec != null
            ? Math.round(durationSec * 1000)
            : DEFAULT_PHOTO_DURATION_MS;

        return {
          id: newClipId(),
          uri: asset.uri,
          type: isVideo ? "video" : "image",
          durationMs,
          trimStartMs: 0,
          trimEndMs: durationMs,
        };
      });

      setIsLoading(false);
      setProgress("");
      return { clips, cancelled: false };
    } catch (err) {
      setIsLoading(false);
      setProgress("");
      const message =
        err instanceof Error ? err.message : "Could not access media library.";
      Alert.alert("Import Failed", message);
      return { clips: [], cancelled: true };
    }
  }, []);

  return { pickFromCameraRoll, isLoading, progress };
}
