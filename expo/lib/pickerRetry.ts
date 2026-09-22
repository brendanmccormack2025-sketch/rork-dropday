import * as ImagePicker from "expo-image-picker";

/**
 * Detects iCloud download failures surfaced by the Photos framework.
 * PHPhotosErrorDomain 3169 (NETWORK_ERROR) fires when a large iCloud-hosted
 * asset can't be fetched within the framework's internal download window;
 * sibling codes (3164 NETWORK_ACCESS_REQUIRED, etc.) can ride the same path.
 */
function isNetworkDownloadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /3169|network\s*error|networkerror/i.test(msg);
}

/**
 * launchImageLibraryAsync with one automatic retry for iCloud download
 * network failures. Large assets intermittently fail with
 * PHPhotosErrorDomain 3169 partway through the download; a single retry
 * after a short pause usually succeeds. Any other error (or a second
 * consecutive network failure) is rethrown to the caller.
 */
export async function launchLibraryWithRetry(
  options: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerResult> {
  try {
    return await ImagePicker.launchImageLibraryAsync(options);
  } catch (e) {
    if (!isNetworkDownloadError(e)) throw e;
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      return await ImagePicker.launchImageLibraryAsync(options);
    } catch {
      throw new Error(
        "Couldn't download the media from iCloud. Check your connection and try again.",
      );
    }
  }
}
