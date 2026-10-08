import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
  ViewToken,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoFocus } from "@/hooks/useVideoFocus";
import { FeedItem } from "@/components/FeedItem";
import { theme } from "@/constants/theme";
import { usePosts, type Post } from "@/providers/PostsProvider";
import { isPosting, playingIndex, rowKey, scrollTarget } from "@/lib/postingFeed";

const { height: SCREEN_H } = Dimensions.get("window");

/** Space the Feed header (wordmark + bell) takes below the status bar. */
const HEADER_BELOW_INSET = 48;
/** iOS: how far past the top (px) a drag must go to trigger a refresh. */
const PULL_TO_REFRESH_DISTANCE = 70;
/** Height of the floating tab bar (app/(tabs)/_layout.tsx tabBar.height). */
const TAB_BAR_HEIGHT = 88;
/** Content area of the tab bar above the home indicator. */
const TAB_BAR_CONTENT = 54;

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
  /** Called when the user scrolls near the end of the list (infinite scroll) */
  onEndReached?: () => void;
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
  onEndReached,
  showGate = false,
  gateComponent,
  forceFocused,
  onSharePost,
  onReactionsPost,
  bottomInset,
  resetToken,
}: FeedListViewProps) {
  const tabFocused = useVideoFocus();
  const insets = useSafeAreaInsets();
  // Refresh indicator sits below the header, inside the safe area.
  const indicatorTop = insets.top + HEADER_BELOW_INSET + 8;
  // Posts are exactly as tall as the list (the header is an overlay and the tab bar
  // floats on top), so snapping never drifts. Overlays clear the tab bar plus the
  // bottom safe area.
  const [listH, setListH] = useState<number>(SCREEN_H);
  const overlayInset = bottomInset ?? Math.max(TAB_BAR_HEIGHT, insets.bottom + TAB_BAR_CONTENT);

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

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === "number") {
        setActiveIndex(first.index);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  // An upload starts: the new post is first, so show it. Nothing else plays meanwhile (see playingIndex).
  const posting = isPosting(posts);
  useEffect(() => {
    if (!posting) return;
    const target = scrollTarget(posts);
    if (target === null) return;
    try {
      listRef.current?.scrollToOffset({ offset: listH * target, animated: false });
      setActiveIndex(target);
    } catch {
      // Scrolling is best-effort: a failure must never break posting.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posting]);

  // Scroll to top whenever resetToken changes (e.g. feed tab switch)
  useEffect(() => {
    if (resetToken === undefined) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [resetToken]);

  const getItemLayout = useCallback(
    (_: ArrayLike<Post> | null | undefined, index: number) => ({
      length: listH,
      offset: listH * index,
      index,
    }),
    [listH],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <FeedItem
        post={item}
        active={index === playingIndex(posts, activeIndex, screenFocused)}
        bottomInset={overlayInset}
        itemHeight={listH}
        onShare={() => onSharePost?.(item)}
        onReactions={() => onReactionsPost?.(item)}
        onRetry={() => retryOptimisticPost(item._optimistic?.tempId ?? "")}
        onDismiss={() => removeOptimisticPost(item._optimistic?.tempId ?? "")}
      />
    ),
    [posts, activeIndex, screenFocused, retryOptimisticPost, removeOptimisticPost, overlayInset, listH, onSharePost, onReactionsPost],
  );

  const safeInitialIndex = Math.max(0, Math.min(initialIndex, posts.length - 1));

  // Only show empty state when not loading and posts is empty
  const showEmpty = !isLoading && posts.length === 0;
  const emptyNode = showEmpty
    ? (emptyComponent as React.ReactElement | undefined) ?? <View style={{ height: listH }} />
    : undefined;

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 0 && h !== listH) setListH(h);
      }}
    >
      <FlatList
        ref={listRef}
        data={posts}
        keyExtractor={rowKey}
        renderItem={renderItem}
        ListEmptyComponent={emptyNode}
        onEndReached={onEndReached}
        onEndReachedThreshold={2}
        contentContainerStyle={
          showEmpty ? [styles.emptyContainer, { minHeight: listH + 1 }] : undefined
        }
        snapToInterval={listH}
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
        // iOS: a RefreshControl insets the content while it spins, which pushes the
        // post down. Trigger on pull distance instead and show the overlay below.
        onScrollEndDrag={
          Platform.OS === "ios" && onRefresh
            ? (e) => {
                if (!isRefreshing && e.nativeEvent.contentOffset.y < -PULL_TO_REFRESH_DISTANCE) {
                  onRefresh();
                }
              }
            : undefined
        }
        // Android: the native control only supplies the gesture (it is drawn
        // transparent and placed below the header); the overlay is the indicator.
        refreshControl={
          Platform.OS === "android" && onRefresh ? (
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={["transparent"]}
              progressBackgroundColor="transparent"
              progressViewOffset={indicatorTop}
            />
          ) : undefined
        }
      />

      {/* Refresh indicator: small, below the header, does not move the list */}
      {isRefreshing ? (
        <View style={[styles.refreshIndicator, { top: indicatorTop }]} pointerEvents="none">
          <ActivityIndicator size="small" color={theme.accent} />
        </View>
      ) : null}

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
  root: { flex: 1, backgroundColor: "#000" },
  refreshIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyContainer: {
    flexGrow: 1,
    minHeight: SCREEN_H + 1,
  },
  emptyDefault: {
    height: SCREEN_H,
  },
});
