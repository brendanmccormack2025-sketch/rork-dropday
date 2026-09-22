import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import UiText from "@/components/UiText";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import {
  ArrowLeft,
  Heart,
  ImagePlus,
  Send,
  Trash2,
  Users,
  X,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import { useQuery } from "@tanstack/react-query";

import { theme } from "@/constants/theme";
import { showAlert } from "@/lib/showAlert";
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import { useAuth } from "@/providers/AuthProvider";
import { useGroups, type GroupPost } from "@/providers/GroupsProvider";
import { FeedAvatar } from "@/components/Avatar";
import { supabase } from "@/lib/supabase";

export default function GroupFeedScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = Array.isArray(id) ? id[0] : id;

  const {
    useGroupPosts,
    useGroupMembers,
    createGroupPost,
    toggleGroupReaction,
    deleteGroupPost,
  } = useGroups();

  const postsQuery = useGroupPosts(groupId);
  const membersQuery = useGroupMembers(groupId);

  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [captionModalVisible, setCaptionModalVisible] = useState<boolean>(false);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [pendingType, setPendingType] = useState<"photo" | "video">("photo");
  const [picking, setPicking] = useState<boolean>(false);

  // expo-video player for the caption modal's video preview. Sources are
  // swapped via replace() — useVideoPlayer only reads its initial argument.
  const previewPlayer = useVideoPlayer(null);
  const previewLoadedUriRef = useRef<string | null>(null);
  useEffect(() => {
    const target =
      pendingType === "video" && pendingUri ? { uri: pendingUri } : null;
    const targetUri = target?.uri ?? null;
    if (previewLoadedUriRef.current !== targetUri) {
      previewLoadedUriRef.current = targetUri;
      previewPlayer.replace(target);
    }
  }, [pendingUri, pendingType, previewPlayer]);
  const [caption, setCaption] = useState<string>("");

  const posts = postsQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const memberCount = members.length;

  // Fetch group name
  const groupNameQuery = useQuery({
    queryKey: ["group-name", groupId],
    enabled: !!groupId,
    staleTime: 30_000,
    queryFn: async (): Promise<string> => {
      if (!groupId) return "Group";
      const { data, error } = await supabase
        .from("groups")
        .select("name")
        .eq("id", groupId)
        .single();
      if (error || !data) return "Group";
      return (data as Record<string, unknown>).name as string;
    },
  });

  const handlePickMedia = useCallback(async () => {
    if (uploading || picking) return;
    setPicking(true);

    // Request permissions
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Media Library Access",
        "Trial needs access to your photo library to post to the group. You can grant this in Settings.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Open Settings",
            onPress: () => {
              if (Platform.OS === "ios") {
                Linking.openURL("app-settings:");
              } else {
                Linking.openSettings();
              }
            },
          },
        ],
      );
      setPicking(false);
      return;
    }

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await launchLibraryWithRetry({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: false,
        quality: 1,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        exif: false,
        // Native default is false — iCloud-hosted assets then fail with
        // PHPhotosErrorDomain 3164 (NETWORK_ACCESS_REQUIRED).
        shouldDownloadFromNetwork: true,
      });
    } catch (e) {
      showAlert(
        "Library",
        e instanceof Error ? e.message : "Could not open your library.",
      );
      return;
    } finally {
      setPicking(false);
    }

    if (result.canceled || !result.assets || result.assets.length === 0) return;

    const asset = result.assets[0]!;
    const isVideo =
      (asset as { type?: string }).type === "video" ||
      asset.uri.toLowerCase().endsWith(".mp4") ||
      asset.uri.toLowerCase().endsWith(".mov");

    setPendingUri(asset.uri);
    setPendingType(isVideo ? "video" : "photo");
    setCaption("");
    setCaptionModalVisible(true);
  }, [uploading, picking]);

  const handleConfirmPost = useCallback(async () => {
    if (!pendingUri || !groupId) return;
    setCaptionModalVisible(false);
    setUploading(true);
    setUploadProgress("Uploading…");
    try {
      await createGroupPost.mutateAsync({
        groupId,
        uri: pendingUri,
        mediaType: pendingType,
        caption,
      });
      setPendingUri(null);
      setCaption("");
    } catch (e) {
      showAlert("Post failed", (e as Error)?.message ?? "Could not upload to group.");
    } finally {
      setUploading(false);
      setUploadProgress("");
    }
  }, [pendingUri, groupId, pendingType, caption, createGroupPost]);

  const handleToggleReaction = useCallback(
    (post: GroupPost) => {
      toggleGroupReaction.mutate({
        groupPostId: post.id,
        groupId: post.group_id,
        reacted: post.has_reacted ?? false,
      });
    },
    [toggleGroupReaction],
  );

  const handleDeletePost = useCallback(
    (post: GroupPost) => {
      Alert.alert(
        "Delete post?",
        "This will remove your post from the group.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await deleteGroupPost.mutateAsync({
                  groupPostId: post.id,
                  groupId: post.group_id,
                  mediaUrl: post.media_url,
                });
              } catch (e) {
                showAlert("Delete failed", (e as Error)?.message ?? "Could not delete post.");
              }
            },
          },
        ],
      );
    },
    [deleteGroupPost],
  );

  const renderPost = useCallback(
    ({ item }: { item: GroupPost }) => (
      <GroupPostCard
        post={item}
        currentUserId={user?.id ?? null}
        onToggleReaction={() => handleToggleReaction(item)}
        onDelete={() => handleDeletePost(item)}
      />
    ),
    [user?.id, handleToggleReaction, handleDeletePost],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft color={theme.text} size={22} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.headerCenter}>
          <UiText style={styles.headerTitle} numberOfLines={1}>
            {groupNameQuery.data ?? "Group"}
          </UiText>
          <View style={styles.memberBadge}>
            <Users color={theme.textDim} size={11} strokeWidth={2.5} />
            <UiText style={styles.memberCount}>
              {memberCount} member{memberCount !== 1 ? "s" : ""}
            </UiText>
          </View>
        </View>
        <View style={styles.backBtn} />
      </View>

      {/* Posts list */}
      <FlatList
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={renderPost}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          postsQuery.isLoading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator color={theme.accent} size="large" />
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Users color={theme.textDim} size={48} strokeWidth={1.5} />
              <UiText style={styles.emptyTitle}>No posts yet</UiText>
              <UiText style={styles.emptySub}>
                Be the first to share a photo or video with the group.
              </UiText>
            </View>
          )
        }
      />

      {/* Camera-roll upload button */}
      <View style={styles.bottomBar}>
        <Pressable
          onPress={handlePickMedia}
          disabled={uploading || picking}
          style={({ pressed }) => [
            styles.uploadBtn,
            pressed && !uploading && !picking && styles.uploadBtnPressed,
          ]}
        >
          {uploading || picking ? (
            <>
              <ActivityIndicator color={theme.accent} size="small" />
              <UiText style={styles.uploadBtnText}>
                {uploading ? uploadProgress || "Uploading…" : "Loading…"}
              </UiText>
            </>
          ) : (
            <>
              <ImagePlus color={theme.accent} size={22} strokeWidth={2.5} />
              <UiText style={styles.uploadBtnText}>Add Photo or Video</UiText>
            </>
          )}
        </Pressable>
      </View>

      {/* Caption modal */}
      <Modal
        visible={captionModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCaptionModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <UiText style={styles.modalTitle}>Add a caption</UiText>
              <Pressable onPress={() => setCaptionModalVisible(false)} hitSlop={8}>
                <X color={theme.textMuted} size={22} />
              </Pressable>
            </View>

            {/* Preview */}
            {pendingUri && (
              <View style={styles.previewWrap}>
                {pendingType === "video" ? (
                  <VideoView
                    player={previewPlayer}
                    style={styles.previewMedia}
                    contentFit="cover"
                    nativeControls
                  />
                ) : (
                  <Image
                    source={{ uri: pendingUri }}
                    style={styles.previewMedia}
                    contentFit="cover"
                    transition={100}
                  />
                )}
              </View>
            )}

            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Write a caption…"
              placeholderTextColor={theme.textDim}
              style={styles.captionInput}
              multiline
              maxLength={500}
              autoFocus
            />

            <Pressable
              onPress={handleConfirmPost}
              style={({ pressed }) => [
                styles.postBtn,
                pressed && styles.postBtnPressed,
              ]}
            >
              <Send color="#fff" size={18} strokeWidth={2.5} />
              <UiText style={styles.postBtnText}>Post to Group</UiText>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Group Post Card ──────────────────────────────────────────────────────────

function GroupPostCard({
  post,
  currentUserId,
  onToggleReaction,
  onDelete,
}: {
  post: GroupPost;
  currentUserId: string | null;
  onToggleReaction: () => void;
  onDelete: () => void;
}) {
  const posterName = post.profile?.display_name ?? post.profile?.username ?? "User";
  const isOwn = currentUserId === post.user_id;
  const reacted = post.has_reacted ?? false;
  const reactionCount = post.reaction_count ?? 0;

  // Static paused preview with native controls — the user taps play to watch.
  const cardPlayer = useVideoPlayer(
    post.media_type === "video" ? { uri: post.media_url } : null,
    (p) => {
      p.loop = true;
    },
  );

  return (
    <View style={styles.card}>
      {/* Poster info */}
      <View style={styles.cardHeader}>
        <FeedAvatar profile={post.profile} name={posterName} />
        <View style={styles.posterInfo}>
          <UiText style={styles.posterName} numberOfLines={1}>
            {posterName}
          </UiText>
          <UiText style={styles.posterHandle} numberOfLines={1}>
            @{post.profile?.username ?? "user"}
          </UiText>
        </View>
        {isOwn && (
          <Pressable onPress={onDelete} hitSlop={8} style={styles.deleteBtn}>
            <Trash2 color={theme.textDim} size={18} strokeWidth={2} />
          </Pressable>
        )}
      </View>

      {/* Media */}
      <View style={styles.mediaWrap}>
        {post.media_type === "video" ? (
          <VideoView
            player={cardPlayer}
            style={styles.media}
            contentFit="cover"
            nativeControls
          />
        ) : (
          <Image
            source={{ uri: post.media_url }}
            style={styles.media}
            contentFit="cover"
            transition={120}
            cachePolicy="memory-disk"
          />
        )}
      </View>

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable
          onPress={onToggleReaction}
          style={({ pressed }) => [
            styles.reactionBtn,
            pressed && styles.reactionBtnPressed,
          ]}
          hitSlop={8}
        >
          <Heart
            color={reacted ? "#E8291C" : theme.textMuted}
            size={22}
            strokeWidth={reacted ? 0 : 2.5}
            fill={reacted ? "#E8291C" : "none"}
          />
          {reactionCount > 0 && (
            <UiText style={[styles.reactionCount, reacted && styles.reactionCountActive]}>
              {reactionCount}
            </UiText>
          )}
        </Pressable>
      </View>

      {/* Caption */}
      {post.caption && (
        <View style={styles.captionWrap}>
          <UiText style={styles.posterNameInline}>{posterName}</UiText>
          <UiText style={styles.captionText}>{post.caption}</UiText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  memberBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  memberCount: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: "500" as const,
  },

  /* List */
  list: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 100,
    gap: 16,
  },

  /* Card */
  card: {
    backgroundColor: theme.card,
    borderRadius: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  posterInfo: {
    flex: 1,
    gap: 1,
  },
  posterName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "900" as const,
  },
  posterHandle: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "500" as const,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Media */
  mediaWrap: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: "#000",
  },
  media: {
    width: "100%",
    height: "100%",
  },

  /* Actions */
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 16,
  },
  reactionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  reactionBtnPressed: {
    transform: [{ scale: 0.92 }],
  },
  reactionCount: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  reactionCountActive: {
    color: "#E8291C",
  },

  /* Caption */
  captionWrap: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  posterNameInline: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "900" as const,
  },
  captionText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "400" as const,
    flex: 1,
  },

  /* Empty */
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
    paddingVertical: 80,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
    textAlign: "center",
  },
  emptySub: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },

  /* Bottom bar */
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
    backgroundColor: theme.bg,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "rgba(232,41,28,0.12)",
    borderWidth: 1.5,
    borderColor: theme.accent,
    borderRadius: 0,
    paddingVertical: 14,
  },
  uploadBtnPressed: {
    transform: [{ scale: 0.98 }],
    backgroundColor: "rgba(232,41,28,0.18)",
  },
  uploadBtnText: {
    color: theme.accent,
    fontSize: 15,
    fontWeight: "700" as const,
  },

  /* Caption modal */
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  modalCard: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  modalTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "900" as const,
  },
  previewWrap: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 16,
    backgroundColor: "#000",
  },
  previewMedia: {
    width: "100%",
    height: "100%",
  },
  captionInput: {
    backgroundColor: theme.card,
    borderRadius: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
    minHeight: 60,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 16,
    textAlignVertical: "top",
  },
  postBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.accent,
    borderRadius: 0,
    paddingVertical: 15,
  },
  postBtnPressed: {
    transform: [{ scale: 0.98 }],
  },
  postBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700" as const,
  },
});
