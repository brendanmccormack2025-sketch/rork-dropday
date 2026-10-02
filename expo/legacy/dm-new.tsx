import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { showAlert } from "@/lib/showAlert";
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
  const { findOrCreateConversation } = usePosts();
  const [search, setSearch] = useState<string>("");
  const [loadingConvId, setLoadingConvId] = useState<string | null>(null);

  // Search all profiles matching the search input
  const { data: searchResults = [], isLoading } = useQuery({
    queryKey: ["dm-user-search", search],
    enabled: search.trim().length > 0 && !!user?.id,
    queryFn: async (): Promise<FollowedProfile[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .neq("id", user!.id)
        .or(`username.ilike.%${search.trim()}%,display_name.ilike.%${search.trim()}%`)
        .limit(20);

      if (error) {
        console.warn("[dm/new] profile search error", error.message);
        return [];
      }
      return (data ?? []) as FollowedProfile[];
    },
  });

  const results = useMemo(() => {
    return searchResults;
  }, [searchResults]);

  const handleSelectUser = useCallback(
    async (userId: string) => {
      if (loadingConvId) return;
      setLoadingConvId(userId);
      try {
        const convId = await findOrCreateConversation.mutateAsync(userId);
        router.replace(`/dm/${convId}` as never);
      } catch (e) {
        console.error("[dm/new] findOrCreateConversation full error:", JSON.stringify(e), (e as Error)?.message, (e as Error)?.stack);
        Alert.alert("Couldn't start conversation", (e as Error)?.message ?? "Something went wrong. Please try again.");
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
    <SafeAreaView style={styles.root} edges={["top"]}>
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
            placeholder="Search users..."
            placeholderTextColor={theme.textDim}
            style={styles.searchInput}
            autoFocus
            returnKeyType="search"
          />
        </View>

        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={
            results.length === 0 ? styles.emptyContainer : undefined
          }
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator color={theme.accent} size="small" />
              </View>
            ) : !search.trim() ? (
              <View style={styles.emptyWrap}>
                <Search color={theme.textDim} size={40} strokeWidth={1.5} />
                <UiText style={styles.emptyTitle}>Search for users</UiText>
                <UiText style={styles.emptySub}>
                  Start typing a name or username to find people.
                </UiText>
              </View>
            ) : (
              <View style={styles.emptyWrap}>
                <Search color={theme.textDim} size={40} strokeWidth={1.5} />
                <UiText style={styles.emptyTitle}>No users found</UiText>
                <UiText style={styles.emptySub}>
                  Try a different search.
                </UiText>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
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
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: theme.card,
    borderRadius: 0,
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
    backgroundColor: "rgba(10,10,10,0.04)",
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 0,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "900" as const,
  },
  userInfo: {
    flex: 1,
    gap: 1,
  },
  userName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
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
    fontWeight: "900" as const,
    textAlign: "center",
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
