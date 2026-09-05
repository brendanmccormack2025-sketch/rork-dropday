import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Camera, Users, X } from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { useGroups } from "@/providers/GroupsProvider";

type Props = {
  visible: boolean;
  onClose: () => void;
};

/**
 * Choice sheet shown when the center "+" tab is tapped.
 *
 * - Personal Drop → the existing camera flow (8–10 PM gated, posts outside any group)
 * - Group Drop → native library picker (videos only) → editor → publish into
 *   the user's accepted group. Enabled only with an accepted membership.
 */
export default function CreateChoiceSheet({ visible, onClose }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const { myGroups, groupsLoading } = useGroups();
  const [picking, setPicking] = useState<boolean>(false);

  const group = myGroups[0] ?? null;

  const handlePersonal = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    onClose();
    router.push("/camera");
  }, [onClose, router]);

  const handleGroup = useCallback(async () => {
    if (!group || picking) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    // Close the sheet BEFORE presenting the picker — on iOS a system picker
    // can be dismissed by the closing modal otherwise.
    onClose();
    setPicking(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        if (!user) return;
        Alert.alert(
          "Media Library Access",
          "DropDay needs access to your photo library to post a video to your group. You can grant this in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                if (Platform.OS === "ios") {
                  void import("react-native").then((rn) => rn.Linking.openURL("app-settings:"));
                } else {
                  void import("react-native").then((rn) => rn.Linking.openSettings());
                }
              },
            },
          ],
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        allowsMultipleSelection: false,
        quality: 1,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        exif: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0]!;
      router.push({
        pathname: "/edit",
        params: { videoUrl: asset.uri, groupId: group.id },
      } as never);
    } catch (e) {
      console.warn("[create-sheet] group picker error", (e as Error)?.message ?? e);
    } finally {
      setPicking(false);
    }
  }, [group, picking, onClose, router, user]);

  const handleCreateGroup = useCallback(() => {
    onClose();
    router.push("/group/new");
  }, [onClose, router]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <UiText style={styles.title}>Create</UiText>

        {/* Personal Drop — camera, drop-window gated */}
        <Pressable
          onPress={handlePersonal}
          style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
        >
          <View style={styles.optionIcon}>
            <Camera color={theme.accent} size={22} strokeWidth={2} />
          </View>
          <View style={styles.optionInfo}>
            <UiText style={styles.optionTitle}>Personal Drop</UiText>
            <UiText style={styles.optionSub}>
              Record with the camera · posts during The Drop (8–10 PM)
            </UiText>
          </View>
        </Pressable>

        {/* Group Drop — library video into the accepted group */}
        <Pressable
          onPress={handleGroup}
          disabled={!group || picking}
          style={({ pressed }) => [
            styles.option,
            !group && styles.optionDisabled,
            pressed && group && !picking && styles.optionPressed,
          ]}
        >
          <View style={[styles.optionIcon, !group && styles.optionIconDisabled]}>
            {picking ? (
              <ActivityIndicator color={theme.accent} size="small" />
            ) : (
              <Users color={group ? theme.accent : theme.textDim} size={22} strokeWidth={2} />
            )}
          </View>
          <View style={styles.optionInfo}>
            <UiText style={[styles.optionTitle, !group && styles.optionTitleDisabled]}>
              Group Drop
            </UiText>
            <UiText
              style={[styles.optionSub, !group && styles.optionTitleDisabled]}
              numberOfLines={1}
            >
              {groupsLoading
                ? "Checking your group…"
                : group
                  ? `Post a video from your library to ${group.name}`
                  : "Join a group to post — no time window"}
            </UiText>
          </View>
        </Pressable>

        {/* No group yet → shortcut to create one */}
        {!groupsLoading && !group && (
          <Pressable onPress={handleCreateGroup} style={styles.createGroupBtn}>
            <UiText style={styles.createGroupText}>Create a group</UiText>
          </Pressable>
        )}

        <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
          <X color={theme.textMuted} size={20} />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: 14,
  },
  title: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800" as const,
    letterSpacing: -0.2,
    marginBottom: 12,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    marginBottom: 10,
  },
  optionPressed: {
    backgroundColor: "rgba(255,255,255,0.08)",
    transform: [{ scale: 0.99 }],
  },
  optionDisabled: {
    opacity: 0.5,
  },
  optionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(10,132,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  optionIconDisabled: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  optionInfo: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700" as const,
  },
  optionTitleDisabled: {
    color: theme.textMuted,
  },
  optionSub: {
    color: theme.textMuted,
    fontSize: 12.5,
  },
  createGroupBtn: {
    alignSelf: "flex-start",
    marginTop: 2,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "rgba(10,132,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(10,132,255,0.25)",
  },
  createGroupText: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: "700" as const,
  },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 14,
    padding: 6,
  },
});
