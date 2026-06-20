import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Video, ResizeMode } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Heart, Sparkles, Reply } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";
import type { Post } from "@/providers/PostsProvider";

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get("window");

/** Profile subset needed for avatars and "replying to" derivation. */
type ProfileCard = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ReactionTreeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [screenFocused, setScreenFocused] = useState<boolean>(true);

  // ── Data: RPC → enrich with profiles ──────────────────────────────────────
  const treeQuery = useQuery({
    queryKey: ["reaction-tree", id],
    enabled: !!id,
    queryFn: async () => {
      if (!id) return { posts: [] as Post[], profileMap: new Map<string, ProfileCard>() };

      // 1. Call the recursive CTE RPC
      const { data: rawRows, error: rpcErr } = await supabase.rpc(
        "get_reaction_tree",
        { root_id: id },
      );

      if (rpcErr) {
        console.warn("[reaction-tree] RPC error", rpcErr.message);
        return { posts: [] as Post[], profileMap: new Map<string, ProfileCard>() };
      }

      const posts: Post[] = ((rawRows ?? []) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          user_id: row.user_id as string,
          media_url: row.media_url as string,
          media_type: row.media_type as "image" | "video",
          caption: (row.caption as string | null) ?? null,
          parent_post_id: (row.parent_post_id as string | null) ?? null,
          segments: (row.segments as string[] | null) ?? null,
          audio_url: (row.audio_url as string | null) ?? null,
          trim_data: (row.trim_data as Post["trim_data"]) ?? null,
          thumbnail_url: (row.thumbnail_url as string | null) ?? null,
          created_at: row.created_at as string,
          like_count: (row.like_count as number | undefined) ?? 0,
          comment_count: (row.comment_count as number | undefined) ?? 0,
          reaction_count: (row.reaction_count as number | undefined) ?? 0,
          profile: null,
        }),
      );

      // 2. Collect unique user IDs and fetch their profiles
      const userIds = [...new Set(posts.map((p) => p.user_id))];
      const profileMap = new Map<string, ProfileCard>();

      if (userIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", userIds);

        if (profileRows) {
          for (const p of profileRows) {
            profileMap.set(p.id as string, {
              username: p.username as string,
              display_name: (p.display_name as string | null) ?? null,
              avatar_url: (p.avatar_url as string | null) ?? null,
            });
          }
        }
      }

      // 3. Attach profile data to each post
      const enriched = posts.map((p) => ({
        ...p,
        profile: profileMap.get(p.user_id) ?? null,
      }));

      return { posts: enriched, profileMap };
    },
  });

  const qc = useQueryClient();
  const posts = treeQuery.data?.posts ?? [];
  const profileMap = treeQuery.data?.profileMap ?? new Map<string, ProfileCard>();

  // ── Derive "replying to" usernames client-side ────────────────────────────
  const replyingToMap = useMemo(() => {
    // Build a post lookup for parent resolution
    const postMap = new Map<string, Post>();
    for (const p of posts) {
      postMap.set(p.id, p);
    }

    const result = new Map<string, string>();
    for (const p of posts) {
      if (!p.parent_post_id) continue;
      const parent = postMap.get(p.parent_post_id);
      if (!parent) continue;
      const parentProfile = profileMap.get(parent.user_id);
      if (parentProfile?.username) {
        result.set(p.id, parentProfile.username);
      }
    }
    return result;
  }, [posts, profileMap]);

  // ── Refetch on focus so the tree stays current after posting a reaction ──
  // Also pause all videos on blur so audio doesn't bleed into unrelated screens.
  useFocusEffect(
    useCallback(() => {
      qc.invalidateQueries({ queryKey: ["reaction-tree", id] });
      setScreenFocused(true);
      return () => {
        setScreenFocused(false);
      };
    }, [qc, id]),
  );

  // ── FlatList config ───────────────────────────────────────────────────────
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const getItemLayout = useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => {
      const parentPost =
        index > 0 && item.parent_post_id
          ? (posts.find((p) => p.id === item.parent_post_id) ?? null)
          : null;
      return (
        <TreeItem
          post={item}
          active={index === activeIndex && screenFocused}
          isRoot={index === 0}
          replyingTo={replyingToMap.get(item.id)}
          parentPost={parentPost}
        />
      );
    },
    [activeIndex, screenFocused, replyingToMap, posts],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      {/* Header */}
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => router.back()}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <ArrowLeft color={theme.text} size={22} strokeWidth={2} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Sparkles color={theme.accent} size={16} />
            <Text style={styles.headerTitle}>Reactions</Text>
          </View>
          {/* Spacer to keep title centered */}
          <View style={styles.headerBtn} />
        </View>
        {posts.length > 0 && (
          <Text style={styles.headerCount}>
            {posts.length} clip{posts.length !== 1 ? "s" : ""}
          </Text>
        )}
      </SafeAreaView>

      {/* Body */}
      {treeQuery.isLoading ? (
        <View style={styles.center}>
          <Text style={styles.emptySub}>Loading…</Text>
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.center}>
          <Sparkles color={theme.textDim} size={48} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>No reactions yet</Text>
          <Text style={styles.emptySub}>
            Be the first to react to this drop.
          </Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          renderItem={renderItem}
          pagingEnabled
          snapToInterval={SCREEN_H}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          showsVerticalScrollIndicator={false}
          getItemLayout={getItemLayout}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          windowSize={3}
          maxToRenderPerBatch={3}
          initialNumToRender={2}
          removeClippedSubviews
        />
      )}

      {/* React button — fixed at bottom, targets the currently-viewed post */}
      {posts.length > 0 && !treeQuery.isLoading && (
        <SafeAreaView edges={["bottom"]} style={styles.reactSafe}>
          <Pressable
            onPress={() => {
              const targetId = posts[activeIndex]?.id;
              if (!targetId) return;
              router.push(`/camera?reactingTo=${targetId}` as never);
            }}
            disabled={activeIndex >= posts.length}
            style={({ pressed }) => [
              styles.reactBtn,
              activeIndex >= posts.length && styles.reactBtnDisabled,
              pressed && styles.reactBtnPressed,
            ]}
          >
            <Reply color="#fff" size={18} strokeWidth={2.5} />
            <Text style={styles.reactBtnText}>
              React
              {posts[activeIndex]?.profile?.username
                ? ` to @${posts[activeIndex]!.profile!.username}`
                : ""}
            </Text>
          </Pressable>
        </SafeAreaView>
      )}
    </View>
  );
}

// ── Tree Item ───────────────────────────────────────────────────────────────

function TreeItem({
  post,
  active,
  isRoot,
  replyingTo,
  parentPost,
}: {
  post: Post;
  active: boolean;
  isRoot: boolean;
  replyingTo?: string;
  parentPost?: Post | null;
}) {
  // Root Drop — full-screen, unchanged
  if (isRoot) {
    return <RootItem post={post} active={active} />;
  }

  // Reaction — split view (fall back to full-screen if parent data missing)
  if (!parentPost) {
    return (
      <RootItem
        post={post}
        active={active}
        replyingTo={replyingTo}
        isRoot={false}
      />
    );
  }

  return (
    <ReactionSplitItem
      parentPost={parentPost}
      reactionPost={post}
      active={active}
      replyingTo={replyingTo}
    />
  );
}

// ── Root Item (full-screen, unchanged from original) ────────────────────────

function RootItem({
  post,
  active,
  replyingTo,
  isRoot = true,
}: {
  post: Post;
  active: boolean;
  replyingTo?: string;
  isRoot?: boolean;
}) {
  const [liked, setLiked] = useState<boolean>(false);
  const videoRef = useRef<Video>(null);
  const name =
    post.profile?.display_name || post.profile?.username || "dropper";

  // Release native player resources on unmount
  useEffect(() => {
    return () => {
      videoRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  return (
    <View style={styles.item}>
      {post.media_type === "video" ? (
        <Video
          ref={videoRef}
          source={{ uri: post.media_url }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          isLooping
          shouldPlay={active}
          isMuted={!active}
          useNativeControls={false}
          progressUpdateIntervalMillis={50}
        />
      ) : (
        <Image
          source={{ uri: post.media_url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
        />
      )}

      <LinearGradient
        colors={["rgba(0,0,0,0.55)", "transparent"]}
        style={styles.gradTop}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={styles.gradBottom}
        pointerEvents="none"
      />

      {/* Side actions */}
      <View style={styles.actions} pointerEvents="box-none">
        <Pressable
          onPress={() => setLiked((v) => !v)}
          style={styles.actionBtn}
          hitSlop={8}
        >
          <Heart
            color={liked ? theme.danger : "#fff"}
            fill={liked ? theme.danger : "transparent"}
            size={28}
            strokeWidth={2}
          />
          <Text style={styles.actionLabel}>
            {String((post.like_count ?? 0) + (liked ? 1 : 0))}
          </Text>
        </Pressable>

        <View style={styles.actionBtn}>
          <Sparkles color="#fff" size={28} strokeWidth={2} />
          <Text style={styles.actionLabel}>
            {String(post.reaction_count ?? 0)}
          </Text>
        </View>
      </View>

      {/* Bottom info */}
      <View style={styles.bottom} pointerEvents="box-none">
        {!isRoot && replyingTo && (
          <View style={styles.replyingRow}>
            <Reply color={theme.accent} size={11} strokeWidth={2.5} />
            <Text style={styles.replyingText}>
              replying to @{replyingTo}
            </Text>
          </View>
        )}

        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <FeedAvatar profile={post.profile} name={name} />
          </View>
          <Text style={styles.username}>
            @{post.profile?.username ?? "dropper"}
          </Text>
        </View>

        {post.caption ? (
          <Text style={styles.caption} numberOfLines={2}>
            {post.caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Reaction Split Item ─────────────────────────────────────────────────────

function ReactionSplitItem({
  parentPost,
  reactionPost,
  active,
  replyingTo,
}: {
  parentPost: Post;
  reactionPost: Post;
  active: boolean;
  replyingTo?: string;
}) {
  const topHeight = SCREEN_H * 0.58;
  const bottomHeight = SCREEN_H * 0.42;
  const reactionName =
    reactionPost.profile?.display_name ||
    reactionPost.profile?.username ||
    "dropper";

  const parentVideoRef = useRef<Video>(null);
  const reactionVideoRef = useRef<Video>(null);

  // ── Resource cleanup & sync restart ──────────────────────────────────
  // When inactive: videos unmount → native decoders/buffers released.
  // When active: both mount fresh, sync to position 0 for frame-lock start.
  // On unmount (screen blur / navigation away): unloadAsync to stop audio.
  useEffect(() => {
    if (active) {
      const timer = setTimeout(() => {
        parentVideoRef.current?.setPositionAsync(0);
        reactionVideoRef.current?.setPositionAsync(0);
      }, 50);
      return () => {
        clearTimeout(timer);
        parentVideoRef.current?.unloadAsync().catch(() => {});
        reactionVideoRef.current?.unloadAsync().catch(() => {});
      };
    }
    return () => {
      parentVideoRef.current?.unloadAsync().catch(() => {});
      reactionVideoRef.current?.unloadAsync().catch(() => {});
    };
  }, [active]);

  return (
    <View style={styles.item}>
      {/* ── Top: Parent clip (autoplay only, no controls) ──────────────── */}
      <View style={[styles.splitTop, { height: topHeight }]}>
        {parentPost.media_type === "video" ? (
          active ? (
            <Video
              ref={parentVideoRef}
              source={{ uri: parentPost.media_url }}
              style={StyleSheet.absoluteFill}
              resizeMode={ResizeMode.COVER}
              isLooping
              shouldPlay
              isMuted={false}
              volume={0.35}
              useNativeControls={false}
              progressUpdateIntervalMillis={50}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "#111" }]} />
          )
        ) : (
          <Image
            source={{ uri: parentPost.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
          />
        )}

        <LinearGradient
          colors={["rgba(0,0,0,0.45)", "transparent"]}
          style={styles.splitGradTop}
          pointerEvents="none"
        />
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.7)"]}
          style={styles.splitGradBottom}
          pointerEvents="none"
        />
      </View>

      {/* ── Divider ──────────────────────────────────────────────────────── */}
      <View style={styles.splitDivider} />

      {/* ── Bottom: Reaction clip (autoplay only, no controls) ──────────── */}
      <View style={[styles.splitBottom, { height: bottomHeight }]}>
        {reactionPost.media_type === "video" ? (
          active ? (
            <Video
              ref={reactionVideoRef}
              source={{ uri: reactionPost.media_url }}
              style={StyleSheet.absoluteFill}
              resizeMode={ResizeMode.COVER}
              isLooping
              shouldPlay
              isMuted={false}
              volume={1.0}
              useNativeControls={false}
              progressUpdateIntervalMillis={50}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "#111" }]} />
          )
        ) : (
          <Image
            source={{ uri: reactionPost.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
          />
        )}

        <LinearGradient
          colors={["rgba(0,0,0,0.45)", "transparent"]}
          style={styles.splitGradTop}
          pointerEvents="none"
        />
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.85)"]}
          style={styles.splitGradBottom}
          pointerEvents="none"
        />

        {/* Bottom info — reaction author */}
        <View style={styles.splitInfo} pointerEvents="box-none">
          {replyingTo && (
            <View style={styles.replyingRow}>
              <Reply color={theme.accent} size={11} strokeWidth={2.5} />
              <Text style={styles.replyingText}>
                replying to @{replyingTo}
              </Text>
            </View>
          )}

          <View style={styles.userRow}>
            <View style={styles.avatar}>
              <FeedAvatar profile={reactionPost.profile} name={reactionName} />
            </View>
            <Text style={styles.username}>
              @{reactionPost.profile?.username ?? "dropper"}
            </Text>
          </View>

          {reactionPost.caption ? (
            <Text style={styles.caption} numberOfLines={2}>
              {reactionPost.caption}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },

  /* Header */
  headerSafe: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "800" as const,
    letterSpacing: -0.2,
  },
  headerCount: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "600" as const,
    textAlign: "center",
    marginTop: 4,
  },

  /* Center / empty */
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },

  /* Item */
  item: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#000",
  },
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  gradBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 320,
  },

  /* Actions */
  actions: {
    position: "absolute",
    right: 12,
    bottom: 150,
    alignItems: "center",
    gap: 22,
  },
  actionBtn: { alignItems: "center", gap: 4 },
  actionLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700" as const,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },

  /* Bottom info */
  bottom: {
    position: "absolute",
    left: 16,
    right: 80,
    bottom: 130,
    gap: 8,
  },
  replyingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  replyingText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "600" as const,
  },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.violet,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: theme.violet,
    overflow: "hidden",
  },
  username: {
    color: "#fff",
    fontWeight: "800" as const,
    fontSize: 15,
  },
  caption: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
  },

  /* React button */
  reactSafe: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  reactBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 4,
  },
  reactBtnDisabled: {
    opacity: 0.3,
  },
  reactBtnPressed: {
    opacity: 0.75,
  },
  reactBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800" as const,
    letterSpacing: 0.2,
  },

  /* Split view */
  splitTop: {
    width: SCREEN_W,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  splitBottom: {
    width: SCREEN_W,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  splitDivider: {
    width: SCREEN_W,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  splitGradTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 80,
  },
  splitGradBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 120,
  },
  splitInfo: {
    position: "absolute",
    left: 16,
    right: 80,
    bottom: 130,
    gap: 6,
  },

});
