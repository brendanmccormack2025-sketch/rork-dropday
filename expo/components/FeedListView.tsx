import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
  ViewToken,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { useVideoFocus } from "@/hooks/useVideoFocus";
import { FeedItem } from "@/components/FeedItem";
import { theme, getDropWindowState } from "@/constants/theme";
import { usePosts, type Post } from "@/providers/PostsProvider";

const { height: SCREEN_H } = Dimensions.get("window");

export interface FeedListViewProps {
  /** The posts to render in the feed */
  posts: Post[];
  /** Whether data is still loading */
  isLoading?: boolean;
  /** Called on pull-to-refresh */
  onRefresh?: () => void;
  /** Whether a refresh is in progress */
  isRefreshing?: boolean;
  /** Initial scroll index (default 0) */
  initialIndex?: number;
  /** Custom header overlay rendered above the FlatList */
  headerComponent?: React.ReactNode;
  /** Custom empty state when posts is empty and not loading */
  emptyComponent?: React.ReactNode;
  /** Whether the participation gate overlay should be shown */
  showGate?: boolean;
  /** Gate overlay component */
  gateComponent?: React.ReactNode;
  /** Override for screen focus (default: from useVideoFocus) */
  forceFocused?: boolean;
  /** Called when the share button is tapped on a post */
  onSharePost?: (post: Post) => void;
  /** Called when the reactions button is tapped on a post */
  onReactionsPost?: (post: Post) => void;
  /** Bottom offset for action buttons and user info (default: 88 = tab bar height).
   *  Pass a safe-area-based value on screens without a tab bar. */
  bottomInset?: number;
  /** When this value changes, the list scrolls back to the top.
   *  Used to reset scroll position when switching feed tabs. */
  resetToken?: string | number;
}

/**
 * Shared full-screen vertical video feed FlatList.
 *
 * Extracted from the main Drop feed screen so it can be reused anywhere
 * (main feed tab, profile drops view, etc.) with the exact same FlatList
 * configuration, viewability handling, and playback management.
 *
 * FeedItem handles all video playback, like/delete/react/share buttons,
 * and stall detection internally via usePosts() and useAuth() context.
 */
export function FeedListView({
  posts,
  isLoading = false,
  onRefresh,
  isRefreshing = false,
  initialIndex = 0,
  headerComponent,
  emptyComponent,
  showGate = false,
  gateComponent,
  forceFocused,
  onSharePost,
  onReactionsPost,
  bottomInset,
  resetToken,
}: FeedListViewProps) {
  const tabFocused = useVideoFocus();

  const [isFocused, setIsFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  const screenFocused = (forceFocused ?? tabFocused) && isFocused;

  const [activeIndex, setActiveIndex] = useState<number>(initialIndex);
  const listRef = useRef<FlatList<Post>>(null);

  const { retryOptimisticPost, removeOptimisticPost } = usePosts();
  const win = useMemo(() => getDropWindowState(new Date()), []);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  // Scroll to top whenever resetToken changes (e.g. feed tab switch)
  useEffect(() => {
    if (resetToken === undefined) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [resetToken]);

  const getItemLayout = useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <FeedItem
        post={item}
        active={index === activeIndex && screenFocused}
        live={win.isOpen}
        bottomInset={bottomInset}
        onShare={() => onSharePost?.(item)}
        onReactions={() => onReactionsPost?.(item)}
        onRetry={() => retryOptimisticPost(item._optimistic?.tempId ?? "")}
        onDismiss={() => removeOptimisticPost(item._optimistic?.tempId ?? "")}
      />
    ),
    [activeIndex, screenFocused, win.isOpen, retryOptimisticPost, removeOptimisticPost, bottomInset, onSharePost, onReactionsPost],
  );

  const safeInitialIndex = Math.max(0, Math.min(initialIndex, posts.length - 1));

  // Only show empty state when not loading and posts is empty
  const showEmpty = !isLoading && posts.length === 0;
  const emptyNode = showEmpty
    ? (emptyComponent as React.ReactElement | undefined) ?? <View style={styles.emptyDefault} />
    : undefined;

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={posts}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        ListEmptyComponent={emptyNode}
        contentContainerStyle={
          showEmpty ? styles.emptyContainer : undefined
        }
        snapToInterval={SCREEN_H}
        snapToAlignment="start"
        decelerationRate="fast"
        bounces
        showsVerticalScrollIndicator={false}
        getItemLayout={posts.length > 0 ? getItemLayout : undefined}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        scrollEnabled
        // windowSize=5 instead of 3 gives more buffer before views are recycled.
        // removeClippedSubviews is intentionally omitted — on native it detaches
        // Video backing views during scroll, which can freeze expo-av players.
        windowSize={5}
        maxToRenderPerBatch={3}
        initialNumToRender={2}
        initialScrollIndex={
          safeInitialIndex > 0 && posts.length > 0 ? safeInitialIndex : undefined
        }
        onScrollToIndexFailed={(info) => {
          // Retry after layout settles — FlatList sometimes needs an extra frame
          // to compute item heights for initialScrollIndex.
          setTimeout(() => {
            listRef.current?.scrollToIndex({
              index: Math.min(info.index, posts.length - 1),
              animated: false,
            });
          }, 150);
        }}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={theme.accent}
              progressBackgroundColor={theme.card}
            />
          ) : undefined
        }
      />

      {/* Custom header overlay */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {headerComponent}
      </View>

      {/* Gate overlay */}
      {showGate && gateComponent}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  emptyContainer: {
    flexGrow: 1,
    minHeight: SCREEN_H + 1,
  },
  emptyDefault: {
    height: SCREEN_H,
  },
});
