import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  Dimensions,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Image } from "expo-image";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Video, ResizeMode } from "expo-av";
import {
  ArrowLeft,
  Send,
  Play,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import {
  usePosts,
  type Message,
  type Conversation,
  resolveAvatarUrl,
} from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

const { width: SCREEN_W } = Dimensions.get("window");
const DM_CARD_W = SCREEN_W * 0.65;

function useConversationMessages(conversationId: string) {
  return useQuery({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    retry: 1,
    staleTime: 5000,
    queryFn: async (): Promise<Message[]> => {
      // Fetch messages
      const { data: msgs, error } = await supabase
        .from("messages")
        .select(
          "id, conversation_id, sender_id, text, post_id, created_at",
        )
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(100);

      if (error || !msgs?.length) return [];

      // Collect all sender IDs and post IDs
      const senderIds = [...new Set((msgs as Record<string, unknown>[]).map((m) => m.sender_id as string))];
      const postIds = [
        ...new Set(
          (msgs as Record<string, unknown>[])
            .filter((m) => m.post_id)
            .map((m) => m.post_id as string),
        ),
      ];

      // Fetch sender profiles
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", senderIds);
      const profileMap = new Map(
        (profiles ?? []).map((p: Record<string, unknown>) => [p.id as string, p]),
      );

      // Fetch shared posts
      const { data: posts } =
        postIds.length > 0
          ? await supabase
              .from("posts")
              .select(
                "id, media_url, media_type, thumbnail_url, caption, user_id, profiles!posts_user_id_fkey(username, display_name, avatar_url)",
              )
              .in("id", postIds)
          : { data: [] };
      const postMap = new Map(
        (posts ?? []).map((p: Record<string, unknown>) => [p.id as string, p]),
      );

      return (msgs as Record<string, unknown>[]).map((m) => {
        const pid = m.post_id as string | null;
        const sharedPost = pid ? postMap.get(pid) : null;
        return {
          id: m.id as string,
          conversation_id: m.conversation_id as string,
          sender_id: m.sender_id as string,
          text: (m.text as string | null) ?? null,
          post_id: pid,
          created_at: m.created_at as string,
          senderProfile: profileMap.get(m.sender_id as string)
            ? {
                username: (profileMap.get(m.sender_id as string) as Record<string, unknown>).username as string,
                display_name: ((profileMap.get(m.sender_id as string) as Record<string, unknown>).display_name as string | null) ?? null,
                avatar_url: ((profileMap.get(m.sender_id as string) as Record<string, unknown>).avatar_url as string | null) ?? null,
              }
            : null,
          sharedPost: sharedPost
            ? {
                id: sharedPost.id as string,
                media_url: sharedPost.media_url as string,
                media_type: sharedPost.media_type as "image" | "video",
                thumbnail_url: (sharedPost.thumbnail_url as string | null) ?? null,
                caption: (sharedPost.caption as string | null) ?? null,
                user_id: sharedPost.user_id as string,
                profile: (sharedPost.profiles as Record<string, unknown> | undefined)
                  ? {
                      username: ((sharedPost.profiles as Record<string, unknown>).username as string) ?? "",
                      display_name: ((sharedPost.profiles as Record<string, unknown>).display_name as string | null) ?? null,
                      avatar_url: ((sharedPost.profiles as Record<string, unknown>).avatar_url as string | null) ?? null,
                    }
                  : null,
              }
            : null,
        };
      });
    },
  });
}

function DropCard({
  post,
}: {
  post: NonNullable<Message["sharedPost"]>;
}) {
  const router = useRouter();
  const thumbnailUri = post.thumbnail_url ?? post.media_url;
  const isVideo = post.media_type === "video";
  const posterName =
    post.profile?.display_name ?? post.profile?.username ?? "dropper";

  return (
    <Pressable
      style={styles.dropCard}
      onPress={() => {
        // Navigate to the post's reaction-tree to view it
        router.push(`/post/${post.id}/reaction-tree` as never);
      }}
    >
      <View style={styles.dropCardMedia}>
        <Image
          source={{ uri: thumbnailUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={100}
        />
        {isVideo && (
          <View style={styles.playOverlay}>
            <Play color="#fff" size={22} fill="#fff" strokeWidth={0} />
          </View>
        )}
      </View>
      <View style={styles.dropCardInfo}>
        <UiText style={styles.dropCardUser} numberOfLines={1}>
          @{posterName}
        </UiText>
        {post.caption ? (
          <UiText style={styles.dropCardCaption} numberOfLines={2}>
            {post.caption}
          </UiText>
        ) : null}
        <UiText style={styles.dropCardLabel}>Shared Drop</UiText>
      </View>
    </Pressable>
  );
}

export default function ChatThreadScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { conversations, sendTextMessage } = usePosts();
  const qc = useQueryClient();
  const [text, setText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const flatListRef = useRef<FlatList<Message>>(null);

  const { data: messages = [], isLoading } =
    useConversationMessages(conversationId ?? "");

  // Find the other participant from conversations list
  const conversation = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId],
  );
  const otherUser = conversation?.otherProfile;
  const otherName = otherUser?.display_name ?? otherUser?.username ?? "User";
  const otherAvatarUri = useMemo(
    () => resolveAvatarUrl(otherUser?.avatar_url ?? null),
    [otherUser?.avatar_url],
  );

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      // Small delay to let layout settle
      const timer = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !conversationId) return;

    setSending(true);
    try {
      await sendTextMessage.mutateAsync({
        conversationId,
        text: trimmed,
      });
      setText("");
    } catch (e) {
      console.warn("[chat] send error", (e as Error)?.message ?? e);
    } finally {
      setSending(false);
    }
  }, [text, sending, conversationId, sendTextMessage]);

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      const isMine = item.sender_id === user?.id;

      // Drop share card
      if (item.sharedPost) {
        return (
          <View
            style={[
              styles.msgRow,
              isMine ? styles.msgRowMine : styles.msgRowTheirs,
            ]}
          >
            {!isMine && (
              <View style={styles.msgAvatarSm}>
                {item.senderProfile?.avatar_url ? (
                  <Image
                    source={{ uri: resolveAvatarUrl(item.senderProfile.avatar_url) ?? "" }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                  />
                ) : (
                  <UiText style={styles.msgAvatarSmText}>
                    {(item.senderProfile?.display_name ?? item.senderProfile?.username ?? "?").charAt(0).toUpperCase()}
                  </UiText>
                )}
              </View>
            )}
            <DropCard post={item.sharedPost} />
          </View>
        );
      }

      // Text message
      return (
        <View
          style={[
            styles.msgRow,
            isMine ? styles.msgRowMine : styles.msgRowTheirs,
          ]}
        >
          {!isMine && (
            <View style={styles.msgAvatarSm}>
              {item.senderProfile?.avatar_url ? (
                <Image
                  source={{ uri: resolveAvatarUrl(item.senderProfile.avatar_url) ?? "" }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : (
                <UiText style={styles.msgAvatarSmText}>
                  {(item.senderProfile?.display_name ?? item.senderProfile?.username ?? "?").charAt(0).toUpperCase()}
                </UiText>
              )}
            </View>
          )}
          <View
            style={[
              styles.bubble,
              isMine ? styles.bubbleMine : styles.bubbleTheirs,
            ]}
          >
            <UiText
              style={[
                styles.bubbleText,
                isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs,
              ]}
            >
              {item.text ?? ""}
            </UiText>
          </View>
        </View>
      );
    },
    [user?.id],
  );

  if (!conversationId) {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={["top"]} style={styles.safe}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
              <ArrowLeft color={theme.text} size={22} strokeWidth={2.5} />
            </Pressable>
            <UiText style={styles.headerTitle}>Chat</UiText>
            <View style={styles.backBtn} />
          </View>
          <View style={styles.emptyWrap}>
            <UiText style={styles.emptySub}>Conversation not found.</UiText>
          </View>
        </SafeAreaView>
      </View>
    );
  }

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
          <Pressable
            style={styles.headerUser}
            onPress={() => {
              if (otherUser?.id) {
                router.push(`/user/${otherUser.id}` as never);
              }
            }}
          >
            <View style={styles.headerAvatar}>
              {otherAvatarUri ? (
                <Image
                  source={{ uri: otherAvatarUri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={80}
                />
              ) : (
                <UiText style={styles.headerAvatarText}>
                  {otherName.charAt(0).toUpperCase()}
                </UiText>
              )}
            </View>
            <UiText style={styles.headerName} numberOfLines={1}>
              {otherName}
            </UiText>
          </Pressable>
          <View style={styles.backBtn} />
        </View>

        <KeyboardAvoidingView
          style={styles.flex1}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
        >
          {/* Messages */}
          {isLoading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.msgList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => {
                if (messages.length > 0) {
                  flatListRef.current?.scrollToEnd({ animated: false });
                }
              }}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <UiText style={styles.emptySub}>
                    No messages yet. Say hello!
                  </UiText>
                </View>
              }
            />
          )}

          {/* Input bar */}
          <SafeAreaView edges={["bottom"]} style={styles.inputBarSafe}>
            <View style={styles.inputBar}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Type a message..."
                placeholderTextColor={theme.textDim}
                style={styles.textInput}
                multiline
                maxLength={500}
                returnKeyType="send"
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
              />
              <Pressable
                onPress={handleSend}
                disabled={!text.trim() || sending}
                style={({ pressed }) => [
                  styles.sendBtn,
                  (!text.trim() || sending) && styles.sendBtnDisabled,
                  pressed && !sending && !!text.trim() && styles.sendBtnPressed,
                ]}
              >
                {sending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Send color="#fff" size={16} strokeWidth={2.5} />
                )}
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  flex1: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 8,
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
  headerUser: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    justifyContent: "center",
  },
  headerAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  headerAvatarText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "800" as const,
  },
  headerName: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700" as const,
    maxWidth: 180,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  msgList: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 6,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  msgRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    marginVertical: 2,
    maxWidth: "85%" as unknown as number,
  },
  msgRowMine: {
    alignSelf: "flex-end",
    flexDirection: "row-reverse",
  },
  msgRowTheirs: {
    alignSelf: "flex-start",
  },
  msgAvatarSm: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginBottom: 2,
  },
  msgAvatarSmText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800" as const,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    maxWidth: "100%" as unknown as number,
  },
  bubbleMine: {
    backgroundColor: theme.accent,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: theme.card,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 20,
  },
  bubbleTextMine: {
    color: "#fff",
  },
  bubbleTextTheirs: {
    color: theme.text,
  },
  dropCard: {
    backgroundColor: theme.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
    width: DM_CARD_W,
  },
  dropCardMedia: {
    width: DM_CARD_W,
    height: DM_CARD_W * 0.7,
    backgroundColor: "#0A0A14",
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  dropCardInfo: {
    padding: 10,
    gap: 2,
  },
  dropCardUser: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700" as const,
  },
  dropCardCaption: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  dropCardLabel: {
    color: theme.accent,
    fontSize: 11,
    fontWeight: "700" as const,
    marginTop: 4,
  },
  inputBarSafe: {
    backgroundColor: theme.bgElevated,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  sendBtnDisabled: {
    backgroundColor: theme.textDim,
    opacity: 0.5,
  },
  sendBtnPressed: {
    backgroundColor: theme.primaryDeep,
    transform: [{ scale: 0.93 }],
  },
});
