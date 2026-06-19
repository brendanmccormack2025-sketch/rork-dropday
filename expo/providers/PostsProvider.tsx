import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { documentDirectory, getInfoAsync, deleteAsync } from "@/lib/fileSystemCompat";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { getDropWindowState, DROP_WINDOW } from "@/constants/theme";

export type OptimisticStatus = "uploading" | "failed";

export type Post = {
  id: string;
  user_id: string;
  media_url: string;
  media_type: "image" | "video";
  caption: string | null;
  parent_post_id: string | null;
  segments: string[] | null;
  audio_url: string | null;
  trim_data: { trimStartMs: number; trimEndMs: number }[] | null;
  thumbnail_url: string | null;
  created_at: string;
  like_count?: number;
  comment_count?: number;
  reaction_count?: number;
  profile?: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Present only on optimistic (not-yet-uploaded) posts */
  _optimistic?: {
    tempId: string;
    status: OptimisticStatus;
    error?: string;
    retryPayload?: string;
  };
};

export type SuggestedUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type MyProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  website: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
};

export type DraftClip = {
  id: string;
  uri: string;
  type: "image" | "video";
  durationMs?: number;
  trimStartMs?: number;
  trimEndMs?: number;
  recordingSessionId?: string;
};

/** Preset text background styles — mirrors TikTok / Instagram / CapCut */
export type TextBackgroundStyle =
  | "none-white"       // White text, no background (default)
  | "none-black"       // Black text, no background
  | "white-box"        // White background with black text
  | "black-box"        // Black background with white text
  | "accent-box"       // Accent-colored background with white text
  | "translucent-box";  // Semi-transparent black background with white text

export type TextOverlay = {
  id: string;
  text: string;
  /** Center position as fraction of frame width (0–1) */
  x: number;
  /** Center position as fraction of frame height (0–1) */
  y: number;
  /** Font size in points (12–120) */
  fontSize: number;
  /** Rotation in degrees */
  rotation: number;
  /** Hex color string e.g. "#FFFFFF" */
  color: string;
  /** Background style preset */
  backgroundStyle: TextBackgroundStyle;
};

export type DraftProject = {
  id: string;
  clips: DraftClip[];
  caption: string;
  coverThumbnailUri?: string;
  coverThumbnailMs?: number;
  textOverlays: TextOverlay[];
  createdAt: number;
  updatedAt: number;
};

const BUCKET = "drops";
const DRAFTS_KEY = "dropday:draftProjects:v2";
const OPTIMISTIC_POSTS_KEY = "dropday:optimisticPosts";

type OptimisticRetryPayload = {
  uri: string;
  mediaType: "image" | "video";
  caption?: string;
  draftId?: string;
  segmentUris?: string[];
  trimData?: Array<{ trimStartMs: number; trimEndMs: number }>;
  textOverlays?: TextOverlay[];
  thumbnailUri?: string;
};

/**
 * Read a local file URI into a Uint8Array for Supabase upload.
 * Uses fetch + arrayBuffer() — the modern RN approach for reading binary files
 * that avoids the confusing readAsStringAsync naming (even though Base64 mode
 * works, this is cleaner and more explicit about binary intent).
 */
async function uriToBlob(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch file: HTTP ${response.status} — ${uri.slice(0, 60)}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error(`File read returned empty data from ${uri.slice(0, 60)}`);
  }
  return new Uint8Array(arrayBuffer);
}

function rankFeed(posts: Post[], followingIds: string[]): Post[] {
  if (posts.length === 0) return posts;
  const follows = new Set(followingIds);
  const now = Date.now();
  const win = getDropWindowState(new Date(now));

  const scored = posts.map((p) => {
    const ageHours = Math.max(0, (now - new Date(p.created_at).getTime()) / 3.6e6);
    const freshness = Math.exp(-ageHours / 12);
    const engagement = Math.log1p((p.like_count ?? 0) + 2 * (p.comment_count ?? 0));
    const followBoost = follows.has(p.user_id) ? 3.5 : 0;
    const created = new Date(p.created_at);
    const inLiveWindow =
      win.isOpen && created >= win.windowStart && created < win.windowEnd;
    const liveBoost = inLiveWindow ? 1.8 : 0;
    const jitter = Math.random() * 0.15;
    const score = followBoost + engagement * 1.2 + freshness * 2.5 + liveBoost + jitter;
    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const out: Post[] = [];
  const remaining = [...scored];
  let lastUser: string | null = null;
  while (remaining.length > 0) {
    const idx = remaining.findIndex((s) => s.p.user_id !== lastUser);
    const pick = idx >= 0 ? idx : 0;
    const [chosen] = remaining.splice(pick, 1);
    out.push(chosen.p);
    lastUser = chosen.p.user_id;
  }
  return out;
}

export const [PostsProvider, usePosts] = createContextHook(() => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draftProjects, setDraftProjects] = useState<DraftProject[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);

  // Load draft projects from AsyncStorage on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DRAFTS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as DraftProject[];
          // Sort newest first
          parsed.sort((a, b) => b.updatedAt - a.updatedAt);
          setDraftProjects(parsed);
        }
      } catch (e) {
        console.warn("[drafts] load error", e);
      } finally {
        setDraftsLoaded(true);
      }
    })();
  }, []);

  const persistDraftProjects = useCallback(async (next: DraftProject[]) => {
    setDraftProjects(next);
    try {
      await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
    } catch (e) {
      console.error("[drafts] persist error", e);
    }
  }, []);

  /** Save a full draft project — creates new or overwrites existing by id. */
  const saveDraftProject = useCallback(
    async (project: DraftProject) => {
      const filtered = draftProjects.filter((d) => d.id !== project.id);
      const updated = { ...project, updatedAt: Date.now() };
      const next = [updated, ...filtered];
      await persistDraftProjects(next);
      return updated;
    },
    [draftProjects, persistDraftProjects]
  );

  /** Delete a draft project by id — also cleans up permanent media files. */
  const deleteDraftProject = useCallback(
    async (id: string) => {
      // Remove permanent media files from document directory
      const draftDir = `${documentDirectory}drafts/${id}/`;
      try {
        const dirInfo = await getInfoAsync(draftDir);
        if (dirInfo.exists) {
          await deleteAsync(draftDir, { idempotent: true });
        }
      } catch (e) {
        console.warn("[drafts] cleanup error for", id, e);
      }
      await persistDraftProjects(draftProjects.filter((d) => d.id !== id));
    },
    [draftProjects, persistDraftProjects]
  );

  const followingQuery = useQuery({
    queryKey: ["follows", user?.id],
    enabled: !!user?.id,
    retry: 1,
    queryFn: async (): Promise<string[]> => {
      if (!user?.id) return [];
      try {
        const { data, error } = await supabase
          .from("follows")
          .select("followee_id")
          .eq("follower_id", user.id);
        if (error) return [];
        return (data ?? []).map((r: { followee_id: string }) => r.followee_id);
      } catch (e) {
        console.warn("[follows] network error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  const feedQuery = useQuery({
    queryKey: ["posts", "fyp", user?.id],
    retry: 1,
    queryFn: async (): Promise<Post[]> => {
      let data: unknown[] | null = null;
      try {
        const res = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, profiles(username, display_name, avatar_url)"
          )
          .is("parent_post_id", null)
          .order("created_at", { ascending: false })
          .limit(300);
        if (res.error) {
          console.warn("[posts] feed error", res.error.message);
          return [];
        }
        data = res.data as unknown[] | null;
      } catch (e) {
        console.warn("[posts] feed network error", (e as Error)?.message ?? e);
        return [];
      }
      const raw: Post[] = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        media_url: row.media_url as string,
        media_type: row.media_type as "image" | "video",
        caption: (row.caption as string | null) ?? null,
        parent_post_id: (row.parent_post_id as string | null) ?? null,
        segments: (row.segments as string[] | null) ?? null,
        audio_url: (row.audio_url as string | null) ?? null,
        trim_data: (row.trim_data as Post["trim_data"]) ?? null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        created_at: row.created_at as string,
        like_count: (row.like_count as number | undefined) ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
      return rankFeed(raw, followingQuery.data ?? []);
    },
  });

  const myPostsQuery = useQuery({
    queryKey: ["posts", "mine", user?.id],
    enabled: !!user?.id,
    retry: 1,
    queryFn: async (): Promise<Post[]> => {
      if (!user?.id) return [];
      try {
        const { data, error } = await supabase
          .from("posts")
          .select("id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, profiles(username, display_name, avatar_url)")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) {
          console.warn("[posts] mine error", error.message);
          return [];
        }
        return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
      } catch (e) {
        console.warn("[posts] mine network error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // Previous night's drop window (yesterday 8 PM – midnight local)
  const prevNightRange = useMemo(() => {
    const now = new Date();
    const yesterdayStart = new Date(now);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(DROP_WINDOW.startHour, 0, 0, 0);
    const yesterdayEnd = new Date(yesterdayStart);
    yesterdayEnd.setHours(0, 0, 0, 0);
    yesterdayEnd.setDate(yesterdayEnd.getDate() + 1);
    return { start: yesterdayStart, end: yesterdayEnd };
  }, []);

  const lastNightQuery = useQuery({
    queryKey: [
      "posts",
      "last-night",
      prevNightRange.start.toISOString().slice(0, 10),
    ],
    retry: 1,
    queryFn: async (): Promise<Post[]> => {
      try {
        const { data, error } = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, profiles(username, display_name, avatar_url)"
          )
          .gte("created_at", prevNightRange.start.toISOString())
          .lt("created_at", prevNightRange.end.toISOString())
          .order("like_count", { ascending: false })
          .limit(100);
        if (error) {
          console.warn("[posts] last-night error", error.message);
          return [];
        }
        const raw = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
        return raw;
      } catch (e) {
        console.warn("[posts] last-night network error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // Reactions for a specific post — fetches all posts that have a parent_post_id
  // Suggested users — profiles NOT followed by current user (excluding self)
  const myProfileQuery = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 0,
    queryFn: async (): Promise<MyProfile | null> => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, bio, website, instagram_handle, tiktok_handle")
        .eq("id", user.id)
        .maybeSingle();

      if (error) {
        console.warn("[profile:query] ERROR", {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        });
        return null;
      }

      if (data) {
        return {
          id: data.id as string,
          username: data.username as string,
          display_name: (data.display_name as string | null) ?? null,
          avatar_url: (data.avatar_url as string | null) ?? null,
          bio: (data.bio as string | null) ?? null,
          website: (data.website as string | null) ?? null,
          instagram_handle: (data.instagram_handle as string | null) ?? null,
          tiktok_handle: (data.tiktok_handle as string | null) ?? null,
        };
      }

      return null;
    },
  });

  const updateProfile = useMutation({
    mutationFn: async (input: {
      username?: string;
      display_name?: string | null;
      avatar_url?: string | null;
      bio?: string | null;
      website?: string | null;
      instagram_handle?: string | null;
      tiktok_handle?: string | null;
    }) => {
      if (!user?.id) throw new Error("Not signed in.");

      const updateData: Record<string, unknown> = {};
      if (input.username !== undefined) updateData.username = input.username;
      if (input.display_name !== undefined) updateData.display_name = input.display_name;
      if (input.avatar_url !== undefined) updateData.avatar_url = input.avatar_url;
      if (input.bio !== undefined) updateData.bio = input.bio;
      if (input.website !== undefined) updateData.website = input.website;
      if (input.instagram_handle !== undefined) updateData.instagram_handle = input.instagram_handle;
      if (input.tiktok_handle !== undefined) updateData.tiktok_handle = input.tiktok_handle;
      if (Object.keys(updateData).length === 0) return;

      const { error } = await supabase
        .from("profiles")
        .upsert({ id: user.id, ...updateData }, { onConflict: "id" });

      if (error) throw error;
    },
    onSuccess: () => {
      console.log("[updateProfile] success — invalidating queries");
      qc.invalidateQueries({ queryKey: ["profile", user?.id] });
      qc.invalidateQueries({ queryKey: ["suggested", user?.id] });
      qc.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: (err) => {
      console.error("[updateProfile] error", (err as Error)?.message ?? err);
    },
  });

  const suggestedQuery = useQuery({
    queryKey: ["suggested", user?.id],
    enabled: !!user?.id,
    retry: 1,
    queryFn: async (): Promise<SuggestedUser[]> => {
      if (!user?.id) return [];
      const following = followingQuery.data ?? [];
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .neq("id", user.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) {
          console.warn("[suggested] error", error.message);
          return [];
        }
        const followingSet = new Set(following);
        return ((data ?? []) as SuggestedUser[]).filter(
          (p) => !followingSet.has(p.id),
        );
      } catch (e) {
        console.warn("[suggested] network error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  const followUser = useMutation({
    mutationFn: async (followeeId: string) => {
      if (!user?.id) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("follows")
        .insert({ follower_id: user.id, followee_id: followeeId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["follows"] });
      qc.invalidateQueries({ queryKey: ["suggested"] });
      qc.invalidateQueries({ queryKey: ["posts"] });
    },
  });

  const unfollowUser = useMutation({
    mutationFn: async (followeeId: string) => {
      if (!user?.id) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("followee_id", followeeId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["follows"] });
      qc.invalidateQueries({ queryKey: ["suggested"] });
      qc.invalidateQueries({ queryKey: ["posts"] });
    },
  });

  const allReactionsQuery = useQuery({
    queryKey: ["posts", "all-reactions"],
    retry: 1,
    queryFn: async (): Promise<Record<string, Post[]>> => {
      try {
        const { data, error } = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, profiles(username, display_name, avatar_url)"
          )
          .not("parent_post_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) {
          console.warn("[posts] reactions error", error.message);
          return {};
        }
        const raw: Post[] = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
        // Group by parent_post_id
        const grouped: Record<string, Post[]> = {};
        for (const p of raw) {
          const pid = p.parent_post_id;
          if (pid) {
            if (!grouped[pid]) grouped[pid] = [];
            grouped[pid].push(p);
          }
        }
        return grouped;
      } catch (e) {
        console.warn("[posts] reactions network error", (e as Error)?.message ?? e);
        return {};
      }
    },
  });

  // Track current time so hasPostedInWindow re-evaluates when the window opens/closes.
  // Previously the memo only depended on myPostsQuery.data, so the Drop icon
  // would not reappear after the window opened unless data was refetched.
  const [nowForWindow, setNowForWindow] = useState<Date>(new Date());
  useEffect(() => {
    const id = setInterval(() => setNowForWindow(new Date()), 5000);
    return () => clearInterval(id);
  }, []);

  // MVP: time-window filter disabled — check if the user has ANY post at all.
  // Before launch, restore the per-window check:
  //   const win = getDropWindowState(nowForWindow);
  //   (myPostsQuery.data ?? []).some((p) => { const t = new Date(p.created_at); return t >= win.windowStart && t < win.windowEnd; });
  const hasPostedInWindow = useMemo(() => {
    return (myPostsQuery.data ?? []).length > 0;
  }, [myPostsQuery.data]);

  // ── Optimistic posts ──────────────────────────────────────────────────────
  const [optimisticPosts, setOptimisticPosts] = useState<Post[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(OPTIMISTIC_POSTS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Post[];
          const fixed = parsed.map((p) =>
            p._optimistic?.status === "uploading"
              ? {
                  ...p,
                  _optimistic: {
                    ...p._optimistic,
                    status: "failed" as const,
                    error: "App was closed during upload. Tap to retry.",
                  },
                }
              : p
          );
          setOptimisticPosts(fixed);
        }
      } catch (e) {
        console.warn("[optimistic] load error", e);
      }
    })();
  }, []);

  const persistOptimisticPosts = useCallback(async (next?: Post[]) => {
    const toSave = next ?? optimisticPosts;
    try {
      if (toSave.length === 0) {
        await AsyncStorage.removeItem(OPTIMISTIC_POSTS_KEY);
      } else {
        await AsyncStorage.setItem(OPTIMISTIC_POSTS_KEY, JSON.stringify(toSave));
      }
    } catch (e) {
      console.warn("[optimistic] persist error", e);
    }
  }, [optimisticPosts]);

  const addOptimisticPost = useCallback(
    (payload: OptimisticRetryPayload): string => {
      const tempId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optPost: Post = {
        id: tempId,
        user_id: user?.id ?? "",
        media_url: payload.uri,
        media_type: payload.mediaType,
        caption: payload.caption ?? null,
        parent_post_id: null,
        segments: payload.segmentUris ?? null,
        audio_url: null,
        trim_data: payload.trimData ?? null,
        thumbnail_url: payload.thumbnailUri ?? null,
        created_at: new Date().toISOString(),
        like_count: 0,
        comment_count: 0,
        reaction_count: 0,
        profile: null,
        _optimistic: {
          tempId,
          status: "uploading",
          retryPayload: JSON.stringify(payload),
        },
      };

      setOptimisticPosts((prev) => {
        const next = [optPost, ...prev];
        persistOptimisticPosts(next);
        return next;
      });

      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return [optPost];
        return [optPost, ...old];
      });
      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return [optPost];
        return [optPost, ...old];
      });

      return tempId;
    },
    [user?.id, qc, persistOptimisticPosts]
  );

  const finalizeOptimisticPost = useCallback(
    (tempId: string, _realPost: Post) => {
      setOptimisticPosts((prev) => {
        const next = prev.filter((p) => p._optimistic?.tempId !== tempId);
        persistOptimisticPosts(next);
        return next;
      });
    },
    [persistOptimisticPosts]
  );

  const failOptimisticPost = useCallback(
    (tempId: string, error: string) => {
      setOptimisticPosts((prev) => {
        const next = prev.map((p) =>
          p._optimistic?.tempId === tempId
            ? {
                ...p,
                _optimistic: { ...p._optimistic, status: "failed" as const, error },
              }
            : p
        );
        persistOptimisticPosts(next);
        return next;
      });

      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "failed" as const, error },
              }
            : p
        );
      });
    },
    [user?.id, qc, persistOptimisticPosts]
  );

  const createPost = useMutation({
    mutationFn: async (input: {
      uri: string;
      mediaType: "image" | "video";
      caption?: string;
      draftId?: string;
      parentPostId?: string;
      segmentUris?: string[];
      trimData?: Array<{ trimStartMs: number; trimEndMs: number }>;
      textOverlays?: TextOverlay[];
      thumbnailUri?: string;
      optimisticTempId?: string;
    }) => {
      console.log("[createPost] mutationFn START — user:", user?.id?.slice(0, 8), "mediaType:", input.mediaType, "hasSegmentUris:", !!input.segmentUris?.length, "hasThumbnail:", !!input.thumbnailUri, "draftId:", input.draftId?.slice(0, 8));

      if (!user?.id) {
        console.error("[createPost] mutationFn ABORT — no user.id");
        throw new Error("Not signed in.");
      }

      // TODO: Re-enable drop window check before launch
      // const win = getDropWindowState(new Date());
      // if (!win.isOpen) {
      //   throw new Error("Drop window is closed. Save as draft and post when it opens at 8 PM.");
      // }

      const baseTs = Date.now();
      const isRemoteUrl = input.uri.startsWith("http");

      let mediaUrl: string;
      let segmentUrls: string[] | null = null;

      if (isRemoteUrl) {
        mediaUrl = input.uri;
        segmentUrls = input.segmentUris ?? null;
      } else {
        const urisToUpload = input.segmentUris && input.segmentUris.length > 0
          ? input.segmentUris
          : [input.uri];

        const uploadedUrls: string[] = [];
        for (let i = 0; i < urisToUpload.length; i++) {
          const segUri = urisToUpload[i]!;

          // Verify the file exists on disk BEFORE attempting to read it.
          // If the file was in a temp/drafts directory that got cleaned up,
          // this will catch it early with a clear error message.
          const fileInfo = await getInfoAsync(segUri);
          if (!fileInfo.exists) {
            const errMsg = `File does not exist at upload time: ${segUri.slice(0, 80)}`;
            console.error(`[createPost] ${errMsg}`);
            throw new Error(errMsg);
          }
          if ((fileInfo.size ?? 0) === 0) {
            const errMsg = `File is empty (0 bytes) at upload time: ${segUri.slice(0, 80)}`;
            console.error(`[createPost] ${errMsg}`);
            throw new Error(errMsg);
          }
          console.log(`[createPost] File verified [${i}]: ${segUri.slice(0, 60)} — ${fileInfo.size} bytes`);

          // Determine file extension from the URI, not from mediaType.
          // A video file might be .mov (QuickTime) or .mp4 — we keep the
          // original extension so content-type detection is accurate.
          const uriExt = segUri.match(/\.(\w+)(?:\?|$)/)?.[1]?.toLowerCase();
          const segExt = uriExt ?? (input.mediaType === "video" ? "mp4" : "jpg");
          const segPath = `${user.id}/${baseTs}_seg${i}.${segExt}`;

          // Map extension to MIME type
          const mimeByExt: Record<string, string> = {
            mp4: "video/mp4",
            mov: "video/quicktime",
            m4v: "video/x-m4v",
            avi: "video/x-msvideo",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
            heic: "image/heic",
          };
          const contentType = mimeByExt[segExt] ?? (input.mediaType === "video" ? "video/mp4" : "image/jpeg");

          let body: Uint8Array;
          try {
            body = await uriToBlob(segUri);
          } catch (e) {
            const errAny = e as Record<string, unknown> | undefined;
            console.error(`[createPost] uriToBlob FAIL [${i}]`, {
              message: (e as Error)?.message ?? String(e),
              code: errAny?.code,
              status: errAny?.status,
              details: errAny?.details,
              hint: errAny?.hint,
              uri: segUri.slice(0, 60),
            });
            throw new Error(`Failed to read file: ${(e as Error)?.message ?? "unknown error"}`);
          }

          const sizeMB = (body.byteLength / (1024 * 1024)).toFixed(2);
          console.log(`[createPost] Uploading [${i}]: ${sizeMB} MB → ${segPath}`);

          console.log(`[createPost] BEFORE upload [${i}] — calling supabase.storage.from("${BUCKET}").upload(${segPath}, ${body.byteLength} bytes, ${contentType})`);
          let upData: unknown;
          let upErr: { message: string; statusCode?: string; error?: string; name?: string } | null = null;
          try {
            const result = await supabase.storage
              .from(BUCKET)
              .upload(segPath, body, { contentType, upsert: false });
            console.log(`[createPost] AFTER upload [${i}] — raw result:`, JSON.stringify({ hasData: !!result.data, hasError: !!result.error, path: result.data?.path }));
            upData = result.data;
            upErr = result.error
              ? {
                  message: result.error.message,
                  statusCode: (result.error as unknown as Record<string, unknown>)?.statusCode as string | undefined,
                  error: (result.error as unknown as Record<string, unknown>)?.error as string | undefined,
                  name: result.error.name,
                }
              : null;
          } catch (uploadCatchErr) {
            const ue = uploadCatchErr as unknown as Record<string, unknown> | undefined;
            console.error(`[createPost] upload FAIL [${i}]`, {
              message: (uploadCatchErr as Error)?.message ?? String(uploadCatchErr),
              name: (uploadCatchErr as Error)?.name,
              code: ue?.code,
              status: ue?.status,
              statusCode: ue?.statusCode,
              details: ue?.details,
              hint: ue?.hint,
              error: ue?.error,
              bucket: BUCKET,
              path: segPath,
              contentType,
              fileBytes: body.byteLength,
              fileSizeMB: sizeMB,
            });
            throw new Error(
              `Storage upload failed: ${(uploadCatchErr as Error)?.message ?? "Network request failed"} (${sizeMB} MB file to ${BUCKET}/${segPath})`,
            );
          }

          if (upErr) {
            console.error(`[createPost] upload error response [${i}]`, {
              message: upErr.message,
              statusCode: upErr.statusCode,
              error: upErr.error,
              name: upErr.name,
              bucket: BUCKET,
              path: segPath,
              contentType,
              fileSizeMB: sizeMB,
            });
            throw new Error(
              `Storage upload rejected: ${upErr.message} (status=${upErr.statusCode ?? "?"})`,
            );
          }

          const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(segPath);
          uploadedUrls.push(pub.publicUrl);
        }

        mediaUrl = uploadedUrls[0]!;
        if (uploadedUrls.length > 1) {
          segmentUrls = uploadedUrls;
        }
      }

      // Upload thumbnail if provided (always JPEG)
      let thumbnailUrl: string | null = null;
      if (input.thumbnailUri) {
        const thumbPath = `${user.id}/${baseTs}_thumb.jpg`;
        try {
          const thumbBody = await uriToBlob(input.thumbnailUri);
          const { error: thumbErr } = await supabase.storage
            .from(BUCKET)
            .upload(thumbPath, thumbBody, { contentType: "image/jpeg", upsert: false });
          if (!thumbErr) {
            const { data: pubThumb } = supabase.storage.from(BUCKET).getPublicUrl(thumbPath);
            thumbnailUrl = pubThumb.publicUrl;
          } else {
            console.warn("[createPost] thumbnail upload failed", thumbErr.message);
          }
        } catch (thumbErr) {
          console.warn("[createPost] thumbnail upload error", (thumbErr as Error)?.message);
        }
      }

      // Build row with only columns that have actual values.
      const row: Record<string, unknown> = {
        user_id: user.id,
        media_url: mediaUrl,
        media_type: input.mediaType,
        caption: input.caption?.trim() || null,
        parent_post_id: input.parentPostId || null,
        segments: segmentUrls,
      };
      if (input.trimData && input.trimData.length > 0) {
        row.trim_data = input.trimData;
      }
      if (input.textOverlays && input.textOverlays.length > 0) {
        row.text_overlays = input.textOverlays;
      }
      if (thumbnailUrl) {
        row.thumbnail_url = thumbnailUrl;
      }
      console.log("[createPost] BEFORE insert — row keys:", Object.keys(row), "media_url:", (row.media_url as string)?.slice(0, 50));
      const { data: insData, error: insErr } = await supabase.from("posts").insert(row).select("id, created_at").single();
      console.log("[createPost] AFTER insert — result:", JSON.stringify({ hasData: !!insData, hasError: !!insErr, id: insData?.id, created_at: insData?.created_at, errorMessage: insErr?.message, errorCode: insErr?.code }));

      if (insErr) {
        const insErrAny = insErr as unknown as Record<string, unknown>;
        console.error("[createPost] insert FAIL", {
          message: insErr.message,
          code: insErr.code,
          details: insErr.details,
          hint: insErr.hint,
          status: insErrAny?.status,
          statusCode: insErrAny?.statusCode,
        });
        throw insErr;
      }

      // ── Validate insert returned actual data ────────────────────────
      if (!insData || !insData.id) {
        console.error("[createPost] insert returned no data — insData:", JSON.stringify(insData));
        throw new Error("Database insert completed but returned no row data. The post may not have been saved.");
      }

      if (input.draftId) {
        await deleteDraftProject(input.draftId);
      }

      // Return the inserted row data for optimistic updates
      return {
        id: insData.id as string,
        user_id: user.id,
        media_url: mediaUrl,
        media_type: input.mediaType,
        caption: (input.caption?.trim() || null),
        parent_post_id: input.parentPostId || null,
        segments: segmentUrls,
        audio_url: null,
        trim_data: input.trimData ?? null,
        text_overlays: input.textOverlays ?? null,
        thumbnail_url: thumbnailUrl,
        created_at: insData.created_at as string,
        like_count: 0,
        comment_count: 0,
        reaction_count: 0,
        profile: null,
      } as Post;
    },
    onSuccess: (newPost, variables) => {
      qc.invalidateQueries({ queryKey: ["posts"] });

      if (variables.optimisticTempId) {
        finalizeOptimisticPost(variables.optimisticTempId, newPost);
      }

      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        const filtered = old.filter(
          (p) => p._optimistic?.tempId !== variables.optimisticTempId
        );
        if (filtered.some((p) => p.id === newPost.id)) return filtered;
        return [newPost, ...filtered];
      });

      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return old;
        const filtered = (old ?? []).filter(
          (p) => p._optimistic?.tempId !== variables.optimisticTempId
        );
        if (filtered.some((p) => p.id === newPost.id)) return filtered;
        return [newPost, ...filtered];
      });

      persistOptimisticPosts();
    },
    onError: (err, variables) => {
      const errAny = err as unknown as Record<string, unknown> | undefined;
      console.error("[createPost] onError — FULL ERROR OBJECT", {
        message: (err as Error)?.message ?? String(err),
        name: (err as Error)?.name,
        code: errAny?.code,
        details: errAny?.details,
        hint: errAny?.hint,
        status: errAny?.status,
        statusCode: errAny?.statusCode,
        error: errAny?.error,
        cause: errAny?.cause,
      });
      if (variables.optimisticTempId) {
        failOptimisticPost(
          variables.optimisticTempId,
          (err as Error)?.message ?? "Upload failed"
        );
      }
    },
  });

  const retryOptimisticPost = useCallback(
    (tempId: string) => {
      const post = optimisticPosts.find((p) => p._optimistic?.tempId === tempId);
      if (!post?._optimistic?.retryPayload) return;

      setOptimisticPosts((prev) => {
        const next = prev.map((p) =>
          p._optimistic?.tempId === tempId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "uploading" as const, error: undefined },
              }
            : p
        );
        persistOptimisticPosts(next);
        return next;
      });

      // Also update the feed cache
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "uploading" as const, error: undefined },
              }
            : p
        );
      });

      try {
        const payload: OptimisticRetryPayload = JSON.parse(post._optimistic.retryPayload);
        createPost.mutate({
          uri: payload.uri,
          mediaType: payload.mediaType,
          caption: payload.caption,
          draftId: payload.draftId,
          segmentUris: payload.segmentUris,
          trimData: payload.trimData,
          textOverlays: payload.textOverlays,
          thumbnailUri: payload.thumbnailUri,
          optimisticTempId: tempId,
        });
      } catch (e) {
        console.error("[optimistic] retry parse error", e);
        failOptimisticPost(tempId, "Could not retry. Please try posting again.");
      }
    },
    [optimisticPosts, createPost, failOptimisticPost, persistOptimisticPosts, user?.id, qc]
  );

  return useMemo(
    () => ({
      feed: feedQuery.data ?? [],
      feedLoading: feedQuery.isLoading,
      refetchFeed: feedQuery.refetch,
      myPosts: myPostsQuery.data ?? [],
      refetchMyPosts: myPostsQuery.refetch,
      myProfile: myProfileQuery.data ?? null,
      refetchProfile: myProfileQuery.refetch,
      updateProfile,
      lastNightPosts: lastNightQuery.data ?? [],
      lastNightLoading: lastNightQuery.isLoading,
      refetchLastNight: lastNightQuery.refetch,
      following: followingQuery.data ?? [],
      suggestedUsers: suggestedQuery.data ?? [],
      suggestedLoading: suggestedQuery.isLoading,
      refetchSuggested: suggestedQuery.refetch,
      followUser,
      unfollowUser,
      hasPostedInWindow,
      draftProjects,
      draftsLoaded,
      saveDraftProject,
      deleteDraftProject,
      createPost,
      reactionsByParent: allReactionsQuery.data ?? {},
      reactionsLoading: allReactionsQuery.isLoading,
      refetchReactions: allReactionsQuery.refetch,
      optimisticPosts,
      addOptimisticPost,
      retryOptimisticPost,
    }),
    [
      feedQuery,
      myPostsQuery,
      myProfileQuery,
      updateProfile,
      lastNightQuery,
      allReactionsQuery,
      followingQuery,
      suggestedQuery,
      followUser,
      unfollowUser,
      hasPostedInWindow,
      draftProjects,
      draftsLoaded,
      saveDraftProject,
      deleteDraftProject,
      createPost,
      optimisticPosts,
      addOptimisticPost,
      retryOptimisticPost,
    ]
  );
});
