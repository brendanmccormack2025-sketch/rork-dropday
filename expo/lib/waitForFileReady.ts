import { getInfoAsync } from "@/lib/fileSystemCompat";

const POLL_INTERVAL_MS = 250;
const MAX_WAIT_MS = 5000;

/**
 * Waits until a local file URI exists and is non-empty before the video
 * player opens it. Camera recordings and picker exports can still be
 * finalizing on disk when the editor mounts — opening too early makes
 * expo-video fail with "Failed to load the player item: Cannot Open".
 *
 * Non-file URIs (http/data/blob) pass through immediately. Always resolves
 * (true after timeout) — the player's own error + retry path is the final
 * arbiter for genuinely missing or corrupt files.
 */
export async function waitForFileReady(uri: string): Promise<boolean> {
  if (!uri.startsWith("file://")) return true;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await getInfoAsync(uri);
      if (info.exists && (info.size ?? 0) > 0) return true;
    } catch {
      // stat failed — poll again until the deadline
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return true;
}
