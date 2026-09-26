import * as ImagePicker from "expo-image-picker";

/**
 * Detects iCloud download failures surfaced by the Photos framework.
 *
 * iOS reports the same class of iCloud-sync-timing failure under several
 * domains depending on OS version and which daemon surfaces the error:
 * - PHPhotosErrorDomain 3169 (NETWORK_ERROR) — large iCloud-hosted asset
 *   can't be fetched within the framework's internal download window.
 * - PHPhotosErrorDomain 3164 (NETWORK_ACCESS_REQUIRED).
 * - CloudPhotoLibraryErrorDomain (photolibraryd) — e.g. code 1005 on
 *   large videos still syncing to iCloud.
 *
 * The domains are matched as a whole (not per-code) because Apple adds
 * new sync-failure codes between releases; one wasted retry is cheaper
 * than a failed pick. The iCloud keyword also catches the same failures
 * when they surface as wrapped NSUnderlyingError descriptions instead.
 */
const ICLOUD_DOWNLOAD_ERROR_PATTERN =
  /PHPhotosErrorDomain|CloudPhotoLibraryErrorDomain|3169|3164|network\s*error|networkerror|\biCloud\b/i;

function isNetworkDownloadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return ICLOUD_DOWNLOAD_ERROR_PATTERN.test(msg);
}

/**
 * launchImageLibraryAsync with one automatic retry for iCloud download
 * failures (PHPhotosErrorDomain 3169/3164, CloudPhotoLibraryErrorDomain,
 * and similar sync-timing errors — see ICLOUD_DOWNLOAD_ERROR_PATTERN).
 * Large assets intermittently fail partway through the download; a single
 * retry after a short pause usually succeeds. Any other error (or a second
 * consecutive iCloud failure) is rethrown to the caller with a friendly
 * message.
 *
 * `onRetry` fires just before the second attempt starts so callers can
 * switch their loading copy to a "trying again" message. Purely cosmetic —
 * it does not affect the retry logic or timing.
 */
export async function launchLibraryWithRetry(
  options: ImagePicker.ImagePickerOptions,
  onRetry?: () => void,
): Promise<ImagePicker.ImagePickerResult> {
  try {
    return await ImagePicker.launchImageLibraryAsync(options);
  } catch (e) {
    if (!isNetworkDownloadError(e)) throw e;
    await new Promise((resolve) => setTimeout(resolve, 800));
    onRetry?.();
    try {
      return await ImagePicker.launchImageLibraryAsync(options);
    } catch {
      throw new Error(
        "Couldn't download the media from iCloud. Check your connection and try again.",
      );
    }
  }
}
