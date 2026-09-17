import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { documentDirectory, cacheDirectory, getInfoAsync, deleteAsync, downloadAsync } from "@/lib/fileSystemCompat";
import { showAlert } from "@/lib/showAlert";
import { supabase, supabaseUrl, supabaseAnonKey } from "@/lib/supabase";
import { concatMP4Files } from "@/src/integrations/concatMP4";

/**
 * Returns the device's IANA timezone string (e.g. 'America/New_York').
 * Falls back to a UTC offset string if the runtime doesn't support
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 */
function getDeviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.length > 0) return tz;
  } catch {
    // ignore
  }
  // Fallback: construct a UTC offset like 'UTC-5'
  const offset = -new Date().getTimezoneOffset() / 60;
  return `UTC${offset >= 0 ? '+' : ''}${offset}`;
}

import { useAuth, ensureProfileById } from "@/providers/AuthProvider";
import { useUserBlocks } from "@/hooks/useUserBlocks";

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
  text_overlays: TextOverlay[] | null;
  thumbnail_url: string | null;
  created_at: string;
  like_count?: number;
  comment_count?: number;
  reaction_count?: number;
  /** Mature-content flag (server-side filtered for teen viewers). */
  is_mature?: boolean;
  /** Moderation status: 'active' (visible), 'hidden' (auto/flagged), 'removed' (confirmed violation). */
  moderation_status?: string;
  profile?: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Present only on optimistic (not-yet-uploaded) posts */
  _optimistic?: {
    tempId: string;
    status: OptimisticStatus;
    /** Upload progress 0–100, only meaningful when status is "uploading" */
    progress?: number;
    error?: string;
    retryPayload?: string;
    /** The parent_post_id this post will have once uploaded.
     *  null for root Drops; set for reactions. Used to decide which
     *  caches the optimistic entry should be inserted into. */
    parentPostId: string | null;
  };
};

export type SuggestedUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type ExploreCreator = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  total_engagement: number;
};

export type Conversation = {
  id: string;
  participant_1_id: string;
  participant_2_id: string;
  created_at: string;
  /** The OTHER user in the conversation (not the current user) */
  otherProfile?: {
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Preview of the most recent message */
  lastMessage?: {
    text: string | null;
    post_id: string | null;
    sender_id: string;
    created_at: string;
  } | null;
};

export type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  text: string | null;
  post_id: string | null;
  created_at: string;
  /** Joined profile of the sender */
  senderProfile?: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Joined post data when this is a shared Drop */
  sharedPost?: {
    id: string;
    media_url: string;
    media_type: "image" | "video";
    thumbnail_url: string | null;
    caption: string | null;
    user_id: string;
    profile?: {
      username: string;
      display_name: string | null;
      avatar_url: string | null;
    } | null;
  } | null;
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
  /** ISO date string (YYYY-MM-DD) or null if not set. */
  birthdate: string | null;
  /** Consecutive nightly drop streak count. */
  current_streak: number;
  /** ISO date string of the last top-level Drop, or null. */
  last_post_date: string | null;
  /** Demo/reviewer flag: skip the 8-10 PM Drop posting window. */
  bypass_drop_window: boolean;
};

/** Age tier derived from a birthdate. "unknown" when birthdate is missing. */
export type AgeTier = "under_13" | "teen" | "adult" | "unknown";

/** Compute a viewer's age tier client-side from a birthdate string. */
export function computeAgeTier(birthdate: string | null | undefined): AgeTier {
  if (!birthdate) return "unknown";
  const bd = new Date(birthdate);
  if (Number.isNaN(bd.getTime())) return "unknown";
  const now = new Date();
  let age = now.getFullYear() - bd.getFullYear();
  const hadBirthday =
    now.getMonth() > bd.getMonth() ||
    (now.getMonth() === bd.getMonth() && now.getDate() >= bd.getDate());
  if (!hadBirthday) age -= 1;
  if (age < 13) return "under_13";
  if (age < 18) return "teen";
  return "adult";
}

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
 * Resolve an avatar_url value into a full public URL suitable for Image source.
 *
 * Handles three cases:
 * 1. Already a full https:// URL → returns as-is
 * 2. A Supabase storage path like "user_id/avatar_123.jpg" → constructs full public URL
 * 3. null / undefined / empty → returns null (caller should show initials fallback)
 */
export function resolveAvatarUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length === 0) return null;
  if (raw.startsWith("http")) return raw;
  // Looks like a storage path — construct the full public URL
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(raw);
  return data?.publicUrl ?? null;
}
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
 * Read a local file URI into a Uint8Array.
 * Used only on web where expo-file-system's streaming upload isn't available.
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

/**
 * Upload a file to Supabase Storage using a FOREGROUND HTTP request.
 *
 * On native (iOS/Android), uses XMLHttpRequest which creates a standard
 * NSURLSessionDataTask — this is a FOREGROUND task that does NOT use the
 * fragile background transfer service. Background uploads (expo-file-system's
 * uploadAsync) get terminated when the app loses focus, producing -997 errors.
 *
 * XMLHttpRequest also fires upload.onprogress events, giving us real
 * percentage tracking so the user can see upload progress.
 *
 * On web, falls back to fetch + FormData (converts data: URIs to Blob first).
 *
 * Retries once automatically on timeout with a 2-second delay. Each retry
 * creates a completely fresh XMLHttpRequest/request — we never reuse a broken
 * session or task reference.
 */
async function uploadToStorage(
  fileUri: string,
  storagePath: string,
  contentType: string,
  sizeMB: string,
  attempt: number = 1,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const maxRetries = 2;


  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    console.error("[uploadToStorage] ABORT — no access token from session");
    throw new Error("Not authenticated — cannot upload files.");
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${storagePath}`;

  const startTime = Date.now();

  try {
    if (Platform.OS === "ios" || Platform.OS === "android") {
      // ── Native: FOREGROUND upload via XMLHttpRequest ───────────────
      //    This creates a standard NSURLSessionDataTask (NOT background),
      //    avoiding the -997 "Lost connection to background transfer
      //    service" error that expo-file-system's uploadAsync produces.
      //    Each retry creates a completely new XHR — never reuse a
      //    broken session.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl);
        xhr.setRequestHeader("apikey", supabaseAnonKey);
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("x-upsert", "false");

        // Fire progress events so the UI can show "Uploading... 45%"
        xhr.upload.onprogress = (event: ProgressEvent) => {
          if (event.lengthComputable && onProgress) {
            onProgress(event.loaded, event.total);
          }
        };

        xhr.onload = () => {
          const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            const errBody = (xhr.responseText ?? "no body").slice(0, 300);
            console.error(
              `[uploadToStorage] FAIL HTTP ${xhr.status}: ${errBody}`,
            );
            reject(
              new Error(
                `Storage returned HTTP ${xhr.status}: ${errBody}`,
              ),
            );
          }
        };

        xhr.onerror = () => {
          reject(
            new Error(
              `Network request failed (status=${xhr.status || "?"})`,
            ),
          );
        };

        xhr.ontimeout = () => {
          reject(new Error("Upload timed out"));
        };

        // Build FormData with the local file URI.
        // React Native streams the file directly from disk — no need
        // to load the entire video into memory.
        const formData = new FormData();
        formData.append("file", {
          uri: fileUri,
          type: contentType,
          name: storagePath.split("/").pop() ?? "file",
        } as unknown as Blob);

        xhr.send(formData);
      });
    } else {
      // ── Web: fetch + FormData ──────────────────────────────────────

      // Fire initial progress so the UI updates from "Uploading... 0%"
      if (onProgress) onProgress(0, 1);

      let body: Blob | { uri: string; type: string; name: string };

      if (fileUri.startsWith("data:") || fileUri.startsWith("blob:")) {
        const blobStart = Date.now();
        try {
          body = await fetch(fileUri).then((r) => r.blob());
        } catch (blobErr) {
          console.error("[uploadToStorage] WEB — FAILED to create Blob from data/blob URI:", {
            message: (blobErr as Error)?.message,
            name: (blobErr as Error)?.name,
            fileUriStart: fileUri.slice(0, 60),
          });
          throw blobErr;
        }
        // Show "preparing" progress
        if (onProgress) onProgress(0.1, 1);
      } else {
        body = {
          uri: fileUri,
          type: contentType,
          name: storagePath.split("/").pop() ?? "file",
        } as unknown as { uri: string; type: string; name: string };
      }

      const formData = new FormData();
      formData.append("file", body as unknown as Blob);

      // Show "uploading" progress after prep
      if (onProgress) onProgress(0.2, 1);

      let response: Response;
      try {
        response = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
            "x-upsert": "false",
          },
          body: formData,
        });
      } catch (fetchErr) {
        const fetchErrAny = fetchErr as unknown as Record<string, unknown> | undefined;
        console.error("[uploadToStorage] WEB — fetch() THREW:", {
          message: (fetchErr as Error)?.message,
          name: (fetchErr as Error)?.name,
          cause: fetchErrAny?.cause,
          stack: (fetchErr as Error)?.stack?.slice(0, 300),
        });
        throw fetchErr;
      }

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

      // Log response headers for debugging
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      if (!response.ok) {
        const errText = await response
          .text()
          .catch(() => "could not read error body");
        console.error(
          `[uploadToStorage] WEB — FAIL HTTP ${response.status}: ${errText.slice(0, 300)}`,
        );
        throw new Error(
          `Storage returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
        );
      }

      // Fire 100% on success
      if (onProgress) onProgress(1, 1);
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const durationSec = (durationMs / 1000).toFixed(1);

    // Dump the FULL error object — not just message
    const errAny = err as unknown as Record<string, unknown> | undefined;
    const errMsg = (err as Error)?.message ?? String(err);
    const statusCode =
      errAny?.status ?? errAny?.statusCode ?? errAny?.code ?? "?";
    const isTimeout =
      errMsg.toLowerCase().includes("timeout") ||
      errMsg.toLowerCase().includes("timed out") ||
      statusCode === 408 ||
      durationMs > 25000;

    console.error(
      `[uploadToStorage] FAILED after ${durationSec}s (attempt ${attempt}/${maxRetries})`,
      {
        message: errMsg,
        name: (err as Error)?.name,
        stack: (err as Error)?.stack?.slice(0, 500),
        status: errAny?.status,
        statusCode: errAny?.statusCode,
        code: errAny?.code,
        cause: errAny?.cause,
        isTimeout,
        bucket: BUCKET,
        path: storagePath,
        contentType,
        fileSizeMB: sizeMB,
        durationMs,
        fullError: JSON.stringify(errAny, null, 2).slice(0, 500),
      },
    );

    if (attempt < maxRetries && isTimeout) {
      // Wait so any lingering broken session fully closes before retrying
      await new Promise((r) => setTimeout(r, 2000));
      return uploadToStorage(
        fileUri,
        storagePath,
        contentType,
        sizeMB,
        attempt + 1,
        onProgress,
      );
    }

    if (isTimeout) {
      throw new Error(
        `Upload timed out after ${durationSec}s (${sizeMB} MB file). The network may be slow. Please try again.`,
      );
    }
    throw err;
  }
}

function rankFeed(posts: Post[], followingIds: string[], currentUserId?: string): Post[] {
  if (posts.length === 0) return posts;
  const follows = new Set(followingIds);
  const now = Date.now();

  const scored = posts.map((p) => {
    const ageMs = now - new Date(p.created_at).getTime();
    const ageHours = Math.max(0, ageMs / 3.6e6);
    const freshness = Math.exp(-ageHours / 12);
    const engagement = Math.log1p((p.like_count ?? 0) + 2 * (p.comment_count ?? 0));
    const followBoost = follows.has(p.user_id) ? 3.5 : 0;
    const jitter = Math.random() * 0.15;
    // Brief self-boost: guarantee the user's own just-posted drop stays at
    // the top for ~90s, then normal ranking resumes. Uses ageMs (ms) vs
    // 90_000 ms — NOT ageHours, which is in HOURS.
    const isOwn = currentUserId != null && p.user_id === currentUserId;
    const selfBoost = isOwn && ageMs < 90_000 ? 10 : 0;
    const score = followBoost + engagement * 1.2 + freshness * 2.5 + jitter + selfBoost;
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

/**
 * Rank the "Following" feed: chronological (newest first) with a
 * brief self-boost so the user's own just-posted drop stays at the top.
 *
 * Tiers (highest surfaces first):
 *   2 — own post created < 90s ago (self-boost)
 *   0 — everything else
 * Within each tier, posts are ordered by created_at descending.
 */
function rankFollowingFeed(posts: Post[], currentUserId?: string): Post[] {
  if (posts.length === 0) return posts;
  const now = Date.now();

  const annotated = posts.map((p) => {
    const created = new Date(p.created_at);
    const ageMs = now - created.getTime();
    const isOwn = currentUserId != null && p.user_id === currentUserId;
    const selfBoost = isOwn && ageMs < 90_000;
    const tier = selfBoost ? 2 : 0;
    return { p, tier, createdMs: created.getTime() };
  });

  annotated.sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    return b.createdMs - a.createdMs;
  });

  return annotated.map((a) => a.p);
}

export const [PostsProvider, usePosts] = createContextHook(() => {
  const auth = useAuth();
  const user = auth.user;
  const { blockedUserIds } = useUserBlocks();
  const qc = useQueryClient();

  const [draftProjects, setDraftProjects] = useState<DraftProject[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);

  // Timestamp of the most recent successful post creation — used by the feed
  // screen's useFocusEffect to skip a refetch that would overwrite the
  // onSuccess cache patch (which inserts the new post at the top).
  const lastPostCreatedAtRef = useRef<number>(0);

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
    staleTime: 30_000,
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

  // ── My reports ────────────────────────────────────────────────────────
  // Fetches the current user's own report rows so reported content can be
  // filtered out on the read side (client-side exclusion). Cached for 120s.
  //
  // IMPORTANT: This query does NOT depend on useAuth() context for the user
  // id — it calls supabase.auth.getSession() directly inside the queryFn.
  // This sidesteps any context-propagation issues in dev/HMR where the
  // AuthProvider's user value can be transiently null. The queryKey is a
  // stable constant (no user id) so React Query never re-subscribes due to
  // context changes, and the queryFn gracefully returns [] when no session
  // exists.
  const myReportsQuery = useQuery({
    queryKey: ["reports", "mine"],
    enabled: true,
    retry: 1,
    staleTime: 120_000,
    queryFn: async (): Promise<Array<{ target_id: string; target_type: string }>> => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const currentUserId = sessionData.session?.user?.id;
        if (!currentUserId) return [];

        const { data, error } = await supabase
          .from("reports")
          .select("target_id, target_type")
          .eq("reporter_id", currentUserId);
        if (error) {
          console.warn("[reports] fetch error", error.message);
          return [];
        }
        return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          target_id: row.target_id as string,
          target_type: row.target_type as string,
        }));
      } catch (e) {
        console.warn("[reports] unexpected error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  /** Set of post IDs the current user has reported — used to filter them
   *  out of feed/liked/mine results on the read side. */
  const reportedPostIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of myReportsQuery.data ?? []) {
      if (r.target_type === "post") set.add(r.target_id);
    }
    return set;
  }, [myReportsQuery.data]);

  /** Set of reaction IDs the current user has reported — used to filter
   *  them out of reaction-tree/reactions-list results on the read side. */
  const reportedReactionIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of myReportsQuery.data ?? []) {
      if (r.target_type === "reaction") set.add(r.target_id);
    }
    return set;
  }, [myReportsQuery.data]);

  const feedQuery = useQuery({
    queryKey: ["posts", "fyp", user?.id],
    retry: 1,
    staleTime: 30_000,
    queryFn: async (): Promise<Post[]> => {
      // Server-side mature-content filtering: teen viewers never receive
      // is_mature posts. Adult/unknown tiers see everything. (Under-13
      // users can't sign up, but we treat unknown conservatively as
      // adult here so existing users without a birthdate aren't locked
      // out — they simply see everything until they set a birthdate.)
      let viewerTier: AgeTier = "unknown";
      if (user?.id) {
        try {
          const { data: prof } = await supabase
            .from("profiles")
            .select("birthdate")
            .eq("id", user.id)
            .maybeSingle();
          viewerTier = computeAgeTier(prof?.birthdate as string | null);
        } catch {
          // keep "unknown" — fail open so users can still see content
        }
      }
      const hideMature = viewerTier === "teen";
      let data: unknown[] | null = null;
      try {
        let q = supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, text_overlays, thumbnail_url, is_mature, moderation_status, created_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)"
          )
          .is("parent_post_id", null)
          .eq("moderation_status", "active")
          .neq("status", "archived")
          .order("created_at", { ascending: false })
          .limit(300);
        if (hideMature) {
          q = q.neq("is_mature", true);
        }
        const res = await q;
        if (res.error) {
          logQueryError("feed", res.error);
          return [];
        }
        data = res.data as unknown[] | null;
      } catch (e) {
        logQueryError("feed", e);
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
        text_overlays: (row.text_overlays as Post["text_overlays"]) ?? null,
        thumbnail_url: (row.thumbnail_url as string | null) ?? null,
        is_mature: (row.is_mature as boolean | null) ?? false,
        moderation_status: (row.moderation_status as string | undefined) ?? "active",
        created_at: row.created_at as string,
        like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
        comment_count: (row.comment_count as number | undefined) ?? 0,
        reaction_count: (row.reaction_count as number | undefined) ?? 0,
        profile: (row.profiles as Post["profile"]) ?? null,
      }));
      return rankFeed(raw, followingQuery.data ?? [], user?.id);
    },
  });

  // ── Following feed: chronological with live-window sort override ──
  // Fetches posts only from users the current user follows, ordered by
  // created_at descending. rankFollowingFeed applies a live-window tier
  // boost (posts in tonight's drop window surface to the top) and a brief
  // 90-second self-boost so the user's own just-posted drop stays #1.
  const followingFeedQuery = useQuery({
    queryKey: ["posts", "following-feed", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 30_000,
    queryFn: async (): Promise<Post[]> => {
      const followingIds = followingQuery.data ?? [];
      if (!user?.id || followingIds.length === 0) return [];
      let viewerTier: AgeTier = "unknown";
      try {
        const { data: prof } = await supabase
          .from("profiles")
          .select("birthdate")
          .eq("id", user.id)
          .maybeSingle();
        viewerTier = computeAgeTier(prof?.birthdate as string | null);
      } catch {
        // keep "unknown" — fail open
      }
      const hideMature = viewerTier === "teen";
      try {
        let q = supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, text_overlays, thumbnail_url, is_mature, moderation_status, created_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)"
          )
          .is("parent_post_id", null)
          .eq("moderation_status", "active")
          .neq("status", "archived")
          .in("user_id", followingIds)
          .order("created_at", { ascending: false })
          .limit(200);
        if (hideMature) {
          q = q.neq("is_mature", true);
        }
        const res = await q;
        if (res.error) {
          logQueryError("following-feed", res.error);
          return [];
        }
        const raw: Post[] = ((res.data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          text_overlays: (row.text_overlays as Post["text_overlays"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          is_mature: (row.is_mature as boolean | null) ?? false,
          moderation_status: (row.moderation_status as string | undefined) ?? "active",
          created_at: row.created_at as string,
          like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
        return rankFollowingFeed(raw, user.id);
      } catch (e) {
        logQueryError("following-feed", e);
        return [];
      }
    },
  });

  const myPostsQuery = useQuery({
    queryKey: ["posts", "mine", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 120_000,
    queryFn: async (): Promise<Post[]> => {
      if (!user?.id) return [];
      try {
        const { data, error } = await supabase
          .from("posts")
          .select("id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, text_overlays, thumbnail_url, moderation_status, created_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)")
          .eq("user_id", user.id)
          .eq("moderation_status", "active")
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) {
          logQueryError("mine", error);
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
          text_overlays: (row.text_overlays as Post["text_overlays"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          moderation_status: (row.moderation_status as string | undefined) ?? "active",
          created_at: row.created_at as string,
          like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
      } catch (e) {
        logQueryError("mine", e);
        return [];
      }
    },
  });

  // Liked posts — fetches all posts the current user has liked
  const likedPostsQuery = useQuery({
    queryKey: ["posts", "liked", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 120_000,
    queryFn: async (): Promise<Post[]> => {
      if (!user?.id) return [];
      try {
        const { data: likeRows, error: likeErr } = await supabase
          .from("likes")
          .select("post_id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        if (likeErr || !likeRows?.length) return [];

        const postIds = likeRows.map((r: { post_id: string }) => r.post_id);
        const { data: postRows, error: postErr } = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, text_overlays, thumbnail_url, moderation_status, created_at, likes(count), comment_count, reaction_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)"
          )
          .in("id", postIds)
          .eq("moderation_status", "active");
        if (postErr || !postRows) return [];

        const idOrder = new Map(postIds.map((id, i) => [id, i]));
        const posts: Post[] = (postRows as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          text_overlays: (row.text_overlays as Post["text_overlays"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          moderation_status: (row.moderation_status as string | undefined) ?? "active",
          created_at: row.created_at as string,
          like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: (row.profiles as Post["profile"]) ?? null,
        }));
        posts.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));
        return posts;
      } catch (e) {
        logQueryError("liked", e);
        return [];
      }
    },
  });

  // ── Like / Unlike mutations ───────────────────────────────────────────
  const toggleLike = useMutation({
    mutationFn: async ({ postId, liked }: { postId: string; liked: boolean }) => {
      if (!user?.id) throw new Error("Not signed in.");
      if (liked) {
        await supabase.from("likes").insert({ user_id: user.id, post_id: postId });
      } else {
        await supabase.from("likes").delete().eq("user_id", user.id).eq("post_id", postId);
      }
    },
    onMutate: async ({ postId, liked }) => {
      // Snapshot current feed caches for rollback on error
      const prevFyp = qc.getQueryData<Post[]>(["posts", "fyp", user?.id]);
      const prevFollowing = qc.getQueryData<Post[]>(["posts", "following-feed", user?.id]);
      const prevMine = qc.getQueryData<Post[]>(["posts", "mine", user?.id]);

      // Optimistically patch like_count in place — no refetch, no reorder
      const delta = liked ? 1 : -1;
      if (prevFyp) {
        qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) =>
          (old ?? []).map((p) =>
            p.id === postId ? { ...p, like_count: (p.like_count ?? 0) + delta } : p
          )
        );
      }
      if (prevFollowing) {
        qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) =>
          (old ?? []).map((p) =>
            p.id === postId ? { ...p, like_count: (p.like_count ?? 0) + delta } : p
          )
        );
      }
      if (prevMine) {
        qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) =>
          (old ?? []).map((p) =>
            p.id === postId ? { ...p, like_count: (p.like_count ?? 0) + delta } : p
          )
        );
      }

      return { prevFyp, prevFollowing, prevMine };
    },
    onError: (_error, _vars, context) => {
      // Rollback optimistic cache patches
      if (context?.prevFyp) {
        qc.setQueryData(["posts", "fyp", user?.id], context.prevFyp);
      }
      if (context?.prevFollowing) {
        qc.setQueryData(["posts", "following-feed", user?.id], context.prevFollowing);
      }
      if (context?.prevMine) {
        qc.setQueryData(["posts", "mine", user?.id], context.prevMine);
      }
      // Re-sync likedPosts so FeedItem's likedOptimistic useEffect reverts
      qc.invalidateQueries({ queryKey: ["posts", "liked"] });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["posts", "liked"] });
    },
  });

  // Suggested users — profiles NOT followed by current user (excluding self)
  const myProfileQuery = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 120_000,
    queryFn: async (): Promise<MyProfile | null> => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, bio, website, instagram_handle, tiktok_handle, birthdate, current_streak, last_post_date, bypass_drop_window")
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
          birthdate: (data.birthdate as string | null) ?? null,
          current_streak: (data.current_streak as number | null) ?? 0,
          last_post_date: (data.last_post_date as string | null) ?? null,
          bypass_drop_window: (data.bypass_drop_window as boolean | null) ?? false,
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
    staleTime: 120_000,
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

  // ── Explore tab: suggested creators ranked by engagement ──────────
  const exploreCreatorsQuery = useQuery({
    queryKey: ["explore", "creators"],
    retry: 1,
    staleTime: 120_000,
    queryFn: async (): Promise<ExploreCreator[]> => {
      try {
        const { data, error } = await supabase.rpc("get_explore_creators");
        if (error) {
          console.warn("[explore:creators] error", error.message);
          return [];
        }
        return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: row.id as string,
          username: row.username as string,
          display_name: (row.display_name as string | null) ?? null,
          avatar_url: (row.avatar_url as string | null) ?? null,
          total_engagement: (row.total_engagement as number) ?? 0,
        }));
      } catch (e) {
        console.warn("[explore:creators] fetch error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  const followUser = useMutation({
    mutationFn: async (followeeId: string) => {
      if (!user?.id) throw new Error("Not signed in.");
      const { data, error } = await supabase
        .from("follows")
        .insert({ follower_id: user.id, followee_id: followeeId });
      if (error) throw error;
    },
    onSuccess: (_data, followeeId) => {
      qc.invalidateQueries({ queryKey: ["follows"] });
      qc.invalidateQueries({ queryKey: ["suggested"] });
      qc.invalidateQueries({ queryKey: ["posts"] });
      qc.invalidateQueries({ queryKey: ["followers-count", followeeId] });
      qc.invalidateQueries({
        queryKey: ["is-following"],
        predicate: (query) => query.queryKey[2] === followeeId,
      });
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
    onSuccess: (_data, followeeId) => {
      qc.invalidateQueries({ queryKey: ["follows"] });
      qc.invalidateQueries({ queryKey: ["suggested"] });
      qc.invalidateQueries({ queryKey: ["posts"] });
      qc.invalidateQueries({ queryKey: ["followers-count", followeeId] });
      qc.invalidateQueries({
        queryKey: ["is-following"],
        predicate: (query) => query.queryKey[2] === followeeId,
      });
    },
  });

  const allReactionsQuery = useQuery({
    queryKey: ["posts", "all-reactions"],
    retry: 1,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, Post[]>> => {
      try {
        const { data, error } = await supabase
          .from("posts")
          .select(
            "id, user_id, media_url, media_type, caption, parent_post_id, segments, audio_url, trim_data, text_overlays, thumbnail_url, moderation_status, created_at, likes(count), comment_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)"
          )
          .not("parent_post_id", "is", null)
          .eq("moderation_status", "active")
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) {
          logQueryError("reactions", error);
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
          text_overlays: (row.text_overlays as Post["text_overlays"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          moderation_status: (row.moderation_status as string | undefined) ?? "active",
          created_at: row.created_at as string,
          like_count: (row.likes as Array<{ count: number }> | undefined)?.[0]?.count ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
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
        logQueryError("reactions", e);
        return {};
      }
    },
  });

  // Track the most recent query error so developers can inspect it during testing.
  // Errors are still caught gracefully (returning empty arrays to users), but the
  // full error shape is preserved here for diagnostic visibility.
  const [lastQueryError, setLastQueryError] = useState<{
    query: string;
    message: string;
    code?: string;
    details?: string;
    hint?: string;
    ts: number;
  } | null>(null);

  const logQueryError = (query: string, error: unknown) => {
    const err = error as Record<string, unknown> | undefined;
    const entry = {
      query,
      message: (err?.message as string) ?? String(error),
      code: err?.code as string | undefined,
      details: err?.details as string | undefined,
      hint: err?.hint as string | undefined,
      ts: Date.now(),
    };
    console.error(`[posts] ${query} FAILED`, entry);
    setLastQueryError(entry);
  };

  // MVP: posting-participation gate stub — currently checks if the user has
  // ANY post at all. (Previously gated on having posted during the current
  // drop window; the window no longer exists.)
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
    (payload: OptimisticRetryPayload, parentPostId?: string | null): string => {
      const tempId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optPost: Post = {
        id: tempId,
        user_id: user?.id ?? "",
        media_url: payload.uri,
        media_type: payload.mediaType,
        caption: payload.caption ?? null,
        parent_post_id: parentPostId ?? null,
        segments: payload.segmentUris ?? null,
        audio_url: null,
        trim_data: payload.trimData ?? null,
        text_overlays: payload.textOverlays ?? null,
        thumbnail_url: payload.thumbnailUri ?? null,
        created_at: new Date().toISOString(),
        like_count: 0,
        comment_count: 0,
        reaction_count: 0,
        profile: null,
        _optimistic: {
          tempId,
          status: "uploading",
          progress: 0,
          retryPayload: JSON.stringify(payload),
          parentPostId: parentPostId ?? null,
        },
      };

      setOptimisticPosts((prev) => {
        const next = [optPost, ...prev];
        persistOptimisticPosts(next);
        return next;
      });

      // Only root Drops (parent_post_id is null) belong in the main feed cache.
      // Reactions belong in the reaction-tree query, which fetches from the DB
      // independently — optimistic entries would pollute the fyp cache.
      if (!parentPostId) {
        qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
          if (!old) return [optPost];
          return [optPost, ...old];
        });
        // Also insert into the following-feed cache — the user's own posts
        // appear there via the self-boost tier, so the optimistic entry must
        // be visible immediately while the upload is in flight.
        qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
          if (!old) return [optPost];
          return [optPost, ...old];
        });
      }
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

  /** Update the upload progress of an optimistic post (0–100).
   *  Fires from createPost's onProgress callback during background upload.
   *  Only touches the fyp cache if the post is a root Drop (no parent). */
  const updateOptimisticProgress = useCallback(
    (tempId: string, progress: number) => {
      setOptimisticPosts((prev) => {
        const next = prev.map((p) =>
          p._optimistic?.tempId === tempId
            ? {
                ...p,
                _optimistic: { ...p._optimistic, progress },
              }
            : p
        );
        // Don't persist on every progress tick — too much I/O
        return next;
      });

      // Only update fyp cache for root Drops — reactions aren't in this cache.
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, progress },
              }
            : p
        );
      });
      qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, progress },
              }
            : p
        );
      });
    },
    [user?.id, qc]
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

      // Only update fyp cache for root Drops — reactions aren't in this cache.
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "failed" as const, error },
              }
            : p
        );
      });
      qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
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
      isMature?: boolean;
      optimisticTempId?: string;
      onProgress?: (percent: number) => void;
    }) => {

      if (!user?.id) {
        console.error("[createPost] mutationFn ABORT — no user.id");
        throw new Error("Not signed in.");
      }

      const baseTs = Date.now();
      const isRemoteUrl = input.uri.startsWith("http");

      // ── Stitch reaction clip to parent clip BEFORE uploading ────────
      // DISABLED: Reactions are standalone single-clip videos attached to
      // a parent via parent_post_id. The stitch path was failing silently
      // and preventing the upload + insert from ever reaching Supabase.
      // Commented out for later revisit — do NOT delete.
      let uploadUri = input.uri;
      let parentDownloadUri: string | null = null;
      let stitchedUri: string | null = null;

      /*
      if (input.parentPostId && input.mediaType === "video" && !isRemoteUrl) {
        try {
          input.onProgress?.(5);

          // Fetch parent post to get its media_url
          const { data: parentPost, error: parentErr } = await supabase
            .from("posts")
            .select("media_url")
            .eq("id", input.parentPostId)
            .single();

          if (parentErr || !parentPost?.media_url) {
            console.warn(
              "[createPost] STITCH: could not fetch parent post — uploading reaction alone",
              parentErr?.message,
            );
          } else {
            const parentUrl = parentPost.media_url as string;

            // Download parent clip to cache directory
            parentDownloadUri = cacheDirectory + `stitch_parent_${baseTs}.mp4`;
            input.onProgress?.(10);

            const downloadResult = await downloadAsync(parentUrl, parentDownloadUri);

            if (!downloadResult || downloadResult.status < 200 || downloadResult.status >= 300) {
              console.warn(
                "[createPost] STITCH: parent download failed (status " +
                  (downloadResult?.status ?? "unknown") +
                  ") — uploading reaction alone",
              );
              await deleteAsync(parentDownloadUri, { idempotent: true }).catch(() => {});
              parentDownloadUri = null;
            } else {
              input.onProgress?.(20);

              // Stitch: parent + reaction
              stitchedUri = cacheDirectory + `stitch_output_${baseTs}.mp4`;

              const stitchResult = await concatMP4Files(
                parentDownloadUri,
                input.uri,
                stitchedUri,
              );

              if (!stitchResult.success) {
                console.error(
                  "[createPost] STITCH FAILED:",
                  stitchResult.error,
                  "— uploading reaction alone",
                );
                await deleteAsync(stitchedUri, { idempotent: true }).catch(() => {});
                stitchedUri = null;
              } else {
                uploadUri = stitchedUri;
              }
            }
          }
        } catch (stitchErr) {
          console.error(
            "[createPost] STITCH: unhandled error — uploading reaction alone",
            (stitchErr as Error)?.message,
          );
          // Clean up temp files on error
          if (stitchedUri) {
            await deleteAsync(stitchedUri, { idempotent: true }).catch(() => {});
            stitchedUri = null;
          }
          if (parentDownloadUri) {
            await deleteAsync(parentDownloadUri, { idempotent: true }).catch(() => {});
            parentDownloadUri = null;
          }
          // Fall through — upload the original reaction clip
          uploadUri = input.uri;
        }
      }
      */

      let mediaUrl: string;
      let segmentUrls: string[] | null = null;

      if (isRemoteUrl) {
        mediaUrl = input.uri;
        segmentUrls = input.segmentUris ?? null;
      } else {
        // Upload all segments when present (multi-clip), otherwise the single primary clip.
        // This mirrors the isRemoteUrl branch which correctly passes through segmentUris.
        const urisToUpload =
          input.segmentUris && input.segmentUris.length > 1
            ? input.segmentUris
            : [uploadUri];

        const uploadedUrls: string[] = [];
        for (let i = 0; i < urisToUpload.length; i++) {
          const segUri = urisToUpload[i]!;

          // Verify the file exists on disk BEFORE attempting to upload.
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
          const sizeMB = ((fileInfo.size ?? 0) / (1024 * 1024)).toFixed(2);

          // Determine file extension and MIME type from the URI
          const uriExt = segUri.match(/\.(\w+)(?:\?|$)/)?.[1]?.toLowerCase();
          const segExt = uriExt ?? (input.mediaType === "video" ? "mov" : "jpg");
          const segPath = `${user.id}/${baseTs}_seg${i}.${segExt}`;

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
          const contentType = mimeByExt[segExt] ?? (input.mediaType === "video" ? "video/quicktime" : "image/jpeg");


          // Track per-file progress and compute overall percentage
          await uploadToStorage(
            segUri,
            segPath,
            contentType,
            sizeMB,
            1,
            (loaded, total) => {
              if (total > 0 && input.onProgress) {
                // When stitching, the first 20% was for download+stitch preparation.
                // Map upload progress to the 20–100% range.
                const wasStitched = !!stitchedUri;
                const uploadStartPct = wasStitched ? 20 : 0;
                const uploadRange = 100 - uploadStartPct;
                const fileProgress = loaded / total;
                const overall = uploadStartPct + ((i + fileProgress) / urisToUpload.length) * uploadRange;
                input.onProgress(Math.round(overall));
              }
            },
          );

          // Mark this file as fully done (100% contribution of this file)
          if (input.onProgress) {
            const wasStitched = !!stitchedUri;
            const uploadStartPct = wasStitched ? 20 : 0;
            const uploadRange = 100 - uploadStartPct;
            input.onProgress(Math.round(uploadStartPct + ((i + 1) / urisToUpload.length) * uploadRange));
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
        is_mature: !!input.isMature,
        poster_timezone: getDeviceTimezone(),
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
      // ── Self-healing: ensure a profile row exists before inserting ────
      // If ensureProfile was never called (e.g. INITIAL_SESSION event didn't
      // trigger it), the FK on posts.user_id → profiles.id will fail. This
      // call creates the profile on-the-fly so the post always succeeds.
      try {
        await ensureProfileById(user.id);
      } catch (profileErr) {
        console.warn("[createPost] ensureProfileById failed (non-fatal)", (profileErr as Error)?.message);
      }

      const { data: insData, error: insErr } = await supabase.from("posts").insert(row).select("id, created_at").single();

      if (insErr) {
        const insErrAny = insErr as unknown as Record<string, unknown>;
        const errMeta = {
          message: insErr.message,
          code: insErr.code,
          details: insErr.details,
          hint: insErr.hint,
          status: insErrAny?.status,
          statusCode: insErrAny?.statusCode,
        };
        console.error("[createPost] insert FAIL", errMeta);
        // Persist the error so we can retrieve it after the fact
        AsyncStorage.setItem("dropday:lastInsertError", JSON.stringify({ ...errMeta, ts: Date.now() })).catch(() => {});
        // Show a visible alert so the user DEFINITELY sees the error
        showAlert(
          "Post Failed",
          insErr.message || "Database insert failed.",
        );
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

      // ── Clean up stitch temp files ─────────────────────────────────
      if (stitchedUri) {
        await deleteAsync(stitchedUri, { idempotent: true }).catch(() => {});
      }
      if (parentDownloadUri) {
        await deleteAsync(parentDownloadUri, { idempotent: true }).catch(() => {});
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
        is_mature: !!input.isMature,
        created_at: insData.created_at as string,
        like_count: 0,
        comment_count: 0,
        reaction_count: 0,
        profile: null,
      } as Post;
    },
    onSuccess: (newPost, variables) => {
      // Remove optimistic post and insert the real post into caches.
      // We do NOT invalidateQueries({ queryKey: ["posts"] }) here because that
      // triggers a background refetch that races with setQueryData — on Supabase
      // eventual consistency, the refetch may return before the new row is visible
      // and overwrite the cache, making the post disappear.
      //
      // Instead, setQueryData surgically updates the caches with the
      // full post data we already have. The useFocusEffect refetchFeed() in the
      // feed screen will eventually refresh from the DB for correctness.

      if (variables.optimisticTempId) {
        finalizeOptimisticPost(variables.optimisticTempId, newPost);
      }

      // Only insert into the main fyp feed cache for root Drops (no parent).
      // Reactions are NOT part of the fyp feed — they live in the reaction-tree.
      if (!newPost.parent_post_id) {
        qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
          if (!old) return [newPost];
          const filtered = old.filter(
            (p) => p._optimistic?.tempId !== variables.optimisticTempId
          );
          if (filtered.some((p) => p.id === newPost.id)) return filtered;
          return [newPost, ...filtered];
        });
        // Also insert into the following-feed cache — the user's own post
        // appears at the top via the self-boost tier. Without this, the
        // optimistic entry would vanish from the Following tab on success.
        qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
          if (!old) return [newPost];
          const filtered = old.filter(
            (p) => p._optimistic?.tempId !== variables.optimisticTempId
          );
          if (filtered.some((p) => p.id === newPost.id)) return filtered;
          return [newPost, ...filtered];
        });
      }

      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return [newPost];
        const filtered = (old ?? []).filter(
          (p) => p._optimistic?.tempId !== variables.optimisticTempId
        );
        if (filtered.some((p) => p.id === newPost.id)) return filtered;
        return [newPost, ...filtered];
      });

      // Invalidate all reaction and reply queries so the reaction-tree
      // screen refetches and shows the newly posted reaction immediately.
      // The reaction-tree screen uses query keys ["reactions", id] and
      // ["replies", ids] — fuzzy-invalidate both patterns.
      qc.invalidateQueries({ queryKey: ["reactions"] });
      qc.invalidateQueries({ queryKey: ["replies"] });

      // Also optimistically insert the new reaction/reply into the
      // matching "reactions" cache if we know the parent post ID.
      if (newPost.parent_post_id) {
        qc.setQueryData<Post[]>(
          ["reactions", newPost.parent_post_id],
          (old) => {
            if (!old) return [newPost];
            if (old.some((p) => p.id === newPost.id)) return old;
            return [newPost, ...old];
          },
        );
      }

      persistOptimisticPosts();

      // Record timestamp so the feed screen can skip a refetch that would
      // overwrite this cache patch before the self-boost window kicks in.
      lastPostCreatedAtRef.current = Date.now();

    },
    onError: (err, variables) => {
      const errAny = err as unknown as Record<string, unknown> | undefined;
      const errMeta = {
        message: (err as Error)?.message ?? String(err),
        name: (err as Error)?.name,
        code: errAny?.code,
        details: errAny?.details,
        hint: errAny?.hint,
        status: errAny?.status,
        statusCode: errAny?.statusCode,
        error: errAny?.error,
        cause: errAny?.cause,
      };
      console.error("[createPost] onError — POST FAILED", errMeta);
      // Persist the error so we can retrieve it after the fact
      AsyncStorage.setItem("dropday:lastMutationError", JSON.stringify({ ...errMeta, ts: Date.now() })).catch(() => {});
      // Show a visible alert so the user DEFINITELY sees the error
      // (Only show if the inner mutation didn't already show one — the inner
      //  Alert covers insert failures; this covers upload/network failures.)
      const msg = (err as Error)?.message ?? "Upload failed";
      // ALWAYS show an alert — the inner mutationFn already shows one for
      // insert failures, but the user might dismiss it. Show again here as
      // a safety net so the error is NEVER invisible.
      showAlert("Post Failed", msg);
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
                _optimistic: { ...p._optimistic!, status: "uploading" as const, progress: 0, error: undefined },
              }
            : p
        );
        persistOptimisticPosts(next);
        return next;
      });

      // Only update the feed cache for root Drops — reactions aren't in it.
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "uploading" as const, progress: 0, error: undefined },
              }
            : p
        );
      });
      qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
        if (!old) return old;
        return old.map((p) =>
          p._optimistic?.tempId === tempId && !p._optimistic.parentPostId
            ? {
                ...p,
                _optimistic: { ...p._optimistic!, status: "uploading" as const, progress: 0, error: undefined },
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
          onProgress: (percent: number) => {
            updateOptimisticProgress(tempId, percent);
          },
        });
      } catch (e) {
        console.error("[optimistic] retry parse error", e);
        failOptimisticPost(tempId, "Could not retry. Please try posting again.");
      }
    },
    [optimisticPosts, createPost, failOptimisticPost, updateOptimisticProgress, persistOptimisticPosts, user?.id, qc]
  );

  /** Remove a failed optimistic post from all caches and AsyncStorage.
   *  Called when the user dismisses a failed upload instead of retrying. */
  const removeOptimisticPost = useCallback(
    (tempId: string) => {
      setOptimisticPosts((prev) => {
        const next = prev.filter((p) => p._optimistic?.tempId !== tempId);
        persistOptimisticPosts(next);
        return next;
      });
      // Remove from all feed caches
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return old;
        return old.filter((p) => p._optimistic?.tempId !== tempId);
      });
      qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
        if (!old) return old;
        return old.filter((p) => p._optimistic?.tempId !== tempId);
      });
      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return old;
        return old.filter((p) => p._optimistic?.tempId !== tempId);
      });
    },
    [user?.id, qc, persistOptimisticPosts]
  );

  // ── DM: Conversations ─────────────────────────────────────────────────────
  const conversationsQuery = useQuery({
    queryKey: ["conversations", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 15_000,
    queryFn: async (): Promise<Conversation[]> => {
      if (!user?.id) return [];
      try {
        // Fetch conversations where the user is a participant
        const { data: convs, error: convErr } = await supabase
          .from("conversations")
          .select("id, participant_1_id, participant_2_id, created_at")
          .or(`participant_1_id.eq.${user.id},participant_2_id.eq.${user.id}`)
          .order("created_at", { ascending: false })
          .limit(50);
        if (convErr || !convs?.length) return [];

        // Collect all other participant IDs
        const otherIds = (convs as Record<string, unknown>[]).map((c) =>
          c.participant_1_id === user.id ? c.participant_2_id : c.participant_1_id,
        ) as string[];

        // Fetch profiles for other participants
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", otherIds);
        const profileMap = new Map(
          (profiles ?? []).map((p: Record<string, unknown>) => [p.id as string, p]),
        );

        // Fetch last message for each conversation
        const convIds = convs.map((c: Record<string, unknown>) => c.id as string);
        const { data: lastMsgs } = await supabase
          .from("messages")
          .select("id, conversation_id, sender_id, text, post_id, created_at")
          .in("conversation_id", convIds)
          .order("created_at", { ascending: false });

        const lastMsgMap = new Map<string, Record<string, unknown>>();
        for (const m of lastMsgs ?? []) {
          const msg = m as Record<string, unknown>;
          const cid = msg.conversation_id as string;
          if (!lastMsgMap.has(cid)) lastMsgMap.set(cid, msg);
        }

        return (convs as Record<string, unknown>[]).map((c) => {
          const otherId =
            c.participant_1_id === user.id
              ? (c.participant_2_id as string)
              : (c.participant_1_id as string);
          const otherProfile = profileMap.get(otherId);
          const lastMsg = lastMsgMap.get(c.id as string);
          return {
            id: c.id as string,
            participant_1_id: c.participant_1_id as string,
            participant_2_id: c.participant_2_id as string,
            created_at: c.created_at as string,
            otherProfile: otherProfile
              ? {
                  id: otherProfile.id as string,
                  username: otherProfile.username as string,
                  display_name: (otherProfile.display_name as string | null) ?? null,
                  avatar_url: (otherProfile.avatar_url as string | null) ?? null,
                }
              : null,
            lastMessage: lastMsg
              ? {
                  text: (lastMsg.text as string | null) ?? null,
                  post_id: (lastMsg.post_id as string | null) ?? null,
                  sender_id: lastMsg.sender_id as string,
                  created_at: lastMsg.created_at as string,
                }
              : null,
          };
        });
      } catch (e) {
        console.warn("[conversations] fetch error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // ── DM: Unread count ──────────────────────────────────────────────────────
  const unreadCountQuery = useQuery({
    queryKey: ["unread-count", user?.id],
    enabled: !!user?.id,
    retry: 1,
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<number> => {
      if (!user?.id) return 0;
      try {
        // Get all conversation IDs the user participates in
        const { data: convs } = await supabase
          .from("conversations")
          .select("id")
          .or(`participant_1_id.eq.${user.id},participant_2_id.eq.${user.id}`);
        if (!convs?.length) return 0;
        const convIds = convs.map((c: Record<string, unknown>) => c.id as string);

        // Count messages in those conversations NOT sent by the current user
        // that were created after the user's last viewed timestamp (simple: count all non-self messages)
        const { count, error } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .in("conversation_id", convIds)
          .neq("sender_id", user.id);
        if (error) return 0;
        return count ?? 0;
      } catch (e) {
        console.warn("[unread-count] error", (e as Error)?.message ?? e);
        return 0;
      }
    },
  });

  // ── DM: Find or create conversation ──────────────────────────────────────
  const findOrCreateConversation = useMutation({
    mutationFn: async (otherUserId: string): Promise<string> => {
      if (!user?.id) throw new Error("Not signed in.");
      if (otherUserId === user.id) throw new Error("Cannot message yourself.");

      // Ensure deterministic ordering: participant_1 is always the smaller ID
      const [p1, p2] =
        user.id < otherUserId
          ? [user.id, otherUserId]
          : [otherUserId, user.id];

      // Try to find existing conversation
      const { data: existing } = await supabase
        .from("conversations")
        .select("id")
        .eq("participant_1_id", p1)
        .eq("participant_2_id", p2)
        .maybeSingle();

      if (existing) return (existing as Record<string, unknown>).id as string;

      // Create new conversation
      const { data: created, error: createErr } = await supabase
        .from("conversations")
        .insert({ participant_1_id: p1, participant_2_id: p2 })
        .select("id")
        .single();

      if (createErr) throw createErr;
      return (created as Record<string, unknown>).id as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  // ── DM: Send text message ────────────────────────────────────────────────
  const sendTextMessage = useMutation({
    mutationFn: async ({
      conversationId,
      text,
    }: {
      conversationId: string;
      text: string;
    }): Promise<Message> => {
      if (!user?.id) throw new Error("Not signed in.");
      const trimmed = text.trim();
      if (!trimmed) throw new Error("Message cannot be empty.");

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          text: trimmed,
          post_id: null,
        })
        .select("id, conversation_id, sender_id, text, post_id, created_at")
        .single();

      if (error) throw error;
      return (data as unknown) as Message;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["messages", variables.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
    },
    onError: (err) => {
      console.error("[sendTextMessage] error", (err as Error)?.message ?? err);
    },
  });

  // ── DM: Send Drop share as message ───────────────────────────────────────
  const sendDropAsMessage = useMutation({
    mutationFn: async ({
      conversationId,
      postId,
    }: {
      conversationId: string;
      postId: string;
    }): Promise<Message> => {
      if (!user?.id) throw new Error("Not signed in.");

      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          text: null,
          post_id: postId,
        })
        .select("id, conversation_id, sender_id, text, post_id, created_at")
        .single();

      if (error) throw error;
      return (data as unknown) as Message;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["messages", variables.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
    },
    onError: (err) => {
      console.error("[sendDropAsMessage] error", (err as Error)?.message ?? err);
    },
  });

  // ── Helper: extract storage path from a Supabase public URL ───────────
  const extractStoragePath = useCallback((publicUrl: string): string | null => {
    const bucketPrefix = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/`;
    if (publicUrl.startsWith(bucketPrefix)) {
      return publicUrl.slice(bucketPrefix.length);
    }
    // Also handle the /object/sign/ variant
    const signPrefix = `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/`;
    const signIdx = publicUrl.indexOf(`/storage/v1/object/sign/${BUCKET}/`);
    if (signIdx >= 0) {
      const afterPrefix = publicUrl.slice(signIdx + signPrefix.length);
      // Strip query params from signed URLs
      const qIdx = afterPrefix.indexOf("?");
      return qIdx >= 0 ? afterPrefix.slice(0, qIdx) : afterPrefix;
    }
    return null;
  }, []);

  // ── Delete Post (Drop or reply) ─────────────────────────────────────
  const deletePost = useMutation({
    mutationFn: async (postId: string): Promise<void> => {
      if (!user?.id) throw new Error("Not signed in.");


      // 1. Fetch the post to get media_urls before deleting the row
      const { data: postRow, error: fetchErr } = await supabase
        .from("posts")
        .select("id, user_id, media_url, segments, thumbnail_url")
        .eq("id", postId)
        .single();

      if (fetchErr) {
        console.error("[deletePost] fetch error", fetchErr.message);
        throw fetchErr;
      }
      if (!postRow) throw new Error("Post not found.");

      const row = postRow as Record<string, unknown>;
      if (row.user_id !== user.id) throw new Error("You can only delete your own posts.");

      // 2. Collect all storage paths to delete
      const pathsToDelete: string[] = [];

      const mainPath = extractStoragePath(row.media_url as string);
      if (mainPath) pathsToDelete.push(mainPath);

      const segments = row.segments as string[] | null;
      if (segments) {
        for (const segUrl of segments) {
          const segPath = extractStoragePath(segUrl);
          if (segPath) pathsToDelete.push(segPath);
        }
      }

      const thumbUrl = row.thumbnail_url as string | null;
      if (thumbUrl) {
        const thumbPath = extractStoragePath(thumbUrl);
        if (thumbPath) pathsToDelete.push(thumbPath);
      }


      // 3. Delete from DB (cascade will handle child reactions via the FK)
      const { error: delErr } = await supabase
        .from("posts")
        .delete()
        .eq("id", postId);

      if (delErr) {
        console.error("[deletePost] DB delete error", delErr.message);
        throw delErr;
      }


      // 4. Delete media files from storage (best-effort, non-fatal if fails)
      if (pathsToDelete.length > 0) {
        const { error: storageErr } = await supabase.storage
          .from(BUCKET)
          .remove(pathsToDelete);
        if (storageErr) {
          console.warn("[deletePost] storage cleanup error (non-fatal)", storageErr.message);
        } else {
        }
      }

    },
    onSuccess: (_data, postId) => {

      // Remove from main feed cache
      qc.setQueryData<Post[]>(["posts", "fyp", user?.id], (old) => {
        if (!old) return [];
        return old.filter((p) => p.id !== postId);
      });

      // Remove from following feed cache
      qc.setQueryData<Post[]>(["posts", "following-feed", user?.id], (old) => {
        if (!old) return [];
        return old.filter((p) => p.id !== postId);
      });

      // Remove from my posts cache
      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return [];
        return old.filter((p) => p.id !== postId);
      });

      // Remove from liked posts cache
      qc.setQueryData<Post[]>(["posts", "liked", user?.id], (old) => {
        if (!old) return [];
        return old.filter((p) => p.id !== postId);
      });

      // Invalidate reaction & reply queries (cascade may have removed children)
      qc.invalidateQueries({ queryKey: ["reactions"] });
      qc.invalidateQueries({ queryKey: ["replies"] });
      qc.invalidateQueries({ queryKey: ["posts", "all-reactions"] });
    },
    onError: (err) => {
      console.error("[deletePost] onError", (err as Error)?.message ?? err);
      showAlert("Delete Failed", (err as Error)?.message ?? "Could not delete the post.");
    },
  });

  // ── Delete Reaction ──────────────────────────────────────────────────
  const deleteReaction = useMutation({
    mutationFn: async (reactionId: string): Promise<string | null> => {
      if (!user?.id) throw new Error("Not signed in.");


      // 1. Fetch the reaction to get media_url and parent_post_id
      const { data: reactionRow, error: fetchErr } = await supabase
        .from("posts")
        .select("id, user_id, media_url, segments, thumbnail_url, parent_post_id")
        .eq("id", reactionId)
        .single();

      if (fetchErr) {
        console.error("[deleteReaction] fetch error", fetchErr.message);
        throw fetchErr;
      }
      if (!reactionRow) throw new Error("Reaction not found.");

      const row = reactionRow as Record<string, unknown>;
      if (row.user_id !== user.id) throw new Error("You can only delete your own reactions.");

      const parentPostId = (row.parent_post_id as string) ?? null;

      // 2. Collect storage paths
      const pathsToDelete: string[] = [];
      const mainPath = extractStoragePath(row.media_url as string);
      if (mainPath) pathsToDelete.push(mainPath);

      const segments = row.segments as string[] | null;
      if (segments) {
        for (const segUrl of segments) {
          const segPath = extractStoragePath(segUrl);
          if (segPath) pathsToDelete.push(segPath);
        }
      }

      const thumbUrl = row.thumbnail_url as string | null;
      if (thumbUrl) {
        const thumbPath = extractStoragePath(thumbUrl);
        if (thumbPath) pathsToDelete.push(thumbPath);
      }


      // 3. Delete from DB
      const { error: delErr } = await supabase
        .from("posts")
        .delete()
        .eq("id", reactionId);

      if (delErr) {
        console.error("[deleteReaction] DB delete error", delErr.message);
        throw delErr;
      }


      // 4. Delete media files from storage (best-effort)
      if (pathsToDelete.length > 0) {
        const { error: storageErr } = await supabase.storage
          .from(BUCKET)
          .remove(pathsToDelete);
        if (storageErr) {
          console.warn("[deleteReaction] storage cleanup error (non-fatal)", storageErr.message);
        } else {
        }
      }


      // Return parentPostId for cache updates
      return parentPostId;
    },
    onSuccess: (parentPostId, reactionId) => {

      // Remove from my posts cache
      qc.setQueryData<Post[]>(["posts", "mine", user?.id], (old) => {
        if (!old) return [];
        return old.filter((p) => p.id !== reactionId);
      });

      // Remove from the parent's reaction cache
      if (parentPostId) {
        qc.setQueryData<Post[]>(["reactions", parentPostId], (old) => {
          if (!old) return [];
          return old.filter((p) => p.id !== reactionId);
        });
      }

      // Invalidate reaction-related queries so counts update
      qc.invalidateQueries({ queryKey: ["reactions"] });
      qc.invalidateQueries({ queryKey: ["replies"] });
      qc.invalidateQueries({ queryKey: ["posts", "all-reactions"] });
      // Also invalidate the main feed so reaction_count decrements on the parent Drop
      qc.invalidateQueries({ queryKey: ["posts", "fyp"] });
    },
    onError: (err) => {
      console.error("[deleteReaction] onError", (err as Error)?.message ?? err);
      showAlert("Delete Failed", (err as Error)?.message ?? "Could not delete the reaction.");
    },
  });

  // ── Filter blocked users' content from all feeds ───────────────────────
  // Applied client-side in the return memo so that when blockedUserIds
  // changes (user blocks/unblocks someone), all feeds update immediately
  // without a server refetch. Server-side filtering isn't possible because
  // RLS can't do cross-table blocking without a function.
  const filterBlocked = useCallback(
    (posts: Post[]): Post[] => {
      if (blockedUserIds.size === 0 && reportedPostIds.size === 0) return posts;
      return posts.filter(
        (p) => !blockedUserIds.has(p.user_id) && !reportedPostIds.has(p.id),
      );
    },
    [blockedUserIds, reportedPostIds],
  );

  const filterBlockedReactions = useCallback(
    (grouped: Record<string, Post[]>): Record<string, Post[]> => {
      if (blockedUserIds.size === 0 && reportedReactionIds.size === 0) return grouped;
      const filtered: Record<string, Post[]> = {};
      for (const [pid, posts] of Object.entries(grouped)) {
        const kept = posts.filter(
          (p) => !blockedUserIds.has(p.user_id) && !reportedReactionIds.has(p.id),
        );
        if (kept.length > 0) filtered[pid] = kept;
      }
      return filtered;
    },
    [blockedUserIds, reportedReactionIds],
  );

  return useMemo(
    () => {
      return {
      // Filter blocked users out of Suggested Creators (read-side, same
      // pattern as filterBlocked — updates instantly on block/unblock).
      exploreCreators: (exploreCreatorsQuery.data ?? []).filter(
        (c) => !blockedUserIds.has(c.id),
      ),
      exploreCreatorsLoading: exploreCreatorsQuery.isLoading,
      refetchExploreCreators: exploreCreatorsQuery.refetch,
      feed: filterBlocked(feedQuery.data ?? []),
      feedLoading: feedQuery.isLoading,
      refetchFeed: feedQuery.refetch,
      followingFeed: filterBlocked(followingFeedQuery.data ?? []),
      followingFeedLoading: followingFeedQuery.isLoading,
      refetchFollowingFeed: followingFeedQuery.refetch,
      myPosts: myPostsQuery.data ?? [],
      refetchMyPosts: myPostsQuery.refetch,
      myProfile: myProfileQuery.data ?? null,
      refetchProfile: myProfileQuery.refetch,
      updateProfile,
      following: followingQuery.data ?? [],
      followingProfiles: followingQuery.data ?? [],
      suggestedUsers: (suggestedQuery.data ?? []).filter(
        (u) => !blockedUserIds.has(u.id),
      ),
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
      likedPosts: filterBlocked(likedPostsQuery.data ?? []),
      likedPostsLoading: likedPostsQuery.isLoading,
      refetchLikedPosts: likedPostsQuery.refetch,
      toggleLike,
      reactionsByParent: filterBlockedReactions(allReactionsQuery.data ?? {}),
      reactionsLoading: allReactionsQuery.isLoading,
      refetchReactions: allReactionsQuery.refetch,
      reportedReactionIds,
      lastQueryError,
      lastPostCreatedAtRef,
      optimisticPosts,
      addOptimisticPost,
      updateOptimisticProgress,
      retryOptimisticPost,
      removeOptimisticPost,
      conversations: conversationsQuery.data ?? [],
      conversationsLoading: conversationsQuery.isLoading,
      refetchConversations: conversationsQuery.refetch,
      unreadCount: unreadCountQuery.data ?? 0,
      refetchUnreadCount: unreadCountQuery.refetch,
      findOrCreateConversation,
      sendTextMessage,
      sendDropAsMessage,
      deletePost,
      deleteReaction,
      };
    },
    [
      exploreCreatorsQuery,
      feedQuery,
      followingFeedQuery,
      myPostsQuery,
      myProfileQuery,
      updateProfile,
      allReactionsQuery,
      followingQuery,
      suggestedQuery,
      lastQueryError,
      lastPostCreatedAtRef,
      followUser,
      unfollowUser,
      hasPostedInWindow,
      draftProjects,
      draftsLoaded,
      saveDraftProject,
      deleteDraftProject,
      createPost,
      likedPostsQuery,
      toggleLike,
      optimisticPosts,
      addOptimisticPost,
      updateOptimisticProgress,
      retryOptimisticPost,
      conversationsQuery,
      unreadCountQuery,
      findOrCreateConversation,
      sendTextMessage,
      sendDropAsMessage,
      deletePost,
      deleteReaction,
      filterBlocked,
      filterBlockedReactions,
      blockedUserIds,
      myReportsQuery,
      reportedPostIds,
      reportedReactionIds,
    ]
  );
});
