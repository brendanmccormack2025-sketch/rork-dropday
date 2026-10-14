import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { ChevronLeft, UserPlus } from "lucide-react-native";

import { FeedAvatar } from "@/components/Avatar";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { myConversations, subscribeAnyMessage } from "@/lib/friends";
import { messagePreview, unreadLabel, type Conversation } from "@/lib/friendsCore";

/** Messages: one row per friend you have talked to, newest first, unread counts, live. */
export default function MessagesScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const [rows, setRows] = useState<Conversation[] | null>(null);

  const load = useCallback(() => {
    myConversations()
      .then((r) => setRows(r ?? []))
      .catch(() => setRows((prev) => prev ?? []));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      let off: (() => void) | null = null;
      try {
        off = subscribeAnyMessage(load);
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
    }, [load]),
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Pressable onPress={() => (navigation.canGoBack() ? router.back() : router.replace("/(tabs)"))} style={styles.iconBtn} hitSlop={8} accessibilityLabel="Back">
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Messages</UiText>
          <Pressable onPress={() => router.push("/people" as never)} style={styles.iconBtn} hitSlop={8} accessibilityLabel="Friends">
            <UserPlus color={theme.text} size={20} strokeWidth={2} />
          </Pressable>
        </View>
        {rows === null ? (
          <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <UiText style={styles.emptyTitle}>No messages yet</UiText>
            <UiText style={styles.emptyText}>Messages are with friends. Invite someone to start.</UiText>
            <Pressable onPress={() => router.push("/people" as never)} style={styles.cta} accessibilityRole="button">
              <UiText style={styles.ctaText}>Invite friends</UiText>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(c) => c.other_id}
            renderItem={({ item }) => {
              const badge = unreadLabel(item.unread);
              const name = item.display_name ?? item.username;
              return (
                <Pressable onPress={() => router.push(`/messages/${item.other_id}` as never)} style={styles.row} accessibilityLabel={`Chat with ${item.username}`}>
                  <FeedAvatar profile={item} name={name} />
                  <View style={{ flex: 1 }}>
                    <UiText style={[styles.name, badge ? styles.bold : null]} numberOfLines={1}>
                      {name}
                    </UiText>
                    <UiText style={[styles.preview, badge ? styles.bold : null]} numberOfLines={1}>
                      {messagePreview(item)}
                    </UiText>
                  </View>
                  {badge ? (
                    <View style={styles.badge}>
                      <UiText style={styles.badgeText}>{badge}</UiText>
                    </View>
                  ) : null}
                </Pressable>
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
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 18, fontWeight: "900", color: theme.text },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  name: { fontSize: 15, color: theme.text, fontWeight: "600" },
  preview: { fontSize: 13, color: theme.textMuted, marginTop: 1 },
  bold: { fontWeight: "800", color: theme.text },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: theme.accent, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  empty: { alignItems: "center", gap: 10, paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: theme.text },
  emptyText: { fontSize: 14, color: theme.textMuted, textAlign: "center" },
  cta: { marginTop: 8, backgroundColor: theme.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  ctaText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
