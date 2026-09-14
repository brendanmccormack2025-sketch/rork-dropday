import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ban, ChevronLeft } from "lucide-react-native";

import { theme } from "@/constants/theme";
import UiText from "@/components/UiText";
import { FeedAvatar } from "@/components/Avatar";
import { useUserBlocks } from "@/hooks/useUserBlocks";
import { supabase } from "@/lib/supabase";

type BlockedProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

/**
 * Settings → Blocked Accounts.
 *
 * Lists every user in the shared block set with full profile info and an
 * Unblock button. Unblock reuses the shared unblockUser from useUserBlocks,
 * so the row disappears instantly and the user's content is restored
 * everywhere (feed, explore, suggested) with no restart or refetch.
 */
export default function BlockedAccountsScreen() {
  const router = useRouter();
  const { blockedUserIds, unblockUser, blockPending } = useUserBlocks();

  const blockedIds = useMemo(
    () => Array.from(blockedUserIds),
    [blockedUserIds],
  );
  // Stable key derived from the block set — the profile query refetches
  // whenever someone is blocked or unblocked.
  const idsKey = useMemo(
    () => blockedIds.slice().sort().join(","),
    [blockedIds],
  );

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["blocked-profiles", idsKey],
    enabled: blockedIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<BlockedProfile[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", blockedIds);
      if (error) {
        console.warn("[blocked-accounts] query error", error.message);
        return [];
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        username: row.username as string,
        display_name: (row.display_name as string | null) ?? null,
        avatar_url: (row.avatar_url as string | null) ?? null,
      }));
    },
  });

  // Filter by the LIVE set so an unblock removes the row instantly —
  // no waiting for the profile query to refetch.
  const visibleProfiles = useMemo(
    () => profiles.filter((p) => blockedUserIds.has(p.id)),
    [profiles, blockedUserIds],
  );

  const hasBlocks = blockedUserIds.size > 0;
  const showLoading = hasBlocks && (isLoading || visibleProfiles.length === 0);

  const renderItem = ({ item }: { item: BlockedProfile }) => {
    const name = item.display_name ?? item.username;
    return (
      <View style={styles.rowWrap}>
        <FeedAvatar profile={item} name={name} />
        <View style={styles.rowInfo}>
          <UiText style={styles.rowName} numberOfLines={1}>
            {name}
          </UiText>
          <UiText style={styles.rowUsername} numberOfLines={1}>
            @{item.username}
          </UiText>
        </View>
        <Pressable
          onPress={() => unblockUser(item.id)}
          disabled={blockPending}
          style={({ pressed }) => [
            styles.unblockBtn,
            pressed && !blockPending && { opacity: 0.6 },
          ]}
        >
          {blockPending ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <UiText style={styles.unblockBtnText}>Unblock</UiText>
          )}
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace("/settings");
            }}
            style={styles.backBtn}
            hitSlop={8}
          >
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>Blocked Accounts</UiText>
          <View style={styles.headerSpacer} />
        </View>

        {showLoading ? (
          <View style={styles.centerWrap}>
            <ActivityIndicator color={theme.accent} size="large" />
          </View>
        ) : !hasBlocks ? (
          <View style={styles.centerWrap}>
            <Ban color={theme.textDim} size={40} strokeWidth={1.5} />
            <UiText style={styles.emptyTitle}>You haven't blocked anyone</UiText>
            <UiText style={styles.emptySub}>
              Blocked accounts are hidden from your feed, explore, and
              suggestions.
            </UiText>
          </View>
        ) : (
          <FlatList
            data={visibleProfiles}
            keyExtractor={(p) => p.id}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            renderItem={renderItem}
            ItemSeparatorComponent={() => <View style={styles.rowDivider} />}
          />
        )}
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
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  headerSpacer: { width: 40 },

  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },

  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: theme.card,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.07)",
  },
  rowInfo: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900" as const,
  },
  rowUsername: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "500" as const,
  },

  unblockBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(10,10,10,0.05)",
    minWidth: 78,
    alignItems: "center",
    justifyContent: "center",
  },
  unblockBtnText: {
    color: theme.text,
    fontSize: 12,
    fontWeight: "700" as const,
  },

  rowDivider: { height: 10 },

  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "900" as const,
    textAlign: "center",
  },
  emptySub: {
    color: theme.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
});
