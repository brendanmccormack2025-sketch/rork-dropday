import React, { useEffect, useRef, useState, useCallback } from "react";
import type { RefObject } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Music2,
  Send,
  X,
  Users,
  Sparkles,
} from "lucide-react-native";

import DropletLogo from "@/components/DropletLogo";
import { FeedListView } from "@/components/FeedListView";
import { theme } from "@/constants/theme";
import { usePosts, type Post, resolveAvatarUrl } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");
const FREE_VIEWS_BEFORE_GATE = 5;

type FeedTab = "following" | "foryou";

export default function FeedScreen() {
  const router = useRouter();
  const {
    feed, feedLoading, refetchFeed,
    followingFeed, followingFeedLoading, refetchFollowingFeed,
    refetchMyPosts, optimisticPosts, lastPostCreatedAtRef,
  } = usePosts();
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [viewedIds, setViewedIds] = useState<Set<string>>(new Set());
  const [sharePost, setSharePost] = useState<Post | null>(null);
  const [activeTab, setActiveTab] = useState<FeedTab>("foryou");
  const isFirstFocusRef = useRef<boolean>(true);

  const viewedCount = viewedIds.size;
  // MVP: participation gate disabled — all users can scroll the full feed.
  // Re-enable before launch by restoring: !hasPostedInWindow && viewedCount >= FREE_VIEWS_BEFORE_GATE
  const gateActive = false;

  const activePosts = activeTab === "following" ? followingFeed : feed;
  const activeLoading = activeTab === "following" ? followingFeedLoading : feedLoading;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Refetch the active feed + myPosts so hasPostedInWindow updates correctly.
    const refetchActive = activeTab === "following" ? refetchFollowingFeed : refetchFeed;
    await Promise.all([refetchActive(), refetchMyPosts()]);
    setRefreshing(false);
  }, [activeTab, refetchFeed, refetchFollowingFeed, refetchMyPosts]);

  // Refetch on tab focus — ensures fresh data when returning from camera
  // or edit-profile without needing a manual pull-to-refresh.
  // Skip the initial mount: useQuery already fetches on cold start,
  // and an extra refetch here can race with the feed Video player's
  // initialization, causing a 100% reproducible freeze on cold open.
  //
  // Also skip refetch while optimistic posts are uploading — the refetch
  // can race with createPost's DB insert (Supabase eventual consistency)
  // and overwrite the cache, making the optimistic post disappear.
  //
  // Additionally skip refetch if a post was just created within the last
  // 5 seconds — createPost's onSuccess already patched the cache with the
  // new post at the top, and an immediate refetch would re-run rankFeed()
  // before the self-boost window kicks in, potentially pushing the new
  // post down.
  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }
      const hasPendingUpload = optimisticPosts.some(
        (p) => p._optimistic?.status === "uploading",
      );
      const msSincePost = Date.now() - (lastPostCreatedAtRef as RefObject<number>).current;
      const justPosted = msSincePost < 5_000;
      if (!hasPendingUpload && !justPosted) {
        refetchFeed();
        refetchFollowingFeed();
      }
    }, [refetchFeed, refetchFollowingFeed, optimisticPosts, lastPostCreatedAtRef])
  );

  return (
    <View style={styles.root}>
      <FeedListView
        posts={activePosts}
        isLoading={activeLoading}
        onRefresh={onRefresh}
        isRefreshing={refreshing}
        initialIndex={0}
        resetToken={activeTab}
        showGate={gateActive}
        onSharePost={(post) => setSharePost(post)}
        onReactionsPost={(post) => {
          router.push(`/post/${post.id}/reaction-tree` as never);
        }}
        headerComponent={
          <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.headerWrap}>
            <View style={styles.headerRow} pointerEvents="box-none">
              <View style={styles.brandRow}>
                <DropletLogo size={22} />
                <UiText style={styles.brand}>Trial</UiText>
              </View>
            </View>

            {/* Tab switcher */}
            <View style={styles.tabBar} pointerEvents="box-none">
              <Pressable
                onPress={() => setActiveTab("following")}
                style={[styles.tab, activeTab === "following" && styles.tabActive]}
              >
                <UiText style={[styles.tabText, activeTab === "following" && styles.tabTextActive]}>
                  Following
                </UiText>
              </Pressable>
              <Pressable
                onPress={() => setActiveTab("foryou")}
                style={[styles.tab, activeTab === "foryou" && styles.tabActive]}
              >
                <UiText style={[styles.tabText, activeTab === "foryou" && styles.tabTextActive]}>
                  For You
                </UiText>
              </Pressable>
            </View>
          </SafeAreaView>
        }
        emptyComponent={
          activeTab === "following" ? (
            <FollowingEmptyState onExploreForYou={() => setActiveTab("foryou")} />
          ) : (
            <EmptyState />
          )
        }
        gateComponent={
          gateActive ? (
            <GateOverlay
              onDrop={() => router.push("/camera")}
              viewed={viewedCount}
            />
          ) : undefined
        }
      />

      {/* Share sheet */}
      <ShareSheet
        post={sharePost}
        onClose={() => setSharePost(null)}
      />
    </View>
  );
}





function EmptyState() {
  return (
    <SafeAreaView style={styles.emptyWrap}>
      <DropletLogo size={56} />
      <UiText style={styles.emptyTitle}>No drops yet</UiText>
      <UiText style={styles.emptySub}>Be the first to drop.</UiText>
    </SafeAreaView>
  );
}

function FollowingEmptyState({ onExploreForYou }: { onExploreForYou: () => void }) {
  return (
    <SafeAreaView style={styles.emptyWrap}>
      <Users color={theme.textMuted} size={48} />
      <UiText style={styles.emptyTitle}>No drops from your follows yet</UiText>
      <UiText style={styles.emptySub}>
        Follow people to see their drops here. Head to For You to discover creators.
      </UiText>
      <Pressable onPress={onExploreForYou} style={styles.emptyBtn}>
        <UiText style={styles.emptyBtnText}>Explore For You</UiText>
      </Pressable>
    </SafeAreaView>
  );
}

function GateOverlay({
  onDrop,
  viewed,
}: {
  onDrop: () => void;
  viewed: number;
}) {
  return (
    <View style={styles.gateRoot} pointerEvents="auto">
      <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={styles.gateInner}>
        <View style={styles.gateIcon}>
          <DropletLogo size={42} />
        </View>
        <UiText style={styles.gateTitle}>Drop to unlock</UiText>
        <UiText style={styles.gateSub}>
          You've watched {viewed} drops. Post your Trial to keep watching
          tonight's feed.
        </UiText>
        <Pressable onPress={onDrop} style={styles.gateBtn}>
          <Sparkles color="#fff" size={16} />
          <UiText style={styles.gateBtnText}>Drop now</UiText>
        </Pressable>
        <UiText style={styles.gateFootnote}>
          Unlimited access for the night once you post.
        </UiText>
      </View>
    </View>
  );
}

function ShareSheet({
  post,
  onClose,
}: {
  post: Post | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { following, findOrCreateConversation, sendDropAsMessage } = usePosts();
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [friendProfiles, setFriendProfiles] = useState<
    Record<string, { username: string; display_name: string | null; avatar_url: string | null }>
  >({});

  // Fetch profile data for following users when the sheet opens
  useEffect(() => {
    if (!post || following.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", following.slice(0, 50));
        if (cancelled || !data) return;
        const map: Record<string, typeof friendProfiles[string]> = {};
        for (const p of data as Record<string, unknown>[]) {
          map[p.id as string] = {
            username: p.username as string,
            display_name: (p.display_name as string | null) ?? null,
            avatar_url: (p.avatar_url as string | null) ?? null,
          };
        }
        setFriendProfiles(map);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [post, following]);

  useEffect(() => {
    if (!post) setSentTo(new Set());
  }, [post]);

  if (!post) return null;

  const handleNativeShare = async () => {
    try {
      await Share.share({
        message: `Check out this Trial: ${post.media_url}`,
      });
    } catch {}
  };

  const handleSendAsDM = async (friendId: string) => {
    if (sending.has(friendId) || sentTo.has(friendId)) return;
    setSending((prev) => { const n = new Set(prev); n.add(friendId); return n; });
    try {
      // Find or create conversation, then send the drop as a message
      const convId = await findOrCreateConversation.mutateAsync(friendId);
      await sendDropAsMessage.mutateAsync({ conversationId: convId, postId: post.id });
      setSentTo((prev) => { const n = new Set(prev); n.add(friendId); return n; });
    } catch (e) {
      console.warn("[share] DM send error", (e as Error)?.message ?? e);
    } finally {
      setSending((prev) => { const n = new Set(prev); n.delete(friendId); return n; });
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <UiText style={styles.sheetTitle}>Send to a friend</UiText>
        <UiText style={styles.sheetSub}>
          Share this drop privately in a DM.
        </UiText>

        {following.length === 0 ? (
          <View style={styles.sheetEmpty}>
            <Users color={theme.textMuted} size={20} />
            <UiText style={styles.sheetEmptyText}>
              Follow friends to send drops directly.
            </UiText>
          </View>
        ) : (
          <FlatList
            data={following}
            keyExtractor={(id) => id}
            contentContainerStyle={{ paddingVertical: 8, gap: 8 }}
            renderItem={({ item }) => {
              const profile = friendProfiles[item];
              const sent = sentTo.has(item);
              const busy = sending.has(item);
              const name = profile?.display_name ?? profile?.username ?? item.slice(0, 8);
              const avatarUri = resolveAvatarUrl(profile?.avatar_url ?? null);

              return (
                <View style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    {avatarUri ? (
                      <Image
                        source={{ uri: avatarUri }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={80}
                      />
                    ) : (
                      <UiText style={styles.friendAvatarText}>
                        {name.charAt(0).toUpperCase()}
                      </UiText>
                    )}
                  </View>
                  <View style={styles.friendInfo}>
                    <UiText style={styles.friendName} numberOfLines={1}>
                      {name}
                    </UiText>
                    {profile?.username && profile.display_name ? (
                      <UiText style={styles.friendHandle} numberOfLines={1}>
                        @{profile.username}
                      </UiText>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => handleSendAsDM(item)}
                    disabled={sent || busy}
                    style={({ pressed }) => [
                      styles.sendBtn,
                      sent && styles.sendBtnDone,
                      pressed && !sent && !busy && styles.sendBtnPressed,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <UiText
                        style={[
                          styles.sendBtnText,
                          sent && styles.sendBtnTextDone,
                        ]}
                      >
                        {sent ? "Sent" : "Send"}
                      </UiText>
                    )}
                  </Pressable>
                </View>
              );
            }}
            style={{ maxHeight: 320 }}
          />
        )}

        <Pressable onPress={handleNativeShare} style={styles.shareMore}>
          <Send color={theme.accent} size={16} />
          <UiText style={styles.shareMoreText}>Share elsewhere</UiText>
        </Pressable>

        <Pressable onPress={onClose} style={styles.sheetClose}>
          <X color={theme.text} size={18} />
        </Pressable>
      </View>
    </Modal>
  );
}



const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  /* Header overlay */
  headerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  /* Tab switcher */
  tabBar: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 4,
    paddingHorizontal: 16,
    paddingBottom: 6,
    paddingTop: 2,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 0,
    backgroundColor: "transparent",
  },
  tabActive: {
    backgroundColor: "rgba(10,10,10,0.08)",
  },
  tabText: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },
  tabTextActive: {
    color: theme.text,
    fontWeight: "900" as const,
  },
  dmBtn: {
    width: 36,
    height: 36,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  dmBadge: {
    position: "absolute",
    top: 0,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 0,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  dmBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "900" as const,
  },
  brand: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  /* Empty */
  emptyContainer: {
    flexGrow: 1,
    minHeight: SCREEN_H + 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    minHeight: SCREEN_H + 1,
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
  },
  emptyBtn: {
    marginTop: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: theme.accent,
  },
  emptyBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },

  /* Gate overlay */
  gateRoot: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  gateInner: {
    alignItems: "center",
    gap: 12,
    padding: 28,
    borderRadius: 0,
    backgroundColor: "rgba(15,15,15,0.85)",
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.4)",
  },
  gateIcon: {
    width: 78,
    height: 78,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.3)",
  },
  gateTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
    marginTop: 4,
  },
  gateSub: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 280,
  },
  gateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.accent,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 0,
    marginTop: 8,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 18,
    elevation: 8,
  },
  gateBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900" as const,
    letterSpacing: 0.3,
  },
  gateFootnote: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 4,
  },

  /* Share sheet */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderColor: "rgba(10,10,10,0.07)",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 0,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: 14,
  },
  sheetTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
    letterSpacing: -0.2,
  },
  sheetSub: {
    color: theme.textMuted,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 10,
  },
  sheetEmpty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 24,
  },
  sheetEmptyText: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  friendAvatar: {
    width: 38,
    height: 38,
    borderRadius: 0,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  friendAvatarText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900" as const,
  },
  friendInfo: {
    flex: 1,
    gap: 1,
  },
  friendName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  friendHandle: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "500" as const,
  },
  sendBtn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 0,
    minWidth: 60,
    alignItems: "center",
  },
  sendBtnDone: {
    backgroundColor: "rgba(10,10,10,0.08)",
  },
  sendBtnPressed: {
    backgroundColor: theme.primaryDeep,
  },
  sendBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700" as const,
  },
  sendBtnTextDone: {
    color: theme.textMuted,
  },
  shareMore: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.1)",
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.25)",
  },
  shareMoreText: {
    color: theme.accent,
    fontSize: 14,
    fontWeight: "700" as const,
  },
  sheetClose: {
    position: "absolute",
    top: 12,
    right: 12,
    padding: 6,
  },


});
