import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, UserX, Users } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { useRouter } from "expo-router";

type RequestUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export default function FollowRequestsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [actionPending, setActionPending] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const requestsQuery = useQuery({
    queryKey: ["follow-requests", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<RequestUser[]> => {
      if (!user?.id) return [];
      // Incoming pending requests: followee_id = me, status = 'pending'
      const { data: follows, error } = await supabase
        .from("follows")
        .select("follower_id")
        .eq("followee_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        console.warn("[follow-requests] query error", error.message);
        return [];
      }
      const ids = (follows ?? []).map(
        (r: { follower_id: string }) => r.follower_id,
      );
      if (ids.length === 0) return [];

      const { data: profiles, error: profileErr } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", ids);
      if (profileErr) {
        console.warn(
          "[follow-requests] profile query error",
          profileErr.message,
        );
        return [];
      }

      const profileMap = new Map(
        (profiles ?? []).map((p: Record<string, unknown>) => [
          p.id as string,
          p,
        ]),
      );

      return ids.map((id) => {
        const p = profileMap.get(id);
        return {
          id,
          username: (p?.username as string) ?? "unknown",
          display_name: (p?.display_name as string | null) ?? null,
          avatar_url: (p?.avatar_url as string | null) ?? null,
        };
      });
    },
  });

  const handleAccept = useCallback(
    async (followerId: string) => {
      if (!user?.id) return;
      setActionPending((prev) => new Set(prev).add(followerId));
      try {
        const { error } = await supabase
          .from("follows")
          .update({ status: "accepted" })
          .eq("follower_id", followerId)
          .eq("followee_id", user.id)
          .eq("status", "pending");
        if (error) throw error;
        qc.invalidateQueries({ queryKey: ["follow-requests"] });
        qc.invalidateQueries({ queryKey: ["followers-count", user.id] });
        qc.invalidateQueries({ queryKey: ["follows"] });
      } catch (e) {
        console.warn("[follow-requests] accept error", (e as Error)?.message ?? e);
      } finally {
        setActionPending((prev) => {
          const next = new Set(prev);
          next.delete(followerId);
          return next;
        });
      }
    },
    [user?.id, qc],
  );

  const handleDecline = useCallback(
    async (followerId: string) => {
      if (!user?.id) return;
      setActionPending((prev) => new Set(prev).add(followerId));
      try {
        const { error } = await supabase
          .from("follows")
          .delete()
          .eq("follower_id", followerId)
          .eq("followee_id", user.id)
          .eq("status", "pending");
        if (error) throw error;
        qc.invalidateQueries({ queryKey: ["follow-requests"] });
        qc.invalidateQueries({ queryKey: ["followers-count", user.id] });
      } catch (e) {
        console.warn("[follow-requests] decline error", (e as Error)?.message ?? e);
      } finally {
        setActionPending((prev) => {
          const next = new Set(prev);
          next.delete(followerId);
          return next;
        });
      }
    },
    [user?.id, qc],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await requestsQuery.refetch();
    setRefreshing(false);
  }, [requestsQuery]);

  const items = requestsQuery.data ?? [];
  const isLoading = requestsQuery.isLoading;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={8}
          >
            <ArrowLeft color={theme.text} size={20} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Follow Requests</UiText>
          <View style={styles.backBtn} />
        </View>

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.accent} size="large" />
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(u) => u.id}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.accent}
                progressBackgroundColor={theme.card}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Users color={theme.textDim} size={40} strokeWidth={1.5} />
                <UiText style={styles.emptyTitle}>No requests</UiText>
                <UiText style={styles.emptySub}>
                  When someone requests to follow you, they'll appear here.
                </UiText>
              </View>
            }
            renderItem={({ item }) => {
              const displayName = item.display_name ?? item.username;
              const pending = actionPending.has(item.id);
              return (
                <View style={styles.userRow}>
                  <Pressable
                    onPress={() => router.push(`/user/${item.id}` as never)}
                    style={styles.userRowLeft}
                  >
                    <View style={styles.avatar}>
                      <FeedAvatar profile={item} name={displayName} />
                    </View>
                    <View style={styles.userInfo}>
                      <UiText style={styles.userName} numberOfLines={1}>
                        {displayName}
                      </UiText>
                      <UiText style={styles.userHandle} numberOfLines={1}>
                        @{item.username}
                      </UiText>
                    </View>
                  </Pressable>
                  {pending ? (
                    <ActivityIndicator
                      color={theme.accent}
                      size="small"
                      style={styles.actionSpinner}
                    />
                  ) : (
                    <View style={styles.actions}>
                      <Pressable
                        onPress={() => handleAccept(item.id)}
                        style={({ pressed }) => [
                          styles.acceptBtn,
                          pressed && styles.acceptBtnPressed,
                        ]}
                      >
                        <Check color="#fff" size={14} strokeWidth={2.5} />
                      </Pressable>
                      <Pressable
                        onPress={() => handleDecline(item.id)}
                        style={({ pressed }) => [
                          styles.declineBtn,
                          pressed && styles.declineBtnPressed,
                        ]}
                      >
                        <UserX color={theme.textMuted} size={14} strokeWidth={2.5} />
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            }}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },

  /* Header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "700" as const,
  },

  loading: {
    paddingVertical: 60,
    alignItems: "center",
  },
  list: { paddingBottom: 120 },

  /* User row */
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  userRowLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  userInfo: { flex: 1, gap: 2 },
  userName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
  },
  userHandle: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "500" as const,
  },

  /* Actions */
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  acceptBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  acceptBtnPressed: {
    transform: [{ scale: 0.92 }],
    shadowOpacity: 0.15,
  },
  declineBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  declineBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
    transform: [{ scale: 0.92 }],
  },
  actionSpinner: {
    paddingHorizontal: 8,
  },

  /* Empty */
  empty: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 56,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
