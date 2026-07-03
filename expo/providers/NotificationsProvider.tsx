import createContextHook from "@nkzw/create-context-hook";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

export type NotificationType = "like" | "reaction" | "follow";

export type NotificationRow = {
  id: string;
  recipient_id: string;
  actor_id: string;
  type: NotificationType;
  post_id: string | null;
  read: boolean;
  created_at: string;
  /** Joined actor profile */
  actor: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  /** Joined post (thumbnail) — only for like/reaction */
  post: {
    thumbnail_url: string | null;
    media_type: string;
  } | null;
};

const QUERY_KEY = (userId: string) => ["notifications", userId] as const;
const UNREAD_KEY = (userId: string) => ["notifications", "unread", userId] as const;

export const [NotificationsProvider, useNotifications] = createContextHook(() => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const userId = user?.id ?? null;

  // ── Fetch notifications with joined actor + post ──────────────────────
  const notificationsQuery = useQuery({
    queryKey: userId ? QUERY_KEY(userId) : ["notifications", "noop"],
    enabled: !!userId,
    staleTime: 15_000,
    refetchOnMount: true,
    queryFn: async (): Promise<NotificationRow[]> => {
      if (!userId) return [];
      try {
        const { data, error } = await supabase
          .from("notifications")
          .select(
            "id, recipient_id, actor_id, type, post_id, read, created_at, actor:profiles!notifications_actor_id_fkey(username, display_name, avatar_url), post:posts!notifications_post_id_fkey(thumbnail_url, media_type)"
          )
          .eq("recipient_id", userId)
          .order("created_at", { ascending: false })
          .limit(80);

        if (error) {
          console.warn("[notifications] query error", error.message);
          return [];
        }

        return ((data ?? []) as unknown as NotificationRow[]).map((row) => ({
          ...row,
          actor: row.actor && !Array.isArray(row.actor) ? row.actor : null,
          post: row.post && !Array.isArray(row.post) ? row.post : null,
        }));
      } catch (e) {
        console.warn("[notifications] network error", (e as Error)?.message ?? e);
        return [];
      }
    },
  });

  // ── Unread count (for tab badge) ──────────────────────────────────────
  const unreadQuery = useQuery({
    queryKey: userId ? UNREAD_KEY(userId) : ["notifications", "unread", "noop"],
    enabled: !!userId,
    staleTime: 10_000,
    refetchOnMount: true,
    queryFn: async (): Promise<number> => {
      if (!userId) return 0;
      try {
        const { count, error } = await supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("recipient_id", userId)
          .eq("read", false);

        if (error) {
          console.warn("[notifications:unread] error", error.message);
          return 0;
        }
        return count ?? 0;
      } catch {
        return 0;
      }
    },
  });

  // ── Mark all as read ──────────────────────────────────────────────────
  const markAllRead = useMutation({
    mutationFn: async () => {
      if (!userId) return;
      const { error } = await supabase
        .from("notifications")
        .update({ read: true })
        .eq("recipient_id", userId)
        .eq("read", false);
      if (error) throw error;
    },
    onSuccess: () => {
      if (!userId) return;
      // Optimistically update both caches
      qc.setQueryData<NotificationRow[]>(QUERY_KEY(userId), (old) =>
        (old ?? []).map((n) => ({ ...n, read: true })),
      );
      qc.setQueryData<number>(UNREAD_KEY(userId), 0);
    },
    onError: (err) => {
      console.warn("[notifications] markAllRead error", (err as Error)?.message ?? err);
    },
  });

  // ── Realtime subscription ─────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;

    // Tear down any existing channel
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${userId}`,
        },
        (payload) => {
          console.log("[notifications:realtime] INSERT", payload.new?.id);
          // Refetch both notifications list and unread count
          qc.invalidateQueries({ queryKey: QUERY_KEY(userId) });
          qc.invalidateQueries({ queryKey: UNREAD_KEY(userId) });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${userId}`,
        },
        () => {
          // Read status changed (e.g. from another device) — refresh unread
          qc.invalidateQueries({ queryKey: UNREAD_KEY(userId) });
        },
      )
      .subscribe((status) => {
        console.log("[notifications:realtime] channel status:", status);
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [userId, qc]);

  const notifications = notificationsQuery.data ?? [];
  const unreadCount = unreadQuery.data ?? 0;
  const isLoading = notificationsQuery.isLoading;

  return {
    notifications,
    unreadCount,
    isLoading,
    refetch: () => {
      notificationsQuery.refetch();
      unreadQuery.refetch();
    },
    markAllRead: () => markAllRead.mutate(),
  };
});
