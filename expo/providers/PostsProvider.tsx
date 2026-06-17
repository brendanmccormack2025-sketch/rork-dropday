import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { decode } from "base64-arraybuffer";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { getDropWindowState, DROP_WINDOW } from "@/constants/theme";

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

/**
 * Read a local file URI into a Uint8Array for Supabase upload.
 * Uses expo-file-system base64 reading + base64-arraybuffer decode
 * because React Native does not support Blob/ArrayBuffer uploads with Supabase.
 */
async function uriToBlob(uri: string): Promise<Uint8Array> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) {
    throw new Error(`File read returned empty data from ${uri.slice(0, 60)}`);
  }
  const fileData = new Uint8Array(decode(base64));
  console.log(`[uriToBlob] decoded size=${fileData.byteLength} from ${uri.slice(0, 60)}`);
  return fileData;
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
    console.log("[WORKFLOW:SAVE:DRAFT:PERSIST] writing", next.length, "projects");
    setDraftProjects(next);
    try {
      await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      console.log("[WORKFLOW:SAVE:DRAFT:PERSIST] AsyncStorage write OK");
    } catch (e) {
      console.error("[WORKFLOW:SAVE:DRAFT:PERSIST] AsyncStorage write FAILED", e);
    }
  }, []);

  /** Save a full draft project — creates new or overwrites existing by id. */
  const saveDraftProject = useCallback(
    async (project: DraftProject) => {
      console.log("[WORKFLOW:SAVE:DRAFT] saveDraftProject called", {
        id: project.id,
        clipsLen: project.clips.length,
        hasThumbnail: !!project.coverThumbnailUri,
        textOverlaysLen: project.textOverlays.length,
      });
      const filtered = draftProjects.filter((d) => d.id !== project.id);
      const updated = { ...project, updatedAt: Date.now() };
      const next = [updated, ...filtered];
      console.log("[WORKFLOW:SAVE:DRAFT] persisting", next.length, "projects to AsyncStorage");
      await persistDraftProjects(next);
      console.log("[WORKFLOW:SAVE:DRAFT] persist OK");
      return updated;
    },
    [draftProjects, persistDraftProjects]
  );

  /** Delete a draft project by id — also cleans up permanent media files. */
  const deleteDraftProject = useCallback(
    async (id: string) => {
      // Remove permanent media files from document directory
      const draftDir = `${FileSystem.documentDirectory}drafts/${id}/`;
      try {
        const dirInfo = await FileSystem.getInfoAsync(draftDir);
        if (dirInfo.exists) {
          await FileSystem.deleteAsync(draftDir, { idempotent: true });
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
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      let data: unknown[] | null = null;
      try {
        const res = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, thumbnail_url, created_at, like_count, comment_count, profiles(username, display_name, avatar_url)"
          )
          .is("parent_post_id", null)
          .gte("created_at", since.toISOString())
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
      if (!user?.id) {
        console.log("[profile:query] no user.id, returning null");
        return null;
      }

      console.log("[profile:query] FETCHING for user", user.id.slice(0, 12));
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
        console.log("[profile:query] SUCCESS — got row", {
          id: data.id?.slice(0, 12),
          username: data.username,
          display_name: data.display_name,
          bio: data.bio?.slice(0, 30),
          avatar_url: data.avatar_url?.slice(0, 50),
        });
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

      console.log("[profile:query] NO ROW found for user", user.id.slice(0, 12));
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

  // Has the current user posted within tonight's drop window?
  const hasPostedInWindow = useMemo(() => {
    const win = getDropWindowState(nowForWindow);
    return (myPostsQuery.data ?? []).some((p) => {
      const t = new Date(p.created_at);
      return t >= win.windowStart && t < win.windowEnd;
    });
  }, [myPostsQuery.data, nowForWindow]);

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
    }) => {
      console.log("[createPost] START", {
        uri: input.uri?.slice(0, 60),
        mediaType: input.mediaType,
        captionLength: input.caption?.length ?? 0,
        hasCaption: !!input.caption,
        parentPostId: input.parentPostId ?? null,
        segmentCount: input.segmentUris?.length ?? 0,
      });

      if (!user?.id) {
        console.error("[createPost] FAIL — no user.id");
        throw new Error("Not signed in.");
      }

      const win = getDropWindowState(new Date());
      console.log("[createPost] dropWindow", { isOpen: win.isOpen });
      if (!win.isOpen) {
        console.error("[createPost] FAIL — window closed");
        throw new Error("Drop window is closed. Save as draft and post when it opens at 8 PM.");
      }

      const baseTs = Date.now();
      const isRemoteUrl = input.uri.startsWith("http");
      console.log("[createPost] isRemoteUrl:", isRemoteUrl);

      let mediaUrl: string;
      let segmentUrls: string[] | null = null;

      if (isRemoteUrl) {
        mediaUrl = input.uri;
        segmentUrls = input.segmentUris ?? null;
        console.log("[createPost] using remote URL, skipping upload");
      } else {
        const urisToUpload = input.segmentUris && input.segmentUris.length > 0
          ? input.segmentUris
          : [input.uri];

        console.log("[createPost] uploading", urisToUpload.length, "file(s) to bucket", BUCKET);

        const uploadedUrls: string[] = [];
        for (let i = 0; i < urisToUpload.length; i++) {
          const segUri = urisToUpload[i]!;
          const segExt = input.mediaType === "video" ? "mp4" : "jpg";
          const segPath = `${user.id}/${baseTs}_seg${i}.${segExt}`;
          const contentType = input.mediaType === "video" ? "video/mp4" : "image/jpeg";

          console.log(`[createPost] upload [${i}]`, { path: segPath, uri: segUri?.slice(0, 60) });

          let body: Uint8Array;
          try {
            body = await uriToBlob(segUri);
            console.log(`[createPost] decoded [${i}]`, { byteLength: body.byteLength });
          } catch (e) {
            console.error(`[createPost] uriToBlob FAIL [${i}]`, (e as Error)?.message ?? e);
            throw new Error(`Failed to read file: ${(e as Error)?.message ?? "unknown error"}`);
          }

          const { data: upData, error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(segPath, body, { contentType, upsert: false });

          if (upErr) {
            console.error(`[createPost] upload FAIL [${i}]`, {
              message: upErr.message,
              name: upErr.name,
            });
            throw upErr;
          }
          console.log(`[createPost] upload OK [${i}]`, { path: upData?.path });

          const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(segPath);
          console.log(`[createPost] publicUrl [${i}]`, pub?.publicUrl?.slice(0, 80));
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
      console.log("[createPost] inserting row", {
        keys: Object.keys(row),
        media_url: mediaUrl.slice(0, 80),
        hasTrimData: !!input.trimData?.length,
        hasTextOverlays: !!input.textOverlays?.length,
      });

      const { data: insData, error: insErr } = await supabase.from("posts").insert(row).select("id, created_at").single();

      if (insErr) {
        console.error("[createPost] insert FAIL", {
          message: insErr.message,
          code: insErr.code,
          details: insErr.details,
          hint: insErr.hint,
        });
        throw insErr;
      }

      console.log("[createPost] insert OK", { id: insData?.id, created_at: insData?.created_at });

      if (input.draftId) {
        await deleteDraftProject(input.draftId);
      }

      // Return the inserted row data for optimistic updates
      return {
        id: insData!.id as string,
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
        created_at: insData!.created_at as string,
        like_count: 0,
        comment_count: 0,
        reaction_count: 0,
        profile: null,
      } as Post;
    },
    onSuccess: (newPost) => {
      console.log("[createPost] onSuccess — invalidating [\"posts\"] queries");
      qc.invalidateQueries({ queryKey: ["posts"] });

      // Optimistic: prepend the new post to the feed cache immediately
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        // Avoid duplicates
        if (old.some((p) => p.id === newPost.id)) return old;
        console.log("[createPost] optimistic prepend to feed cache");
        return [newPost, ...old];
      });

      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return old;
        if (old.some((p) => p.id === newPost.id)) return old;
        return [newPost, ...old];
      });
    },
    onError: (err) => {
      console.error("[createPost] onError", (err as Error)?.message ?? err);
    },
  });

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
    ]
  );
});
