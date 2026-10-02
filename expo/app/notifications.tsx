import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Bell, ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import NotificationItem, { isDisplayedNotification } from "@/components/NotificationItem";
import { theme } from "@/constants/theme";
import { useNotifications, type NotificationRow } from "@/providers/NotificationsProvider";

/** Standalone notifications list (opened from the bell in the Feed header). */
export default function NotificationsScreen() {
  const router = useRouter();
  const { notifications, unreadCount, isLoading, refetch, markAllRead } = useNotifications();
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Follower types and unknown types are skipped entirely.
  const shown = useMemo(() => notifications.filter(isDisplayedNotification), [notifications]);

  // Mark all notifications as read when this screen is focused
  useFocusEffect(
    useCallback(() => {
      if (unreadCount > 0) {
        // Small delay so the unread dot is visible briefly before clearing
        const timer = setTimeout(() => markAllRead(), 1200);
        return () => clearTimeout(timer);
      }
    }, [unreadCount, markAllRead]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleTap = useCallback(
    (notif: NotificationRow) => {
      if (notif.post_id) {
        router.push(`/post/${notif.post_id}/reaction-tree` as never);
      }
    },
    [router],
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Notifications</UiText>
          <View style={styles.backBtn} />
        </View>

        <FlatList
          data={shown}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <NotificationItem notif={item} onPress={handleTap} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
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
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.accent} size="small" />
              </View>
            ) : (
              <View style={styles.center}>
                <Bell color={theme.textDim} size={28} strokeWidth={1.5} />
                <UiText style={styles.emptyText}>
                  No notifications yet. When someone likes or reacts to your post, or your trial
                  ends, it'll show up here.
                </UiText>
              </View>
            )
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
    paddingVertical: 8,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "900" as const },
  list: { paddingBottom: 40, flexGrow: 1 },
  separator: { height: 1, backgroundColor: "rgba(10,10,10,0.05)", marginHorizontal: 16 },
  center: { alignItems: "center", justifyContent: "center", gap: 10, padding: 40 },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: "center", lineHeight: 20 },
});
