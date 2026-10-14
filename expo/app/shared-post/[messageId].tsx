import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";

import { FeedListView } from "@/components/FeedListView";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { openSharedPost } from "@/lib/friends";
import { POST_UNAVAILABLE_TEXT } from "@/lib/friendsCore";
import { supabase } from "@/lib/supabase";
import { FEED_POST_SELECT, mapFeedRow, type Post } from "@/providers/PostsProvider";

/**
 * A post that came in a message. The server decides whether it can still be shown (open_shared_post: ended, hidden,
 * deleted, or no longer allowed for this person -> "This post isn't available") and records that this person opened it from a
 * message, so their view, likes and reactions never count toward the post's verdict or exposure.
 */
export default function SharedPostScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "gone" } | { kind: "ok"; post: Post }>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await openSharedPost(String(messageId));
        if (!res.available || !res.post_id) {
          if (alive) setState({ kind: "gone" });
          return;
        }
        const { data, error } = await supabase.from("posts").select(FEED_POST_SELECT).eq("id", res.post_id).maybeSingle();
        if (!alive) return;
        setState(error || !data ? { kind: "gone" } : { kind: "ok", post: mapFeedRow(data as Record<string, unknown>) });
      } catch {
        if (alive) setState({ kind: "gone" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [messageId]);

  const back = () => (navigation.canGoBack() ? router.back() : router.replace("/messages" as never));

  if (state.kind === "ok") {
    return (
      <FeedListView
        posts={[state.post]}
        isLoading={false}
        initialIndex={0}
        forceFocused
        bottomInset={insets.bottom + 8}
        headerComponent={
          <View style={[styles.headerWrap, { paddingTop: insets.top + 12 }]}>
            <Pressable onPress={back} style={styles.backBtn} hitSlop={12} accessibilityLabel="Back">
              <ArrowLeft color="#fff" size={24} strokeWidth={2.5} />
            </Pressable>
          </View>
        }
      />
    );
  }
  return (
    <View style={styles.center}>
      <Pressable onPress={back} style={[styles.backDark, { top: insets.top + 12 }]} hitSlop={12} accessibilityLabel="Back">
        <ArrowLeft color={theme.text} size={24} strokeWidth={2.5} />
      </Pressable>
      {state.kind === "loading" ? <ActivityIndicator color={theme.accent} /> : <UiText style={styles.gone}>{POST_UNAVAILABLE_TEXT}</UiText>}
    </View>
  );
}

const styles = StyleSheet.create({
  headerWrap: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center" },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: 32 },
  backDark: { position: "absolute", left: 12, width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  gone: { color: theme.textMuted, fontSize: 16, fontWeight: "700", textAlign: "center" },
});
