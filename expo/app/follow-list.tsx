import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, UserPlus, UserCheck } from "lucide-react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { resolveAvatarUrl } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts } from "@/providers/PostsProvider";

type FollowUser = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export default function FollowListScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    userId: string;
    type: "followers" | "following";
    title: string;
  }>();
  const { userId, type, title } = params;
  const { user } = useAuth();
  const { followUser, unfollowUser, following } = usePosts();
  const qc = useQueryClient();
  const [followPending, setFollowPending] = useState<Set<string>>(new Set());

  const listQuery = useQuery({
    queryKey: ["follow-list", userId, type],
    enabled: !!userId && !!type,
    queryFn: async (): Promise<FollowUser[]> => {
      if (!userId || !type) return [];

      const isFollowers = type === "followers";
      // For followers: who follows this user (followee_id = userId)
      // For following: who this user follows (follower_id = userId)
      const filterColumn = isFollowers ? "followee_id" : "follower_id";
      const idColumn = isFollowers ? "follower_id" : "followee_id";

      const { data, error } = await supabase
        .from("follows")
        .select(idColumn)
        .eq(filterColumn, userId)
        .limit(200);

      if (error) {
        console.warn("[follow-list] query error", error.message);
        return [];
      }

      const ids = (data ?? []).map((r: Record<string, unknown>) => r[idColumn] as string);
      if (ids.length === 0) return [];

      // Fetch profiles in a separate query (avoids FK-name guessing)
      const { data: profiles, error: profileErr } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", ids);

      if (profileErr) {
        console.warn("[follow-list] profile query error", profileErr.message);
        return [];
      }

      const profileMap = new Map(
        (profiles ?? []).map((p: Record<string, unknown>) => [p.id as string, p]),
      );

      // Preserve follow-list order
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

  const followingSet = useMemo(() => new Set(following), [following]);

  const handleToggleFollow = useCallback(
    async (targetId: string, currentlyFollowing: boolean) => {
      setFollowPending((prev) => {
        const next = new Set(prev);
        next.add(targetId);
        return next;
      });
      try {
        if (currentlyFollowing) {
          await unfollowUser.mutateAsync(targetId);
        } else {
          await followUser.mutateAsync(targetId);
        }
        qc.invalidateQueries({ queryKey: ["follow-list", userId, type] });
      } catch (e) {
        console.warn("[follow-list] toggle error", (e as Error)?.message ?? e);
      } finally {
        setFollowPending((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    },
    [followUser, unfollowUser, userId, type, qc],
  );

  const items = listQuery.data ?? [];
  const isLoading = listQuery.isLoading;

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
          <UiText style={styles.title}>{title ?? "Users"}</UiText>
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
            ListEmptyComponent={
              <View style={styles.empty}>
                <UiText style={styles.emptyText}>
                  {type === "followers"
                    ? "No followers yet."
                    : "Not following anyone yet."}
                </UiText>
              </View>
            }
            renderItem={({ item }) => {
              const isFollowing = followingSet.has(item.id);
              const isSelf = item.id === user?.id;
              const pending = followPending.has(item.id);
              const displayName = item.display_name ?? item.username;

              return (
                <View style={styles.userRow}>
                  <Pressable
                    onPress={() => router.push(`/user/${item.id}`)}
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
                  {!isSelf && (
                    <Pressable
                      onPress={() => handleToggleFollow(item.id, isFollowing)}
                      disabled={pending}
                      style={({ pressed }) => [
                        styles.followBtn,
                        isFollowing && styles.followBtnActive,
                        pressed && !isFollowing && styles.followBtnPressed,
                        pressed && isFollowing && styles.followBtnActivePressed,
                      ]}
                    >
                      {pending ? (
                        <ActivityIndicator
                          color={isFollowing ? theme.textMuted : "#fff"}
                          size="small"
                        />
                      ) : isFollowing ? (
                        <>
                          <UserCheck
                            color={theme.textMuted}
                            size={14}
                            strokeWidth={2.5}
                          />
                          <UiText style={styles.followBtnTextActive}>Following</UiText>
                        </>
                      ) : (
                        <>
                          <UserPlus color="#fff" size={14} strokeWidth={2.5} />
                          <UiText style={styles.followBtnText}>Follow</UiText>
                        </>
                      )}
                    </Pressable>
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
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700" as const,
  },

  /* List */
  list: { paddingBottom: 40 },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
  },

  /* User row */
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  userRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  userInfo: {
    flex: 1,
    gap: 2,
  },
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

  /* Follow button */
  followBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  followBtnPressed: {
    backgroundColor: theme.primaryDeep,
    transform: [{ scale: 0.96 }],
  },
  followBtnActive: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnActivePressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  followBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700" as const,
  },
  followBtnTextActive: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
});
