import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { supabase, supabaseUrl, supabaseAnonKey } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { Platform } from "react-native";

// ── Types ───────────────────────────────────────────────────────────────────

export type Group = {
  id: string;
  name: string;
  creator_id: string;
  created_at: string;
  /** Joined: member count (only populated when fetching the user's groups) */
  member_count?: number;
};

export type GroupMember = {
  group_id: string;
  user_id: string;
  joined_at: string;
  role: "member" | "admin";
  /** Joined profile data */
  profile: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
};

export type GroupPost = {
  id: string;
  group_id: string;
  user_id: string;
  media_url: string;
  media_type: "photo" | "video";
  caption: string | null;
  created_at: string;
  /** Joined profile of the poster */
  profile: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Reaction count (computed client-side) */
  reaction_count?: number;
  /** Whether the current user has reacted */
  has_reacted?: boolean;
};

// ── Storage ──────────────────────────────────────────────────────────────────

const GROUP_BUCKET = "group-media";

/**
 * Upload a media file to the group-media storage bucket.
 * Uses the same foreground XMLHttpRequest approach as the main upload path
 * to avoid background-session termination issues on iOS.
 */
async function uploadGroupMedia(
  fileUri: string,
  storagePath: string,
  contentType: string,
): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not authenticated — cannot upload files.");

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${GROUP_BUCKET}/${storagePath}`;

  if (Platform.OS === "ios" || Platform.OS === "android") {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      xhr.setRequestHeader("apikey", supabaseAnonKey);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("x-upsert", "false");

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Storage returned HTTP ${xhr.status}: ${(xhr.responseText ?? "").slice(0, 200)}`));
        }
      };
      xhr.onerror = () => reject(new Error("Network request failed"));
      xhr.ontimeout = () => reject(new Error("Upload timed out"));

      const formData = new FormData();
      formData.append("file", {
        uri: fileUri,
        type: contentType,
        name: storagePath.split("/").pop() ?? "file",
      } as unknown as Blob);
      xhr.send(formData);
    });
  } else {
    // Web fallback
    let body: Blob | { uri: string; type: string; name: string };
    if (fileUri.startsWith("data:")) {
      body = await fetch(fileUri).then((r) => r.blob());
    } else {
      body = {
        uri: fileUri,
        type: contentType,
        name: storagePath.split("/").pop() ?? "file",
      } as unknown as { uri: string; type: string; name: string };
    }
    const formData = new FormData();
    formData.append("file", body as unknown as Blob);
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        "x-upsert": "false",
      },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "error");
      throw new Error(`Storage returned HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }
  }

  const { data } = supabase.storage.from(GROUP_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const [GroupsProvider, useGroups] = createContextHook(() => {
  const { user } = useAuth();
  const qc = useQueryClient();

  const userId = user?.id ?? null;

  // ── Fetch the user's groups ────────────────────────────────────────────
  const myGroupsQuery = useQuery({
    queryKey: userId ? ["groups", "mine", userId] : ["groups", "noop"],
    enabled: !!userId,
    staleTime: 15_000,
    refetchOnMount: true,
    queryFn: async (): Promise<Group[]> => {
      if (!userId) return [];
      try {
        // Get group IDs where the user is a member
        const { data: memberRows, error: memberErr } = await supabase
          .from("group_members")
          .select("group_id")
          .eq("user_id", userId);

        if (memberErr || !memberRows?.length) return [];

        const groupIds = (memberRows as Record<string, unknown>[]).map(
          (r) => r.group_id as string,
        );

        // Fetch the group rows
        const { data: groups, error: groupErr } = await supabase
          .from("groups")
          .select("id, name, creator_id, created_at")
          .in("id", groupIds)
          .order("created_at", { ascending: false });

        if (groupErr) {
          console.warn("[groups:mine] error", groupErr.message);
          return [];
        }

        // Fetch member counts per group
        const { data: counts } = await supabase
          .from("group_members")
          .select("group_id")
          .in("group_id", groupIds);

        const countMap = new Map<string, number>();
        for (const row of (counts ?? []) as Record<string, unknown>[]) {
          const gid = row.group_id as string;
          countMap.set(gid, (countMap.get(gid) ?? 0) + 1);
        }

        return ((groups ?? []) as Record<string, unknown>[]).map((g) => ({
          id: g.id as string,
          name: g.name as string,
          creator_id: g.creator_id as string,
          created_at: g.created_at as string,
          member_count: countMap.get(g.id as string) ?? 0,
        }));
      } catch (e) {
        console.warn("[groups:mine] fetch error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // ── Create a new group ─────────────────────────────────────────────────
  const createGroup = useMutation({
    mutationFn: async (input: {
      name: string;
      memberIds: string[];
    }): Promise<string> => {
      if (!userId) throw new Error("Not signed in.");
      const trimmedName = input.name.trim();
      if (!trimmedName) throw new Error("Group name cannot be empty.");

      // Create the group (the trigger auto-adds the creator as admin)
      const { data: group, error: createErr } = await supabase
        .from("groups")
        .insert({ name: trimmedName, creator_id: userId })
        .select("id")
        .single();

      if (createErr) throw createErr;
      const groupId = (group as Record<string, unknown>).id as string;

      // Add selected members (creator is already added by trigger)
      const toAdd = input.memberIds.filter((id) => id !== userId);
      if (toAdd.length > 0) {
        const rows = toAdd.map((mid) => ({
          group_id: groupId,
          user_id: mid,
          role: "member" as const,
        }));
        const { error: addErr } = await supabase
          .from("group_members")
          .insert(rows);
        if (addErr) {
          console.warn("[groups:create] add members error", addErr.message);
          // Non-fatal — group is created, members can be added later
        }
      }

      return groupId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (err) => {
      console.error("[groups:create] error", (err as Error)?.message ?? err);
    },
  });

  // ── Add a member to a group ────────────────────────────────────────────
  const addMember = useMutation({
    mutationFn: async (input: {
      groupId: string;
      userId: string;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("group_members")
        .insert({
          group_id: input.groupId,
          user_id: input.userId,
          role: "member",
        });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group-members", variables.groupId] });
    },
  });

  // ── Fetch group members ────────────────────────────────────────────────
  const useGroupMembers = useCallback((groupId: string | null) => {
    return useQuery({
      queryKey: groupId ? ["group-members", groupId] : ["group-members", "noop"],
      enabled: !!groupId,
      staleTime: 15_000,
      queryFn: async (): Promise<GroupMember[]> => {
        if (!groupId) return [];
        try {
          const { data, error } = await supabase
            .from("group_members")
            .select(
              "group_id, user_id, joined_at, role, profiles!group_members_user_id_fkey(username, display_name, avatar_url)",
            )
            .eq("group_id", groupId)
            .order("joined_at", { ascending: true });

          if (error) {
            console.warn("[group-members] error", error.message);
            return [];
          }

          return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
            group_id: row.group_id as string,
            user_id: row.user_id as string,
            joined_at: row.joined_at as string,
            role: row.role as "member" | "admin",
            profile:
              row.profiles && !Array.isArray(row.profiles)
                ? (row.profiles as GroupMember["profile"])
                : null,
          }));
        } catch (e) {
          console.warn("[group-members] fetch error", (e as Error)?.message ?? e);
          return [];
        }
      },
    });
  }, []);

  // ── Fetch group posts ──────────────────────────────────────────────────
  const useGroupPosts = useCallback((groupId: string | null) => {
    return useQuery({
      queryKey: groupId ? ["group-posts", groupId] : ["group-posts", "noop"],
      enabled: !!groupId,
      staleTime: 10_000,
      queryFn: async (): Promise<GroupPost[]> => {
        if (!groupId) return [];
        try {
          const { data, error } = await supabase
            .from("group_posts")
            .select(
              "id, group_id, user_id, media_url, media_type, caption, created_at, profiles!group_posts_user_id_fkey(username, display_name, avatar_url)",
            )
            .eq("group_id", groupId)
            .order("created_at", { ascending: false })
            .limit(100);

          if (error) {
            console.warn("[group-posts] error", error.message);
            return [];
          }

          const posts = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
            id: row.id as string,
            group_id: row.group_id as string,
            user_id: row.user_id as string,
            media_url: row.media_url as string,
            media_type: row.media_type as "photo" | "video",
            caption: (row.caption as string | null) ?? null,
            created_at: row.created_at as string,
            profile:
              row.profiles && !Array.isArray(row.profiles)
                ? (row.profiles as GroupPost["profile"])
                : null,
          }));

          // Fetch reaction counts and current user's reactions
          if (posts.length > 0) {
            const postIds = posts.map((p) => p.id);
            const { data: reactions } = await supabase
              .from("group_post_reactions")
              .select("group_post_id, user_id")
              .in("group_post_id", postIds);

            const countMap = new Map<string, number>();
            const reactedSet = new Set<string>();
            for (const r of (reactions ?? []) as Record<string, unknown>[]) {
              const pid = r.group_post_id as string;
              countMap.set(pid, (countMap.get(pid) ?? 0) + 1);
              if (r.user_id === userId) {
                reactedSet.add(pid);
              }
            }

            return posts.map((p) => ({
              ...p,
              reaction_count: countMap.get(p.id) ?? 0,
              has_reacted: reactedSet.has(p.id),
            }));
          }

          return posts;
        } catch (e) {
          console.warn("[group-posts] fetch error", (e as Error)?.message ?? e);
          return [];
        }
      },
    });
  }, [userId]);

  // ── Create a group post (with media upload) ────────────────────────────
  const createGroupPost = useMutation({
    mutationFn: async (input: {
      groupId: string;
      uri: string;
      mediaType: "photo" | "video";
      caption?: string;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");

      // Determine file extension and content type
      const uriExt = input.uri.match(/\.(\w+)(?:\?|$)/)?.[1]?.toLowerCase();
      const ext = uriExt ?? (input.mediaType === "video" ? "mp4" : "jpg");
      const mimeByExt: Record<string, string> = {
        mp4: "video/mp4",
        mov: "video/quicktime",
        m4v: "video/x-m4v",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        heic: "image/heic",
      };
      const contentType = mimeByExt[ext] ?? (input.mediaType === "video" ? "video/mp4" : "image/jpeg");

      const baseTs = Date.now();
      const storagePath = `${userId}/${baseTs}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      // Upload to group-media bucket
      const mediaUrl = await uploadGroupMedia(input.uri, storagePath, contentType);

      // Insert the group_post row
      const { error } = await supabase.from("group_posts").insert({
        group_id: input.groupId,
        user_id: userId,
        media_url: mediaUrl,
        media_type: input.mediaType,
        caption: input.caption?.trim() || null,
      });

      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["group-posts", variables.groupId] });
    },
    onError: (err) => {
      console.error("[group-post:create] error", (err as Error)?.message ?? err);
    },
  });

  // ── Toggle reaction on a group post ────────────────────────────────────
  const toggleGroupReaction = useMutation({
    mutationFn: async (input: {
      groupPostId: string;
      groupId: string;
      reacted: boolean;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      if (input.reacted) {
        // Remove reaction
        const { error } = await supabase
          .from("group_post_reactions")
          .delete()
          .eq("group_post_id", input.groupPostId)
          .eq("user_id", userId);
        if (error) throw error;
      } else {
        // Add reaction
        const { error } = await supabase
          .from("group_post_reactions")
          .insert({
            group_post_id: input.groupPostId,
            user_id: userId,
          });
        if (error) throw error;
      }
    },
    onMutate: async ({ groupPostId, groupId, reacted }) => {
      // Optimistic update
      const prev = qc.getQueryData<GroupPost[]>(["group-posts", groupId]);
      if (prev) {
        qc.setQueryData<GroupPost[]>(["group-posts", groupId], (old) =>
          (old ?? []).map((p) =>
            p.id === groupPostId
              ? {
                  ...p,
                  has_reacted: !reacted,
                  reaction_count: Math.max(
                    0,
                    (p.reaction_count ?? 0) + (reacted ? -1 : 1),
                  ),
                }
              : p,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, variables, context) => {
      // Rollback
      if (context?.prev) {
        qc.setQueryData(["group-posts", variables.groupId], context.prev);
      }
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["group-posts", variables.groupId] });
    },
  });

  // ── Delete a group post ────────────────────────────────────────────────
  const deleteGroupPost = useMutation({
    mutationFn: async (input: {
      groupPostId: string;
      groupId: string;
      mediaUrl: string;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");

      // Extract storage path and delete the file
      const bucketPrefix = `${supabaseUrl}/storage/v1/object/public/${GROUP_BUCKET}/`;
      if (input.mediaUrl.startsWith(bucketPrefix)) {
        const storagePath = input.mediaUrl.slice(bucketPrefix.length);
        const qIdx = storagePath.indexOf("?");
        const cleanPath = qIdx >= 0 ? storagePath.slice(0, qIdx) : storagePath;
        await supabase.storage.from(GROUP_BUCKET).remove([cleanPath]);
      }

      // Delete the row (cascade will remove reactions)
      const { error } = await supabase
        .from("group_posts")
        .delete()
        .eq("id", input.groupPostId)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["group-posts", variables.groupId] });
    },
  });

  const myGroups = myGroupsQuery.data ?? [];
  const groupsLoading = myGroupsQuery.isLoading;

  const refetchGroups = useCallback(() => {
    myGroupsQuery.refetch();
  }, [myGroupsQuery]);

  return {
    myGroups,
    groupsLoading,
    refetchGroups,
    createGroup,
    addMember,
    useGroupMembers,
    useGroupPosts,
    createGroupPost,
    toggleGroupReaction,
    deleteGroupPost,
  };
});
