import type { ImagePickerOptions } from "expo-image-picker";

/**
 * The ONE place that builds the options for opening the camera roll, used by the post picker (components/PostChoiceSheet.tsx) and the campaign
 * footage picker (lib/footageRuntime.ts), so they cannot drift apart again (the footage picker once left these out and iCloud videos failed with
 * PHPhotosErrorDomain 3164):
 *  - shouldDownloadFromNetwork: true. Without it an iCloud-hosted asset fails with NETWORK_ACCESS_REQUIRED (3164); the native default is false.
 *  - preferredAssetRepresentationMode "current": hand over the file exactly as it is in Photos. The default ("automatic") lets iOS convert an
 *    iPhone's HEVC video to H.264 first, which is slow for long clips; our compressor reads HEVC fine. A photo that failed to read is retried as
 *    "compatible" (photoCompatible).
 * Always open it with launchLibraryWithRetry (lib/pickerRetry.ts) and classify errors with lib/pickerErrors.ts.
 */
export type LibraryPickOptions = {
  /** only videos (the footage picker); otherwise photos and videos */
  videosOnly?: boolean;
  /** retry a photo that could not be read, as a compatible (JPEG) representation */
  photoCompatible?: boolean;
  /** several at once; with the most allowed */
  multiple?: { limit: number };
  videoMaxDuration?: number;
};

// (the values of ImagePicker.UIImagePickerPreferredAssetRepresentationMode; plain strings so this file can be tested without the native module)
const CURRENT = "current" as ImagePickerOptions["preferredAssetRepresentationMode"];
const COMPATIBLE = "compatible" as ImagePickerOptions["preferredAssetRepresentationMode"];

export function libraryPickerOptions(o: LibraryPickOptions = {}): ImagePickerOptions {
  const out: ImagePickerOptions = {
    mediaTypes: o.videosOnly ? ["videos"] : o.photoCompatible ? ["images"] : ["images", "videos"],
    preferredAssetRepresentationMode: o.photoCompatible ? COMPATIBLE : CURRENT,
    allowsMultipleSelection: !!o.multiple,
    quality: 1,
    shouldDownloadFromNetwork: true,
  };
  if (o.multiple) out.selectionLimit = o.multiple.limit;
  if (o.videoMaxDuration !== undefined) out.videoMaxDuration = o.videoMaxDuration;
  return out;
}
