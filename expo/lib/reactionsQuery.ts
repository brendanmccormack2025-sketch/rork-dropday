/**
 * The data behind the reactions screen (app/post/[id]/reaction-tree.tsx), shared so the feed can load it ahead of
 * time: while a post is on screen its reactions list is fetched (or, with no reactions, known to be empty without a
 * request), and the post's own row is already in hand. Opening the reactions then shows them at once.
 */
import type { QueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";

import { supabase } from "@/lib/supabase";
import type { Post } from "@/providers/PostsProvider";

export const REACTION_SELECT =
  "id, user_id, media_url, media_type, caption, parent_post_id, thumbnail_url, moderation_status, status, follower_visibility, created_at, media_deleted_at, likes(count), comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url, instagram_handle, tiktok_handle, youtube_url, website)";

export const REACTIONS_STALE_MS = 30_000;

export type RootDrop = { user_id: string | null; status: string | null; moderation_status: string | null };

export const rootDropKey = (id: string) => ["post", id] as const;
export const reactionsKey = (id: string) => ["reactions", id] as const;

export function mapReactionRow(row: Record<string, unknown>): Post {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    media_url: row.media_url as string,
    media_type: row.media_type as "image" | "video",
    caption: (row.caption as string | null) ?? null,
    parent_post_id: (row.parent_post_id as string | null) ?? null,
    segments: null,
    audio_url: null,
    trim_data: null,
    text_overlays: null,
    thumbnail_url: (row.thumbnail_url as string | null) ?? null,
    moderation_status: (row.moderation_status as string | undefined) ?? "active",
    status: (row.status as Post["status"]) ?? "trial",
    media_deleted_at: (row.media_deleted_at as string | null) ?? null,
    follower_visibility: (row.follower_visibility as boolean | null) ?? true,
    created_at: row.created_at as string,
    like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
    comment_count: (row.comment_count as number | undefined) ?? 0,
    profile: (row.profiles as Post["profile"]) ?? null,
  } as Post;
}

export async function fetchRootDrop(id: string): Promise<RootDrop | null> {
  const { data, error } = await supabase.from("posts").select("user_id, status, moderation_status").eq("id", id).maybeSingle();
  if (error) {
    console.error("[reaction-tree] root drop query error", error.message);
    return null;
  }
  if (!data) return null;
  return {
    user_id: (data.user_id as string) ?? null,
    status: (data.status as string) ?? null,
    moderation_status: (data.moderation_status as string) ?? null,
  };
}

/** Tier 1: the reactions to a post, newest first. The cover images are fetched into the image cache too. */
export async function fetchReactions(id: string): Promise<Post[]> {
  const { data: rows, error } = await supabase
    .from("posts")
    .select(REACTION_SELECT)
    .eq("parent_post_id", id)
    .eq("moderation_status", "active")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[reaction-tree] tier1 query error", error.message);
    return [];
  }
  const posts = ((rows ?? []) as Record<string, unknown>[]).map(mapReactionRow);
  const covers = posts.slice(0, 4).map((p) => p.thumbnail_url).filter((u): u is string => !!u);
  if (covers.length > 0) Image.prefetch(covers).catch(() => {});
  return posts;
}

/**
 * While a post is on screen in the feed: have its reactions ready before anyone taps. The post's own row is already
 * known (no request). With no reactions the list is known to be empty (no request); otherwise it is fetched once and
 * kept fresh for REACTIONS_STALE_MS. Never throws.
 */
export function prefetchReactions(qc: QueryClient, post: Pick<Post, "id" | "user_id" | "status" | "moderation_status"> & { reaction_count?: number; _optimistic?: unknown }): void {
  try {
    if (!post?.id || post._optimistic) return;
    if (!qc.getQueryData(rootDropKey(post.id))) {
      qc.setQueryData<RootDrop>(rootDropKey(post.id), {
        user_id: post.user_id ?? null,
        status: (post.status as string | undefined) ?? null,
        moderation_status: (post.moderation_status as string | undefined) ?? null,
      });
    }
    if (post.reaction_count === 0) {
      if (qc.getQueryData(reactionsKey(post.id)) === undefined) qc.setQueryData<Post[]>(reactionsKey(post.id), []);
      return;
    }
    void qc.prefetchQuery({ queryKey: reactionsKey(post.id), queryFn: () => fetchReactions(post.id), staleTime: REACTIONS_STALE_MS });
  } catch {
    // preloading is best-effort
  }
}
