import { useState, useCallback, useEffect } from "react";
import { Alert } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Hook for blocking and unblocking users.
 *
 * Apple requires a block-user feature distinct from content reporting
 * (App Store Guideline 1.2). Blocked users' content is filtered out
 * of feeds client-side since RLS can't easily do cross-table blocking
 * without a function.
 *
 * Usage:
 *   const { blockedUserIds, blockUser, unblockUser, isBlocked, blockPending } = useUserBlocks();
 */

export function useUserBlocks() {
  const { user } = useAuth();
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  const [blockPending, setBlockPending] = useState<boolean>(false);

  // Load blocked user IDs on mount / when user changes
  useEffect(() => {
    if (!user?.id) {
      setBlockedUserIds(new Set());
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase
          .from("user_blocks")
          .select("blocked_id")
          .eq("blocker_id", user.id);
        if (error) {
          console.warn("[blocks] fetch error", error.message);
          return;
        }
        setBlockedUserIds(new Set((data ?? []).map((r: { blocked_id: string }) => r.blocked_id)));
      } catch (e) {
        console.warn("[blocks] unexpected error", (e as Error)?.message ?? e);
      }
    })();
  }, [user?.id]);

  const blockUser = useCallback(
    (blockedId: string) => {
      if (!user?.id || !blockedId || user.id === blockedId) return;

      Alert.alert(
        "Block this user?",
        "They won't be able to see your drops or react to them. Their content will be hidden from your feed.",
        [
          { text: "Cancel", style: "cancel" as const },
          {
            text: "Block",
            style: "destructive" as const,
            onPress: async () => {
              setBlockPending(true);
              try {
                const { error } = await supabase
                  .from("user_blocks")
                  .insert({ blocker_id: user.id, blocked_id: blockedId });
                if (error) {
                  if (error.code === "23505") {
                    // Already blocked — update state anyway
                    setBlockedUserIds((prev) => new Set([...prev, blockedId]));
                  } else {
                    console.error("[blocks] insert error", error.message);
                    Alert.alert("Failed to block", "Could not block this user. Please try again.");
                    return;
                  }
                }
                setBlockedUserIds((prev) => new Set([...prev, blockedId]));
              } catch (e) {
                console.error("[blocks] unexpected error", (e as Error)?.message ?? e);
                Alert.alert("Failed to block", "Something went wrong. Please try again.");
              } finally {
                setBlockPending(false);
              }
            },
          },
        ],
      );
    },
    [user?.id],
  );

  const unblockUser = useCallback(
    async (blockedId: string) => {
      if (!user?.id || !blockedId) return;
      setBlockPending(true);
      try {
        const { error } = await supabase
          .from("user_blocks")
          .delete()
          .eq("blocker_id", user.id)
          .eq("blocked_id", blockedId);
        if (error) {
          console.error("[blocks] delete error", error.message);
          return;
        }
        setBlockedUserIds((prev) => {
          const next = new Set(prev);
          next.delete(blockedId);
          return next;
        });
      } catch (e) {
        console.error("[blocks] unblock error", (e as Error)?.message ?? e);
      } finally {
        setBlockPending(false);
      }
    },
    [user?.id],
  );

  const isBlocked = useCallback(
    (userId: string) => blockedUserIds.has(userId),
    [blockedUserIds],
  );

  return { blockedUserIds, blockUser, unblockUser, isBlocked, blockPending };
}
