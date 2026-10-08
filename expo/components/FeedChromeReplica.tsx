import React from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Bell, Eye, Heart, MoreHorizontal, Music, Send, Video } from "lucide-react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import UiText from "@/components/UiText";
import { TrialStatusBadge } from "@/components/TrialStatusBadge";
import { TAB_BAR_HEIGHT } from "@/lib/feedLayout";

/**
 * A non-interactive copy of the feed's chrome (header, action rail, ON TRIAL bar, username,
 * sound line), laid out with the same numbers as FeedItem and the feed header, for the editor's
 * full-screen Preview. Nothing in it takes touches.
 */
export default function FeedChromeReplica({ username }: { username: string }) {
  const insets = useSafeAreaInsets();
  const bottomInset = TAB_BAR_HEIGHT;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={["rgba(0,0,0,0.4)", "transparent"]} style={styles.gradTop} />
      <LinearGradient colors={["transparent", "rgba(0,0,0,0.75)"]} locations={[0, 0.45]} style={styles.gradBottom} />

      <View style={[styles.headerRow, { paddingTop: insets.top + 4 }]}>
        <Image source={require("@/assets/images/trial-wordmark.png")} style={styles.brandLogo} contentFit="contain" />
        <View style={styles.bellBtn}>
          <Bell color="#fff" size={20} strokeWidth={2} />
        </View>
      </View>

      <View style={[styles.actions, { bottom: bottomInset + 22 }]}>
        <View style={styles.railAvatar}>
          <UiText style={styles.railAvatarInitial}>{username.charAt(0).toUpperCase()}</UiText>
        </View>
        <View style={styles.actionBtn}>
          <Heart color="#fff" fill="transparent" size={28} strokeWidth={2} />
          <UiText style={styles.actionLabel}>0</UiText>
        </View>
        <View style={styles.actionBtn}>
          <View style={styles.actionIconCircle}>
            <Video color="#fff" size={18} strokeWidth={2} />
          </View>
          <UiText style={styles.actionLabel}>0</UiText>
        </View>
        <View style={styles.actionBtn}>
          <Send color="#fff" size={26} strokeWidth={2} />
        </View>
        <View style={styles.actionBtn}>
          <MoreHorizontal color="#fff" size={26} strokeWidth={2} />
        </View>
        <View style={styles.actionBtn}>
          <Eye color="rgba(255,255,255,0.6)" size={22} strokeWidth={2} />
          <UiText style={styles.actionLabelMuted}>0</UiText>
        </View>
      </View>

      <View style={[styles.bottom, { bottom: bottomInset + 24 }]}>
        <View style={styles.badgeSlot}>
          <TrialStatusBadge status="trial" />
        </View>
        <View style={styles.userRow}>
          <UiText style={styles.username}>@{username}</UiText>
          <UiText style={styles.dotSep}>·</UiText>
          <UiText style={styles.ago}>1s</UiText>
        </View>
        <View style={styles.musicRow}>
          <Music color="rgba(255,255,255,0.6)" size={12} />
          <UiText style={styles.musicText}>Original sound</UiText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gradTop: { position: "absolute", top: 0, left: 0, right: 0, height: 90 },
  gradBottom: { position: "absolute", left: 0, right: 0, bottom: 0, height: 96 },
  headerRow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  brandLogo: { width: 72, height: 22 },
  bellBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  actions: { position: "absolute", right: 12, alignItems: "center", gap: 20 },
  railAvatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    overflow: "hidden",
    backgroundColor: "#B8281A",
    alignItems: "center",
    justifyContent: "center",
  },
  railAvatarInitial: { color: "#fff", fontSize: 15, fontWeight: "500" },
  actionBtn: { alignItems: "center", gap: 4 },
  actionIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { color: "#fff", fontSize: 12, fontWeight: "500", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 4 },
  actionLabelMuted: { color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "500", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 4 },
  bottom: { position: "absolute", left: 18, right: 84, gap: 6 },
  badgeSlot: { marginBottom: 4 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  username: { color: "#fff", fontWeight: "500", fontSize: 15, textShadowColor: "rgba(0,0,0,0.5)", textShadowRadius: 3 },
  dotSep: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontWeight: "400" },
  ago: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontWeight: "400" },
  musicRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  musicText: { color: "rgba(255,255,255,0.6)", fontSize: 12 },
});
