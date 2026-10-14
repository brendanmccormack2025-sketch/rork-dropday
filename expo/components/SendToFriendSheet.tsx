import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, Share, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Send, Users, X } from "lucide-react-native";

import { FeedAvatar } from "@/components/Avatar";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { friendsForPost, sendPostToFriend } from "@/lib/friends";
import { friendlyError, type Person } from "@/lib/friendsCore";
import type { Post } from "@/providers/PostsProvider";

/**
 * "Send to friend": the friends this post may go to. The list comes from the server (friends_for_post), which applies the
 * same rule as the send itself: a post still on Tryal is never offered to people its creator knows. The send can still be
 * refused by the server (then the row says so); nothing is decided here.
 */
export default function SendToFriendSheet({ post, onClose }: { post: Post | null; onClose: () => void }) {
  const router = useRouter();
  const [friends, setFriends] = useState<Person[] | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!post) {
      setFriends(null);
      setSent(new Set());
      setFailed({});
      return;
    }
    let alive = true;
    friendsForPost(post.id)
      .then((rows) => alive && setFriends(rows ?? []))
      .catch(() => alive && setFriends([]));
    return () => {
      alive = false;
    };
  }, [post]);

  if (!post) return null;

  const send = async (friend: Person) => {
    if (busy || sent.has(friend.id)) return;
    setBusy(friend.id);
    try {
      await sendPostToFriend(friend.id, post.id);
      setSent((s) => new Set(s).add(friend.id));
    } catch (e) {
      setFailed((f) => ({ ...f, [friend.id]: friendlyError(e) }));
    } finally {
      setBusy(null);
    }
  };

  const shareElsewhere = async () => {
    try {
      await Share.share({ message: `Check out this video on Tryal: ${post.media_url}` });
    } catch {
      // cancelled
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <UiText style={styles.title}>Send to friend</UiText>
        {friends === null ? (
          <ActivityIndicator color={theme.accent} style={{ marginVertical: 24 }} />
        ) : friends.length === 0 ? (
          <View style={styles.empty}>
            <Users color={theme.textMuted} size={20} />
            <UiText style={styles.emptyText}>No friends to send this to yet.</UiText>
            <Pressable
              onPress={() => {
                onClose();
                router.push("/people" as never);
              }}
              style={styles.linkBtn}
            >
              <UiText style={styles.linkText}>Invite friends</UiText>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={friends}
            keyExtractor={(f) => f.id}
            style={{ maxHeight: 320 }}
            contentContainerStyle={{ paddingVertical: 8, gap: 8 }}
            renderItem={({ item }) => {
              const done = sent.has(item.id);
              const name = item.display_name ?? item.username;
              return (
                <View>
                  <View style={styles.row}>
                    <FeedAvatar profile={item} name={name} />
                    <View style={{ flex: 1 }}>
                      <UiText style={styles.name} numberOfLines={1}>
                        {name}
                      </UiText>
                      <UiText style={styles.handle2} numberOfLines={1}>
                        @{item.username}
                      </UiText>
                    </View>
                    <Pressable
                      onPress={() => void send(item)}
                      disabled={done || busy !== null}
                      style={[styles.sendBtn, done && styles.sendBtnDone]}
                      accessibilityRole="button"
                      accessibilityLabel={`Send to ${name}`}
                    >
                      {busy === item.id ? <ActivityIndicator color="#fff" size="small" /> : <UiText style={[styles.sendText, done && styles.sendTextDone]}>{done ? "Sent" : "Send"}</UiText>}
                    </Pressable>
                  </View>
                  {failed[item.id] ? <UiText style={styles.error}>{failed[item.id]}</UiText> : null}
                </View>
              );
            }}
          />
        )}
        <Pressable onPress={shareElsewhere} style={styles.more}>
          <Send color={theme.accent} size={16} />
          <UiText style={styles.moreText}>Share elsewhere</UiText>
        </Pressable>
        <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Close">
          <X color={theme.text} size={18} />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { backgroundColor: theme.bg, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(10,10,10,0.18)", marginBottom: 12 },
  title: { fontSize: 17, fontWeight: "800", color: theme.text, marginBottom: 4 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 20 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 14 },
  linkText: { color: theme.accent, fontWeight: "700", fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { color: theme.text, fontSize: 15, fontWeight: "700" },
  handle2: { color: theme.textMuted, fontSize: 12 },
  sendBtn: { minWidth: 64, height: 34, borderRadius: 17, paddingHorizontal: 14, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDone: { backgroundColor: theme.card },
  sendText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  sendTextDone: { color: theme.textMuted },
  error: { color: theme.danger, fontSize: 12, marginLeft: 52, marginTop: 2 },
  more: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12 },
  moreText: { color: theme.accent, fontWeight: "700", fontSize: 14 },
  close: { position: "absolute", top: 14, right: 16, width: 28, height: 28, alignItems: "center", justifyContent: "center" },
});
