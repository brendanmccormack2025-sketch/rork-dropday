import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Search, Sparkles, UserPlus, UserCheck, X } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { usePosts, type ExploreCreator } from "@/providers/PostsProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useUserBlocks } from "@/hooks/useUserBlocks";
import { supabase } from "@/lib/supabase";

function formatEngagement(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ExploreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    exploreCreators,
    exploreCreatorsLoading,
    refetchExploreCreators,
    following,
    followUser,
    unfollowUser,
  } = usePosts();

  const [searchQuery, setSearchQuery] = useState<string>("");
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [followPending, setFollowPending] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<ExploreCreator[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);

  const { blockedUserIds } = useUserBlocks();

  const isSearching = searchQuery.trim().length > 0;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchExploreCreators();
    setRefreshing(false);
  }, [refetchExploreCreators]);

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
      } catch (e) {
        console.warn("[explore] toggle follow error", (e as Error)?.message ?? e);
      } finally {
        setFollowPending((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    },
    [followUser, unfollowUser],
  );

  const handleSearchChange = useCallback(
    async (text: string) => {
      setSearchQuery(text);
      if (text.trim().length === 0) {
        setSearchResults([]);
        return;
      }
      setSearchLoading(true);
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .ilike("username", `%${text.trim()}%`)
          .limit(20);
        if (error) {
          console.warn("[explore:search] error", error.message);
          setSearchResults([]);
        } else {
          setSearchResults(
            ((data ?? []) as Record<string, unknown>[]).map((row) => ({
              id: row.id as string,
              username: row.username as string,
              display_name: (row.display_name as string | null) ?? null,
              avatar_url: (row.avatar_url as string | null) ?? null,
              total_engagement: 0,
            })),
          );
        }
      } catch (e) {
        console.warn("[explore:search] fetch error", (e as Error)?.message ?? e);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [],
  );

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
  }, []);

  const followingSet = useMemo(() => new Set(following), [following]);

  // Blocked users are hidden from search results (read-side filter — updates
  // instantly on block/unblock, same as Suggested Creators).
  const visibleSearchResults = useMemo(
    () => searchResults.filter((u) => !blockedUserIds.has(u.id)),
    [searchResults, blockedUserIds],
  );

  const navigateToProfile = useCallback(
    (userId: string) => {
      if (userId === user?.id) {
        router.push("/(tabs)/profile" as never);
      } else {
        router.push({ pathname: "/user/[id]", params: { id: userId } } as never);
      }
    },
    [router, user?.id],
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        {/* Search bar */}
        <View style={styles.searchWrap}>
          <View style={styles.searchInputWrap}>
            <Search color="rgba(255,255,255,0.55)" size={16} />
            <TextInput
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder="Search creators by username"
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={clearSearch} hitSlop={8}>
                <X color="rgba(255,255,255,0.45)" size={16} />
              </Pressable>
            )}
          </View>
        </View>

        {/* Search results */}
        {isSearching ? (
          searchLoading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={theme.accent} size="small" />
            </View>
          ) : visibleSearchResults.length === 0 ? (
            <View style={styles.empty}>
              <Search color={theme.textDim} size={28} strokeWidth={1.5} />
              <UiText style={styles.emptyTitle}>No users found</UiText>
              <UiText style={styles.emptySub}>
                Try searching for a different username.
              </UiText>
            </View>
          ) : (
            <FlatList
              data={visibleSearchResults}
              keyExtractor={(u) => u.id}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <CreatorRow
                  creator={item}
                  isFollowing={followingSet.has(item.id)}
                  followPending={followPending.has(item.id)}
                  onToggleFollow={handleToggleFollow}
                  onPress={() => navigateToProfile(item.id)}
                  showEngagement={false}
                />
              )}
            />
          )
        ) : (
          /* Suggested Creators */
          <FlatList
            data={exploreCreators}
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
            ListHeaderComponent={
              <View style={styles.sectionHeaderWrap}>
                {/* Suggested Creators */}
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionBadge}>
                    <Sparkles color={theme.accent} size={14} strokeWidth={2} />
                  </View>
                  <UiText style={styles.sectionLabel}>Suggested Creators</UiText>
                </View>
                {exploreCreatorsLoading && (
                  <View style={styles.loadingWrap}>
                    <ActivityIndicator color={theme.accent} size="small" />
                  </View>
                )}
                {!exploreCreatorsLoading && exploreCreators.length === 0 && (
                  <View style={styles.empty}>
                    <Sparkles color={theme.textDim} size={28} strokeWidth={1.5} />
                    <UiText style={styles.emptyTitle}>No creators yet</UiText>
                    <UiText style={styles.emptySub}>
                      Be the first to drop and build your audience.
                    </UiText>
                  </View>
                )}
              </View>
            }
            renderItem={({ item }) => (
              <CreatorRow
                creator={item}
                isFollowing={followingSet.has(item.id)}
                followPending={followPending.has(item.id)}
                onToggleFollow={handleToggleFollow}
                onPress={() => navigateToProfile(item.id)}
                showEngagement
              />
            )}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

function CreatorRow({
  creator,
  isFollowing,
  followPending,
  onToggleFollow,
  onPress,
  showEngagement,
}: {
  creator: ExploreCreator;
  isFollowing: boolean;
  followPending: boolean;
  onToggleFollow: (id: string, currentlyFollowing: boolean) => void;
  onPress: () => void;
  showEngagement: boolean;
}) {
  const displayName = creator.display_name ?? creator.username;
  const pending = followPending;

  return (
    <Pressable onPress={onPress} style={styles.userRow}>
      <View style={styles.avatar}>
        <FeedAvatar profile={creator} name={displayName} />
      </View>
      <View style={styles.userInfo}>
        <UiText style={styles.userName} numberOfLines={1}>
          {displayName}
        </UiText>
        <View style={styles.userMeta}>
          <UiText style={styles.userHandle} numberOfLines={1}>
            @{creator.username}
          </UiText>
          {showEngagement && creator.total_engagement > 0 && (
            <>
              <UiText style={styles.metaDot}>·</UiText>
              <Sparkles color={theme.accent} size={10} strokeWidth={2} />
              <UiText style={styles.engagementText}>
                {formatEngagement(creator.total_engagement)}
              </UiText>
            </>
          )}
        </View>
      </View>
      <Pressable
        onPress={() => onToggleFollow(creator.id, isFollowing)}
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
            <UserCheck color={theme.textMuted} size={14} strokeWidth={2.5} />
            <UiText style={styles.followBtnTextActive}>Following</UiText>
          </>
        ) : (
          <>
            <UserPlus color="#fff" size={14} strokeWidth={2.5} />
            <UiText style={styles.followBtnText}>Follow</UiText>
          </>
        )}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  list: { paddingBottom: 120 },

  /* Search bar */
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 14,
  },
  searchInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(10,10,10,0.08)",
    borderRadius: 0,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.08)",
  },
  searchInput: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    paddingVertical: 0,
  },

  /* Section header */
  sectionHeaderWrap: {
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  sectionBadge: {
    width: 28,
    height: 28,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
    letterSpacing: -0.1,
  },

  /* Loading */
  loadingWrap: {
    paddingVertical: 28,
    alignItems: "center",
  },

  /* Empty */
  empty: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "900" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },

  /* User rows */
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 2,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  userInfo: {
    flex: 1,
    gap: 3,
  },
  userName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
  },
  userMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  userHandle: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "500" as const,
  },
  metaDot: {
    color: theme.textDim,
    fontSize: 11,
  },
  engagementText: {
    color: theme.accent,
    fontSize: 11,
    fontWeight: "700" as const,
  },
  followBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 0,
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
    backgroundColor: "rgba(10,10,10,0.08)",
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.1)",
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnActivePressed: {
    backgroundColor: "rgba(10,10,10,0.06)",
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

  /* Groups section */
  groupsSection: {
    marginBottom: 24,
  },
  groupsBadge: {
    width: 28,
    height: 28,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  newGroupBtn: {
    marginLeft: "auto",
    width: 30,
    height: 30,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  newGroupBtnPressed: {
    transform: [{ scale: 0.92 }],
    backgroundColor: "rgba(232,41,28,0.2)",
  },
  groupsEmpty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 20,
    paddingHorizontal: 20,
    backgroundColor: "rgba(10,10,10,0.04)",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.07)",
  },
  groupsEmptyPressed: {
    backgroundColor: "rgba(10,10,10,0.06)",
  },
  groupsEmptyTitle: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  groupsEmptySub: {
    color: theme.textMuted,
    fontSize: 12,
    textAlign: "center",
    lineHeight: 17,
  },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(10,10,10,0.04)",
    borderRadius: 0,
    marginBottom: 6,
  },
  groupRowPressed: {
    backgroundColor: "rgba(10,10,10,0.07)",
  },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: 0,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  groupInfo: {
    flex: 1,
    gap: 2,
  },
  groupName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  groupMeta: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "500" as const,
  },
});
