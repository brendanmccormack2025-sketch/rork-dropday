import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, resolveAvatarUrl } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

type FollowedProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export default function NewConversationScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { following, findOrCreateConversation } = usePosts();
  const [search, setSearch] = useState<string>("");
  const [loadingConvId, setLoadingConvId] = useState<string | null>(null);

  // Fetch profiles for users the current user follows
  const { data: followedProfiles = [], isLoading } = useQuery({
    queryKey: ["followed-profiles", ...following],
    enabled: following.length > 0 && !!user?.id,
    queryFn: async (): Promise<FollowedProfile[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", following);

      if (error) {
        console.warn("[dm/new] profile query error", error.message);
        return [];
      }
      return ((data ?? []) as FollowedProfile[]).filter(
        (p) => p.id !== user?.id,
      );
    },
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return followedProfiles;
    const q = search.toLowerCase();
    return followedProfiles.filter((p) => {
      const dn = (p.display_name ?? "").toLowerCase();
      const un = (p.username ?? "").toLowerCase();
      return dn.includes(q) || un.includes(q);
    });
  }, [followedProfiles, search]);

  const handleSelectUser = useCallback(
    async (userId: string) => {
      if (loadingConvId) return;
      setLoadingConvId(userId);
      try {
        const convId = await findOrCreateConversation.mutateAsync(userId);
        router.replace(`/dm/${convId}` as never);
      } catch (e) {
        console.warn("[dm/new] findOrCreateConversation error", (e as Error)?.message ?? e);
      } finally {
        setLoadingConvId(null);
      }
    },
    [findOrCreateConversation, router, loadingConvId],
  );

  const renderItem = useCallback(
    ({ item }: { item: FollowedProfile }) => {
      const name = item.display_name ?? item.username ?? "User";
      const avatarUri = resolveAvatarUrl(item.avatar_url ?? null);
      const isBusy = loadingConvId === item.id;

      return (
        <Pressable
          style={({ pressed }) => [
            styles.userRow,
            pressed && styles.userRowPressed,
          ]}
          onPress={() => handleSelectUser(item.id)}
          disabled={!!loadingConvId}
        >
          <View style={styles.avatar}>
            {avatarUri ? (
              <Image
                source={{ uri: avatarUri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={80}
                cachePolicy="memory"
              />
            ) : (
              <UiText style={styles.avatarText}>
                {name.charAt(0).toUpperCase()}
              </UiText>
            )}
          </View>
          <View style={styles.userInfo}>
            <UiText style={styles.userName} numberOfLines={1}>
              {name}
            </UiText>
            <UiText style={styles.userHandle} numberOfLines={1}>
              @{item.username ?? "user"}
            </UiText>
          </View>
          {isBusy && (
            <ActivityIndicator color={theme.accent} size="small" />
          )}
        </Pressable>
      );
    },
    [handleSelectUser, loadingConvId],
  );

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
            <ArrowLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>New Message</UiText>
          <View style={styles.backBtn} />
        </View>

        {/* Search input */}
        <View style={styles.searchBar}>
          <Search color={theme.textDim} size={16} strokeWidth={2} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search following..."
            placeholderTextColor={theme.textDim}
            style={styles.searchInput}
            autoFocus
            returnKeyType="search"
          />
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={
            filtered.length === 0 ? styles.emptyContainer : undefined
          }
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator color={theme.accent} size="small" />
              </View>
            ) : (
              <View style={styles.emptyWrap}>
                <Search color={theme.textDim} size={40} strokeWidth={1.5} />
                <UiText style={styles.emptyTitle}>
                  {search.trim()
                    ? "No users found"
                    : following.length === 0
                      ? "You're not following anyone yet"
                      : "No users to message"}
                </UiText>
                <UiText style={styles.emptySub}>
                  {search.trim()
                    ? "Try a different search."
                    : following.length === 0
                      ? "Follow people to start conversations."
                      : ""}
                </UiText>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    letterSpacing: -0.3,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: theme.border,
  },
  searchInput: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    fontWeight: "500" as const,
    padding: 0,
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  userRowPressed: {
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "800" as const,
  },
  userInfo: {
    flex: 1,
    gap: 1,
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
  emptyContainer: {
    flexGrow: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    textAlign: "center",
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
