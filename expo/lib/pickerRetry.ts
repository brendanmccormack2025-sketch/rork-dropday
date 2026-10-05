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
 * launchImageLibraryAsync with ONE automatic retry, after 2 seconds, for iCloud
 * download failures (PHPhotosErrorDomain 3169/3164, CloudPhotoLibraryErrorDomain
 * and similar sync-timing errors, see ICLOUD_DOWNLOAD_ERROR_PATTERN). Note the
 * retry opens the picker again: expo-image-picker cannot reload a selection that
 * failed. Other errors, and an iCloud error on the retry, are rethrown unchanged
 * so the caller can classify them (lib/pickerErrors.ts).
 *
 * `onRetry` fires just before the retry with the upcoming attempt number (2) so
 * callers can switch their loading copy. Purely cosmetic.
 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;

export async function launchLibraryWithRetry(
  options: ImagePicker.ImagePickerOptions,
  onRetry?: (attempt: number) => void,
): Promise<ImagePicker.ImagePickerResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ImagePicker.launchImageLibraryAsync(options);
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !isNetworkDownloadError(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      onRetry?.(attempt + 1);
    }
  }
}
