import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ChevronLeft, MoreHorizontal, Send } from "lucide-react-native";

import { FeedAvatar } from "@/components/Avatar";
import SharedPostCard from "@/components/SharedPostCard";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { useUserBlocks } from "@/hooks/useUserBlocks";
import { conversationFor, deleteMyMessage, fetchMessages, friendCanTest, markConversationRead, reportMessage, sendMessage, setFriendCanTest, subscribeMessages } from "@/lib/friends";
import { DELETED_MESSAGE_TEXT, friendlyError, mergeMessages, type ChatMessage, type Person } from "@/lib/friendsCore";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

/** A chat with one friend: text and shared posts, live. Report, delete my message, block. */
export default function ChatScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { blockUser } = useUserBlocks();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const other = String(userId);
  const [person, setPerson] = useState<Person | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const markRead = useCallback(() => {
    markConversationRead(other).catch(() => {});
  }, [other]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await supabase.from("profiles").select("id, username, display_name, avatar_url").eq("id", other).maybeSingle();
        if (alive && data) setPerson(data as Person);
        const cid = await conversationFor(other);
        if (!alive) return;
        setConversationId(cid);
        setMessages(await fetchMessages(cid));
        markRead();
      } catch (e) {
        if (alive) setError(friendlyError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [other, markRead]);

  useEffect(() => {
    if (!conversationId) return;
    let off: (() => void) | null = null;
    try {
      off = subscribeMessages(conversationId, (m) => {
        setMessages((prev) => mergeMessages(prev, [m]));
        if (m.sender_id !== user?.id) markRead();
      });
    } catch {
      off = null;
    }
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, [conversationId, user?.id, markRead]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(other, body);
      setText("");
      if (conversationId) setMessages(await fetchMessages(conversationId));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSending(false);
    }
  };

  const reload = async () => {
    if (conversationId) setMessages(await fetchMessages(conversationId));
  };

  const onLongPress = (m: ChatMessage) => {
    if (m.deleted_at) return;
    if (m.sender_id === user?.id) {
      Alert.alert("Delete this message?", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void deleteMyMessage(m.id).then(reload).catch((e) => setError(friendlyError(e))) },
      ]);
    } else {
      Alert.alert("Report this message?", "Tell us why.", [
        { text: "Cancel", style: "cancel" },
        ...(["spam", "harassment", "nudity", "other"] as const).map((reason) => ({
          text: reason[0]!.toUpperCase() + reason.slice(1),
          onPress: () =>
            void reportMessage(m.id, reason)
              .then(() => Alert.alert("Thanks", "We'll take a look."))
              .catch((e) => setError(friendlyError(e))),
        })),
      ]);
    }
  };

  const menu = async () => {
    // Friends never see your posts while they're testing; this lets one friend in (their views then count like a stranger's).
    let canTest = false;
    try {
      canTest = await friendCanTest(other);
    } catch {
      // the option still shows; setting it reports any problem
    }
    const who = person ? `@${person.username}` : "this friend";
    const toggle = () =>
      setFriendCanTest(other, !canTest)
        .then(() =>
          Alert.alert(
            canTest ? "Done" : `${who} can test your posts`,
            canTest
              ? `${who} won't see your posts while they're testing. They'll see them once they survive.`
              : `${who} can now be shown your posts while they're testing, and their reactions count like a stranger's.`,
          ),
        )
        .catch(() => Alert.alert("Couldn't change that", "Please try again."));
    Alert.alert(person ? `@${person.username}` : "Options", undefined, [
      { text: canTest ? "Stop letting them test my posts" : "Let them test my posts", onPress: () => void toggle() },
      { text: "Block", style: "destructive", onPress: () => blockUser(other) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const data = useMemo(() => [...messages].reverse(), [messages]);
  const name = person?.display_name ?? person?.username ?? "Chat";

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Pressable onPress={() => (navigation.canGoBack() ? router.back() : router.replace("/messages" as never))} style={styles.iconBtn} hitSlop={8} accessibilityLabel="Back">
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <Pressable style={styles.who} onPress={() => router.push(`/user/${other}` as never)} accessibilityLabel={`${name}'s profile`}>
            {person ? <FeedAvatar profile={person} name={name} size={34} /> : null}
            <UiText style={styles.title} numberOfLines={1}>
              {name}
            </UiText>
          </Pressable>
          <Pressable onPress={() => void menu()} style={styles.iconBtn} hitSlop={8} accessibilityLabel="More">
            <MoreHorizontal color={theme.text} size={20} />
          </Pressable>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          {loading ? (
            <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              ref={listRef}
              data={data}
              inverted
              keyExtractor={(m) => m.id}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}
              renderItem={({ item }) => {
                const mine = item.sender_id === user?.id;
                const isPost = item.was_post && !item.deleted_at;
                if (isPost) {
                  return (
                    <View style={[styles.postCol, mine ? styles.mineCol : styles.theirCol]}>
                      <Pressable
                        onPress={() => router.push(`/shared-post/${item.id}` as never)}
                        onLongPress={() => onLongPress(item)}
                        style={({ pressed }) => pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }}
                        accessibilityRole="button"
                        accessibilityLabel="Watch post"
                      >
                        <SharedPostCard postId={item.post_id} />
                      </Pressable>
                      {item.body ? (
                        <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                          <UiText style={[styles.text, mine && styles.onMine]}>{item.body}</UiText>
                        </View>
                      ) : null}
                    </View>
                  );
                }
                return (
                  <View style={[styles.bubbleRow, mine ? styles.mineRow : styles.theirRow]}>
                    <Pressable
                      onLongPress={() => onLongPress(item)}
                      style={[styles.bubble, mine ? styles.mine : styles.theirs, item.deleted_at ? styles.deleted : null]}
                    >
                      {item.deleted_at ? (
                        <UiText style={styles.deletedText}>{DELETED_MESSAGE_TEXT}</UiText>
                      ) : (
                        <UiText style={[styles.text, mine && styles.onMine]}>{item.body}</UiText>
                      )}
                    </Pressable>
                  </View>
                );
              }}
              ListEmptyComponent={error ? null : <UiText style={styles.hint}>Say hi to {name}.</UiText>}
            />
          )}
          {error ? <UiText style={styles.error}>{error}</UiText> : null}
          <View style={styles.composer}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={theme.textDim}
              style={styles.input}
              multiline
              maxLength={2000}
              editable={!loading && !!conversationId}
            />
            <Pressable onPress={() => void send()} disabled={!text.trim() || sending || !conversationId} style={[styles.sendBtn, (!text.trim() || !conversationId) && { opacity: 0.4 }]} accessibilityLabel="Send message">
              {sending ? <ActivityIndicator color="#fff" size="small" /> : <Send color="#fff" size={18} />}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 4 },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  who: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 16, fontWeight: "800", color: theme.text, flexShrink: 1 },
  bubbleRow: { flexDirection: "row" },
  mineRow: { justifyContent: "flex-end" },
  theirRow: { justifyContent: "flex-start" },
  bubble: { maxWidth: "80%", borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, gap: 4 },
  mine: { backgroundColor: theme.accent },
  theirs: { backgroundColor: theme.card },
  deleted: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.border },
  deletedText: { color: theme.textDim, fontSize: 14, fontStyle: "italic" },
  text: { color: theme.text, fontSize: 15 },
  onMine: { color: "#fff" },
  postCol: { gap: 4 },
  mineCol: { alignItems: "flex-end" },
  theirCol: { alignItems: "flex-start" },
  hint: { color: theme.textMuted, textAlign: "center", marginTop: 40, transform: [{ scaleY: -1 }] },
  error: { color: theme.danger, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  input: { flex: 1, maxHeight: 110, backgroundColor: theme.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, color: theme.text, fontSize: 15 },
  sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
});
