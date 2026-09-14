import React, { useCallback } from "react";
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
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { ArrowLeft, MessageCircle, PenLine } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, type Conversation, resolveAvatarUrl } from "@/providers/PostsProvider";

function timeAgoStr(d: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function lastMsgPreview(msg: Conversation["lastMessage"]): string {
  if (!msg) return "";
  if (msg.text) return msg.text;
  if (msg.post_id) return "Shared a Drop";
  return "";
}

export default function InboxScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    conversations,
    conversationsLoading,
    refetchConversations,
  } = usePosts();

  const onRefresh = useCallback(async () => {
    await refetchConversations();
  }, [refetchConversations]);

  const renderItem = useCallback(
    ({ item }: { item: Conversation }) => {
      const other = item.otherProfile;
      const name = other?.display_name ?? other?.username ?? "User";
      const avatarUri = resolveAvatarUrl(other?.avatar_url ?? null);
      const preview = lastMsgPreview(item.lastMessage);
      const isMyMsg = item.lastMessage?.sender_id === user?.id;

      return (
        <Pressable
          style={({ pressed }) => [
            styles.convoRow,
            pressed && styles.convoRowPressed,
          ]}
          onPress={() => router.push(`/dm/${item.id}` as never)}
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
          <View style={styles.convoInfo}>
            <View style={styles.convoTop}>
              <UiText style={styles.convoName} numberOfLines={1}>
                {name}
              </UiText>
              <UiText style={styles.convoTime}>
                {item.lastMessage?.created_at
                  ? timeAgoStr(item.lastMessage.created_at)
                  : ""}
              </UiText>
            </View>
            <UiText style={styles.convoPreview} numberOfLines={1}>
              {isMyMsg ? "You: " : ""}
              {preview || "No messages yet"}
            </UiText>
          </View>
        </Pressable>
      );
    },
    [router, user?.id],
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
          <UiText style={styles.headerTitle}>Messages</UiText>
          <Pressable
            onPress={() => router.push("/dm/new" as never)}
            style={({ pressed }) => [
              styles.composeBtn,
              pressed && styles.composeBtnPressed,
            ]}
            hitSlop={8}
          >
            <PenLine color={theme.accent} size={20} strokeWidth={2.5} />
          </Pressable>
        </View>

        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          contentContainerStyle={
            conversations.length === 0 ? styles.emptyContainer : undefined
          }
          ListEmptyComponent={
            conversationsLoading ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator color={theme.accent} size="small" />
              </View>
            ) : (
              <View style={styles.emptyWrap}>
                <MessageCircle
                  color={theme.textDim}
                  size={40}
                  strokeWidth={1.5}
                />
                <UiText style={styles.emptyTitle}>No messages yet</UiText>
                <UiText style={styles.emptySub}>
                  Share a Drop with a friend to start a conversation.
                </UiText>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={conversationsLoading}
              onRefresh={onRefresh}
              tintColor={theme.accent}
              progressBackgroundColor={theme.card}
            />
          }
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
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  composeBtn: {
    width: 36,
    height: 36,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(232,41,28,0.1)",
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.2)",
  },
  composeBtnPressed: {
    backgroundColor: "rgba(232,41,28,0.2)",
    transform: [{ scale: 0.93 }],
  },
  headerTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  convoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  convoRowPressed: {
    backgroundColor: "rgba(10,10,10,0.04)",
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 0,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "900" as const,
  },
  convoInfo: {
    flex: 1,
    gap: 3,
  },
  convoTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  convoName: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
    flex: 1,
    marginRight: 8,
  },
  convoTime: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "500" as const,
  },
  convoPreview: {
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
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
