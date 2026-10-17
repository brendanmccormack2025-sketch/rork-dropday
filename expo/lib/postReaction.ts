/**
 * The real input/output steps for posting a reaction straight from the camera (see lib/postReactionCore.ts).
 */
import { getThumbnailAsync } from "expo-video-thumbnails";

import { copyAsync, deleteAsync, documentDirectory, getInfoAsync, makeDirectoryAsync } from "@/lib/fileSystemCompat";
import { mergeVideoClips } from "@/lib/mergeClips";
import { renderMerge } from "@/lib/mergeNative";
import type { PostReactionDeps } from "@/lib/postReactionCore";

let n = 0;
const newId = () => `rx_${Date.now()}_${n++}`;

export const reactionIo: Pick<PostReactionDeps, "merge" | "stage" | "thumbnail" | "discard"> = {
  async merge(uris) {
    const r = await mergeVideoClips({ clips: uris.map((uri) => ({ uri, type: "video" as const })), render: renderMerge, newId });
    return r.ok ? { ok: true, uri: r.clip.uri } : { ok: false, message: r.message };
  },
  async stage(uri) {
    const dir = `${documentDirectory}post_uploads/`;
    await makeDirectoryAsync(dir, { intermediates: true });
    const src = await getInfoAsync(uri);
    if (!src.exists || !(src.size ?? 0)) throw new Error("reaction file missing or empty");
    const ext = uri.match(/\.(\w+)(?:\?|$)/)?.[1] ?? "mov";
    const dest = `${dir}reaction_${Date.now()}.${ext}`;
    await copyAsync({ from: uri, to: dest });
    const out = await getInfoAsync(dest);
    if (!out.exists || out.size !== src.size) throw new Error("reaction copy failed");
    return dest;
  },
  async thumbnail(uri) {
    try {
      const result = await getThumbnailAsync(uri, { time: 0 });
      if (!result?.uri) return null;
      const dir = `${documentDirectory}thumbnails/`;
      await makeDirectoryAsync(dir, { intermediates: true });
      const dest = `${dir}cover_${Date.now()}.jpg`;
      try {
        await copyAsync({ from: result.uri, to: dest });
      } finally {
        await deleteAsync(result.uri, { idempotent: true }).catch(() => {});
      }
      return dest;
    } catch {
      return null;
    }
  },
  async discard(uri) {
    await deleteAsync(uri, { idempotent: true }).catch(() => {});
  },
};
