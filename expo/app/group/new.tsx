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
import { ArrowLeft, Check, Search, Users, X, CheckCircle2 } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { showAlert } from "@/lib/showAlert";
import { useAuth } from "@/providers/AuthProvider";
import { useGroups } from "@/providers/GroupsProvider";
import { resolveAvatarUrl } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

type SearchResult = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export default function CreateGroupScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { createGroup } = useGroups();

  const [groupName, setGroupName] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Search users (reuses the same pattern as dm/new and explore)
  const { data: searchResults = [], isLoading: searchLoading } = useQuery({
    queryKey: ["group-user-search", search],
    enabled: search.trim().length > 0 && !!user?.id,
    queryFn: async (): Promise<SearchResult[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .neq("id", user!.id)
        .or(`username.ilike.%${search.trim()}%,display_name.ilike.%${search.trim()}%`)
        .limit(20);
      if (error) {
        console.warn("[group-create:search] error", error.message);
        return [];
      }
      return (data ?? []) as SearchResult[];
    },
  });

  const selectedList = useMemo(() => {
    return searchResults.filter((r) => selectedIds.has(r.id));
  }, [searchResults, selectedIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmed = groupName.trim();
    if (!trimmed) {
      showAlert("Group name required", "Please enter a name for your group.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const groupId = await createGroup.mutateAsync({
        name: trimmed,
        memberIds: Array.from(selectedIds),
      });
      router.replace(`/group/${groupId}` as never);
    } catch (e) {
      showAlert("Couldn't create group", (e as Error)?.message ?? "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }, [groupName, selectedIds, submitting, createGroup, router]);

  const canCreate = groupName.trim().length > 0 && !submitting;

  const renderItem = useCallback(
    ({ item }: { item: SearchResult }) => {
      const name = item.display_name ?? item.username;
      const avatarUri = resolveAvatarUrl(item.avatar_url);
      const isSelected = selectedIds.has(item.id);

      return (
        <Pressable
          style={({ pressed }) => [
            styles.userRow,
            pressed && styles.userRowPressed,
          ]}
          onPress={() => toggleSelect(item.id)}
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
              @{item.username}
            </UiText>
          </View>
          {isSelected ? (
            <CheckCircle2 color={theme.accent} size={24} strokeWidth={2.5} fill="rgba(10,132,255,0.12)" />
          ) : (
            <View style={styles.circleEmpty} />
          )}
        </Pressable>
      );
    },
    [selectedIds, toggleSelect],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft color={theme.text} size={22} strokeWidth={2.5} />
        </Pressable>
        <UiText style={styles.headerTitle}>New Group</UiText>
        <Pressable
          onPress={handleCreate}
          disabled={!canCreate}
          style={({ pressed }) => [
            styles.createBtn,
            !canCreate && styles.createBtnDisabled,
            pressed && canCreate && styles.createBtnPressed,
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <UiText style={styles.createBtnText}>Create</UiText>
          )}
        </Pressable>
      </View>

      {/* Group name input */}
      <View style={styles.nameSection}>
        <View style={styles.nameInputWrap}>
          <Users color={theme.textDim} size={18} strokeWidth={2} />
          <TextInput
            value={groupName}
            onChangeText={setGroupName}
            placeholder="Group name"
            placeholderTextColor={theme.textDim}
            style={styles.nameInput}
            maxLength={50}
            autoFocus
          />
          {groupName.length > 0 && (
            <Pressable onPress={() => setGroupName("")} hitSlop={8}>
              <X color={theme.textDim} size={16} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Selected members chips */}
      {selectedIds.size > 0 && (
        <View style={styles.selectedSection}>
          <UiText style={styles.selectedLabel}>
            {selectedIds.size} member{selectedIds.size > 1 ? "s" : ""} selected
          </UiText>
        </View>
      )}

      {/* Search input */}
      <View style={styles.searchBar}>
        <Search color={theme.textDim} size={16} strokeWidth={2} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search users to add..."
          placeholderTextColor={theme.textDim}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <X color={theme.textDim} size={16} />
          </Pressable>
        )}
      </View>

      {/* Search results */}
      <FlatList
        data={searchResults}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={
          searchResults.length === 0 ? styles.emptyContainer : undefined
        }
        ListEmptyComponent={
          searchLoading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator color={theme.accent} size="small" />
            </View>
          ) : !search.trim() ? (
            <View style={styles.emptyWrap}>
              <Search color={theme.textDim} size={40} strokeWidth={1.5} />
              <UiText style={styles.emptyTitle}>Search for users</UiText>
              <UiText style={styles.emptySub}>
                Find people to add to your group.
              </UiText>
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Search color={theme.textDim} size={40} strokeWidth={1.5} />
              <UiText style={styles.emptyTitle}>No users found</UiText>
              <UiText style={styles.emptySub}>Try a different search.</UiText>
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
  createBtn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 10,
    minWidth: 70,
    alignItems: "center",
    justifyContent: "center",
  },
  createBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  createBtnPressed: {
    transform: [{ scale: 0.96 }],
  },
  createBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },

  /* Group name */
  nameSection: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  nameInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: theme.border,
  },
  nameInput: {
    flex: 1,
    color: theme.text,
    fontSize: 16,
    fontWeight: "600" as const,
    paddingVertical: 0,
  },

  /* Selected members */
  selectedSection: {
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  selectedLabel: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: "600" as const,
  },

  /* Search */
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 10,
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
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

  /* User rows */
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
  circleEmpty: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.15)",
  },

  /* Empty */
  emptyContainer: { flexGrow: 1 },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingVertical: 48,
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
