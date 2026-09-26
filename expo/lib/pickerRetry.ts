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
 * launchImageLibraryAsync with up to two automatic retries for iCloud
 * download failures (PHPhotosErrorDomain 3169/3164,
 * CloudPhotoLibraryErrorDomain, and similar sync-timing errors — see
 * ICLOUD_DOWNLOAD_ERROR_PATTERN). Large assets (multi-second videos,
 * freshly synced files) intermittently fail partway through the download;
 * giving iCloud more attempts with growing pauses — 1s, then 3s — meaningfully
 * improves the odds for borderline cases. Non-iCloud errors are rethrown
 * immediately; once all attempts are exhausted the caller gets a friendly
 * message instead of a raw error.
 *
 * Attempts only escalate on a genuine failure, so normal/fast picks pay
 * zero extra delay — successful first attempts return immediately.
 *
 * `onRetry` fires just before each retry starts with the upcoming attempt
 * number (2, then 3) so callers can switch their loading copy — e.g.
 * "Still downloading…" → "Almost there…". Purely cosmetic — it does not
 * affect the retry logic or timing.
 */
const MAX_ATTEMPTS = 3;

function retryDelayMs(attempt: number): number {
  // Escalating backoff: 1s before retry 2, 3s before retry 3.
  return attempt === 1 ? 1_000 : 3_000;
}

export async function launchLibraryWithRetry(
  options: ImagePicker.ImagePickerOptions,
  onRetry?: (attempt: number) => void,
): Promise<ImagePicker.ImagePickerResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await ImagePicker.launchImageLibraryAsync(options);
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          "Couldn't download the media from iCloud. Check your connection and try again.",
        );
      }
      if (!isNetworkDownloadError(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      onRetry?.(attempt + 1);
    }
  }
  // Unreachable — every iteration either returns or throws.
  throw new Error(
    "Couldn't download the media from iCloud. Check your connection and try again.",
  );
}
