/**
 * Camera-roll picker errors, classified so the user never sees a raw exception
 * string. The real error is for logs (development builds only).
 */
export type PickerErrorKind =
  | "icloud"
  | "unreadable_photo"
  | "no_permission"
  | "cancelled"
  | "unknown";

const ICLOUD =
  /PHPhotosErrorDomain|CloudPhotoLibraryErrorDomain|3169|3164|network\s*error|networkerror|Couldn't download the media|\biCloud\b/i;
const UNREADABLE_PHOTO =
  /FailedToReadImage|Failed to read picked image|public\.hei[cf]|Cannot load representation|FailedToPickLivePhoto|live photo|FailedCreatingUIImage|FailedToReadImageData/i;
const NO_PERMISSION = /permission|not authorized|unauthorized|authoriz|denied|restricted|limited/i;
const CANCELLED = /cancel/i;

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return `${e.name} ${code ?? ""} ${e.message}`;
  }
  return String(e);
}

export function classifyPickerError(e: unknown): PickerErrorKind {
  const text = describe(e);
  // A photo that cannot be read can mention PHPhotos too: check it before iCloud.
  if (UNREADABLE_PHOTO.test(text)) return "unreadable_photo";
  if (ICLOUD.test(text)) return "icloud";
  if (NO_PERMISSION.test(text)) return "no_permission";
  if (CANCELLED.test(text)) return "cancelled";
  return "unknown";
}

/** Fixed wording shown to the user for each kind (cancelled shows nothing). */
export const PICKER_ERROR_MESSAGES: Record<Exclude<PickerErrorKind, "cancelled">, string> = {
  icloud:
    "This is in iCloud and could not be downloaded. Open it in Photos until it finishes loading, use Wi-Fi, and try again.",
  unreadable_photo:
    "This photo could not be read. Open it in Photos until it finishes loading, or choose another one.",
  no_permission:
    "Trial cannot see this photo or video. Allow access to your photos in Settings (choose all photos, or add this one to the ones you share) and try again.",
  unknown: "Something went wrong opening your library. Try again.",
};
