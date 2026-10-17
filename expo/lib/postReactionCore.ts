/**
 * A reaction is posted straight from the camera: no edit choice, no editor, no Post screen. What the editor did for a
 * reaction is all that happens here (reactions were never rendered, captioned or saved to the camera roll):
 *   1. several camera segments (a camera flip) are joined into ONE video (the reactions screen plays one file)
 *   2. the video is copied to the upload folder (the camera's own file may be cleaned up)
 *   3. a cover frame is taken
 *   4. it appears at once as an optimistic reaction, and the upload runs in the background
 * The input/output steps are injected (lib/postReaction.ts wires the real ones), so the Node tests can run this.
 */

export type ReactionClip = { uri: string; type: "video" | "image" };

export type ReactionUpload = {
  uri: string;
  mediaType: "video" | "image";
  parentPostId: string;
  thumbnailUri?: string;
  optimisticTempId: string;
};

export type PostReactionDeps = {
  /** Joins video files in order into one; never throws. */
  merge(uris: string[]): Promise<{ ok: true; uri: string } | { ok: false; message: string }>;
  /** Copies a file into the upload folder and checks the copy; throws when it fails. */
  stage(uri: string): Promise<string>;
  /** A cover image for a video, or null. */
  thumbnail(uri: string): Promise<string | null>;
  /** Removes a temporary file (the joined video once copied). */
  discard(uri: string): Promise<void>;
  /** Shows the reaction at once; returns its temporary id. */
  addOptimistic(payload: { uri: string; mediaType: "video" | "image"; thumbnailUri?: string }, parentPostId: string): string;
  /** Starts the background upload. */
  upload(args: ReactionUpload): void;
};

export type PostReactionResult = { ok: true; tempId: string } | { ok: false; message: string };

export const REACTION_FAILED_TEXT = "Couldn't post your reaction. Please try again.";

export async function postReactionNow(clips: ReadonlyArray<ReactionClip>, parentPostId: string, deps: PostReactionDeps): Promise<PostReactionResult> {
  if (!parentPostId) return { ok: false, message: REACTION_FAILED_TEXT };
  const usable = clips.filter((c) => !!c.uri);
  if (usable.length === 0) return { ok: false, message: "Nothing to post. Record your reaction first." };
  try {
    const mediaType = usable[0]!.type;
    let source = usable[0]!.uri;
    let joined: string | null = null;
    if (usable.length > 1 && usable.every((c) => c.type === "video")) {
      const merged = await deps.merge(usable.map((c) => c.uri));
      if (!merged.ok) return { ok: false, message: REACTION_FAILED_TEXT };
      source = merged.uri;
      joined = merged.uri;
    }
    const staged = await deps.stage(source);
    if (joined) await deps.discard(joined).catch(() => {});
    const thumb = mediaType === "video" ? await deps.thumbnail(staged).catch(() => null) : null;
    const tempId = deps.addOptimistic({ uri: staged, mediaType, ...(thumb ? { thumbnailUri: thumb } : {}) }, parentPostId);
    deps.upload({ uri: staged, mediaType, parentPostId, ...(thumb ? { thumbnailUri: thumb } : {}), optimisticTempId: tempId });
    return { ok: true, tempId };
  } catch {
    return { ok: false, message: REACTION_FAILED_TEXT };
  }
}

/** The reaction count shown on a post: the freshest list we hold for it, plus my reactions still uploading. */
export function reactionCountOf(args: {
  /** The post's reactions list when it is in the cache (the feed preloads it). */
  cached: ReadonlyArray<{ id: string }> | undefined;
  /** The count that came with the post from the server. */
  serverCount: number | undefined;
  /** The older app-wide list of recent reactions for this post. */
  recent: ReadonlyArray<{ id: string }> | undefined;
  /** My optimistic reactions to this post (uploading). */
  pending: number;
}): number {
  const base = args.cached ? args.cached.length : Math.max(args.serverCount ?? 0, args.recent?.length ?? 0);
  return base + Math.max(0, args.pending);
}
