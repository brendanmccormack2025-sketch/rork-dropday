import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

// ── Types ───────────────────────────────────────────────────────────────────

export type Group = {
  id: string;
  name: string;
  avatar_url: string | null;
  creator_id: string;
  created_by: string;
  created_at: string;
  /** Joined: accepted member count (only populated on the user's groups) */
  member_count?: number;
};

export type GroupMemberStatus = "invited" | "accepted" | "declined" | "left";

export type GroupMember = {
  group_id: string;
  user_id: string;
  status: GroupMemberStatus;
  invited_by: string | null;
  joined_at: string;
  responded_at: string | null;
  /** Joined profile data */
  profile: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
};

/** A group post lives in the main `posts` table with a non-null group_id. */
export type GroupPost = {
  id: string;
  group_id: string;
  user_id: string;
  media_url: string;
  media_type: "image" | "video";
  caption: string | null;
  created_at: string;
  like_count: number;
  /** Whether the current user has liked this post */
  has_liked: boolean;
  /** Joined profile of the poster */
  profile: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
};

export type GroupInvite = {
  group_id: string;
  name: string;
  avatar_url: string | null;
  invited_at: string;
};

// ── Provider ─────────────────────────────────────────────────────────────────

export const [GroupsProvider, useGroups] = createContextHook(() => {
  const { user } = useAuth();
  const qc = useQueryClient();

  const userId = user?.id ?? null;

  const invalidateGroupQueries = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["groups"] });
    qc.invalidateQueries({ queryKey: ["group-members"] });
    qc.invalidateQueries({ queryKey: ["group-posts"] });
  }, [qc]);

  // ── Fetch the user's accepted groups ──────────────────────────────────
  const myGroupsQuery = useQuery({
    queryKey: userId ? ["groups", "mine", userId] : ["groups", "noop"],
    enabled: !!userId,
    staleTime: 15_000,
    refetchOnMount: true,
    queryFn: async (): Promise<Group[]> => {
      if (!userId) return [];
      try {
        const { data, error } = await supabase
          .from("group_members")
          .select(
            "group_id, joined_at, groups!group_members_group_id_fkey(id, name, avatar_url, creator_id, created_by, created_at)",
          )
          .eq("user_id", userId)
          .eq("status", "accepted")
          .order("joined_at", { ascending: false });

        if (error) {
          console.warn("[groups:mine] error", error.message);
          return [];
        }

        const rows = (data ?? []) as Record<string, unknown>[];
        if (rows.length === 0) return [];

        const groupIds = rows.map((r) => r.group_id as string);

        // Accepted member counts per group
        const { data: counts } = await supabase
          .from("group_members")
          .select("group_id")
          .in("group_id", groupIds)
          .eq("status", "accepted");

        const countMap = new Map<string, number>();
        for (const row of (counts ?? []) as Record<string, unknown>[]) {
          const gid = row.group_id as string;
          countMap.set(gid, (countMap.get(gid) ?? 0) + 1);
        }

        return rows.map((r) => {
          const g = r.groups as Record<string, unknown> | null;
          return {
            id: (g?.id as string) ?? (r.group_id as string),
            name: (g?.name as string) ?? "Group",
            avatar_url: (g?.avatar_url as string | null) ?? null,
            creator_id: (g?.creator_id as string) ?? "",
            created_by: (g?.created_by as string) ?? "",
            created_at: (g?.created_at as string) ?? "",
            member_count: countMap.get(r.group_id as string) ?? 0,
          };
        });
      } catch (e) {
        console.warn("[groups:mine] fetch error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // ── Pending invites for the current user ──────────────────────────────
  const myInvitesQuery = useQuery({
    queryKey: userId ? ["groups", "invites", userId] : ["groups", "invites-noop"],
    enabled: !!userId,
    staleTime: 15_000,
    refetchOnMount: true,
    queryFn: async (): Promise<GroupInvite[]> => {
      if (!userId) return [];
      try {
        const { data, error } = await supabase
          .from("group_members")
          .select(
            "group_id, joined_at, groups!group_members_group_id_fkey(id, name, avatar_url)",
          )
          .eq("user_id", userId)
          .eq("status", "invited")
          .order("joined_at", { ascending: false });

        if (error) {
          console.warn("[groups:invites] error", error.message);
          return [];
        }

        return ((data ?? []) as Record<string, unknown>[]).map((r) => {
          const g = r.groups as Record<string, unknown> | null;
          return {
            group_id: r.group_id as string,
            name: (g?.name as string) ?? "Group",
            avatar_url: (g?.avatar_url as string | null) ?? null,
            invited_at: (r.joined_at as string) ?? "",
          };
        });
      } catch (e) {
        console.warn("[groups:invites] fetch error", (e as Error)?.message ?? e);
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

      // Create the group (the trigger auto-adds the creator as an accepted member)
      const { data: group, error: createErr } = await supabase
        .from("groups")
        .insert({ name: trimmedName, created_by: userId })
        .select("id")
        .single();

      if (createErr) throw createErr;
      const groupId = (group as Record<string, unknown>).id as string;

      // Invite selected members (creator is already accepted via trigger)
      const toInvite = input.memberIds.filter((id) => id !== userId);
      if (toInvite.length > 0) {
        const rows = toInvite.map((mid) => ({
          group_id: groupId,
          user_id: mid,
          status: "invited" as const,
          invited_by: userId,
        }));
        const { error: addErr } = await supabase
          .from("group_members")
          .insert(rows);
        if (addErr) {
          console.warn("[groups:create] invite members error", addErr.message);
          // Non-fatal — group is created, members can be invited later
        }
      }

      return groupId;
    },
    onSuccess: invalidateGroupQueries,
    onError: (err) => {
      console.error("[groups:create] error", (err as Error)?.message ?? err);
    },
  });

  // ── Invite a member to a group ─────────────────────────────────────────
  const inviteMember = useMutation({
    mutationFn: async (input: {
      groupId: string;
      userId: string;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase.from("group_members").insert({
        group_id: input.groupId,
        user_id: input.userId,
        status: "invited",
        invited_by: userId,
      });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidateGroupQueries();
      qc.invalidateQueries({ queryKey: ["group-members", variables.groupId] });
    },
  });

  // ── Leave the currently accepted group ─────────────────────────────────
  // Past posts remain on the group page.
  const leaveGroup = useMutation({
    mutationFn: async (input: { groupId: string }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("group_members")
        .update({ status: "left", responded_at: new Date().toISOString() })
        .eq("group_id", input.groupId)
        .eq("user_id", userId)
        .eq("status", "accepted");
      if (error) throw error;
    },
    onSuccess: invalidateGroupQueries,
    onError: (err) => {
      console.error("[groups:leave] error", (err as Error)?.message ?? err);
    },
  });

  // ── Respond to an invite (accept swaps out any existing membership) ────
  const respondToInvite = useMutation({
    mutationFn: async (input: {
      groupId: string;
      accept: boolean;
    }): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const respondedAt = new Date().toISOString();

      if (!input.accept) {
        const { error } = await supabase
          .from("group_members")
          .update({ status: "declined", responded_at: respondedAt })
          .eq("group_id", input.groupId)
          .eq("user_id", userId)
          .eq("status", "invited");
        if (error) throw error;
        return;
      }

      // One accepted group per user — leave any current group first
      const { error: leaveErr } = await supabase
        .from("group_members")
        .update({ status: "left", responded_at: respondedAt })
        .eq("user_id", userId)
        .eq("status", "accepted");
      if (leaveErr) throw leaveErr;

      // Accept the invite
      const { data: updated, error: acceptErr } = await supabase
        .from("group_members")
        .update({ status: "accepted", responded_at: respondedAt })
        .eq("group_id", input.groupId)
        .eq("user_id", userId)
        .eq("status", "invited")
        .select("group_id");

      if (acceptErr) throw acceptErr;
      if (!updated || updated.length === 0) {
        // Invite row disappeared (group deleted?) — insert a direct membership
        const { error: insertErr } = await supabase
          .from("group_members")
          .insert({
            group_id: input.groupId,
            user_id: userId,
            status: "accepted",
            responded_at: respondedAt,
          });
        if (insertErr) throw insertErr;
      }
    },
    onSuccess: invalidateGroupQueries,
    onError: (err) => {
      console.error("[groups:respond] error", (err as Error)?.message ?? err);
    },
  });

  // ── Fetch accepted members of a group ──────────────────────────────────
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
              "group_id, user_id, status, invited_by, joined_at, responded_at, profiles!group_members_user_id_fkey(username, display_name, avatar_url)",
            )
            .eq("group_id", groupId)
            .eq("status", "accepted")
            .order("joined_at", { ascending: true });

          if (error) {
            console.warn("[group-members] error", error.message);
            return [];
          }

          return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
            group_id: row.group_id as string,
            user_id: row.user_id as string,
            status: row.status as GroupMemberStatus,
            invited_by: (row.invited_by as string | null) ?? null,
            joined_at: row.joined_at as string,
            responded_at: (row.responded_at as string | null) ?? null,
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

  // ── Fetch a group's posts (from the main posts table) ──────────────────
  const useGroupPosts = useCallback(
    (groupId: string | null) => {
      return useQuery({
        queryKey: groupId ? ["group-posts", groupId] : ["group-posts", "noop"],
        enabled: !!groupId,
        staleTime: 10_000,
        queryFn: async (): Promise<GroupPost[]> => {
          if (!groupId) return [];
          try {
            const { data, error } = await supabase
              .from("posts")
              .select(
                "id, group_id, user_id, media_url, media_type, caption, created_at, like_count, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
              )
              .eq("group_id", groupId)
              .eq("moderation_status", "active")
              .order("created_at", { ascending: false })
              .limit(100);

            if (error) {
              console.warn("[group-posts] error", error.message);
              return [];
            }

            const posts: GroupPost[] = ((data ?? []) as Record<string, unknown>[]).map(
              (row) => ({
                id: row.id as string,
                group_id: row.group_id as string,
                user_id: row.user_id as string,
                media_url: row.media_url as string,
                media_type: row.media_type as "image" | "video",
                caption: (row.caption as string | null) ?? null,
                created_at: row.created_at as string,
                like_count: (row.like_count as number | undefined) ?? 0,
                has_liked: false,
                profile:
                  row.profiles && !Array.isArray(row.profiles)
                    ? (row.profiles as GroupPost["profile"])
                    : null,
              }),
            );

            // Mark which posts the current user has liked
            if (userId && posts.length > 0) {
              const postIds = posts.map((p) => p.id);
              const { data: likeRows } = await supabase
                .from("likes")
                .select("post_id")
                .eq("user_id", userId)
                .in("post_id", postIds);
              const likedSet = new Set(
                ((likeRows ?? []) as Record<string, unknown>[]).map(
                  (r) => r.post_id as string,
                ),
              );
              for (const p of posts) p.has_liked = likedSet.has(p.id);
            }

            return posts;
          } catch (e) {
            console.warn("[group-posts] fetch error", (e as Error)?.message ?? e);
            return [];
          }
        },
      });
    },
    [userId],
  );

  const myGroups = myGroupsQuery.data ?? [];
  const groupsLoading = myGroupsQuery.isLoading;
  const myInvites = myInvitesQuery.data ?? [];
  const invitesLoading = myInvitesQuery.isLoading;

  const refetchGroups = useCallback(() => {
    myGroupsQuery.refetch();
    myInvitesQuery.refetch();
  }, [myGroupsQuery, myInvitesQuery]);

  return {
    myGroups,
    myInvites,
    groupsLoading,
    invitesLoading,
    refetchGroups,
    createGroup,
    inviteMember,
    leaveGroup,
    respondToInvite,
    useGroupMembers,
    useGroupPosts,
  };
});
