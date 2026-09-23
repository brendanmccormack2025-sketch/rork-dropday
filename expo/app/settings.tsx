import React, { useState, useCallback } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ban, ChevronLeft, FileText, LogOut, Shield, Trash2, User } from "lucide-react-native";

import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import UiText from "@/components/UiText";

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut, deleteAccount } = useAuth();
  const [deleting, setDeleting] = useState<boolean>(false);

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => {
          signOut().catch((e) => {
            console.warn("[settings] signOut error", (e as Error)?.message ?? e);
          });
        },
      },
    ]);
  }, [signOut]);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      "Delete Account",
      "Are you sure? This cannot be undone. All your posts, reactions, and profile will be permanently deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Permanently",
          style: "destructive",
          onPress: () => {
            setDeleting(true);
            deleteAccount()
              .then(() => {
                // AuthGate will redirect to welcome once session is null.
              })
              .catch((e) => {
                setDeleting(false);
                Alert.alert(
                  "Deletion Failed",
                  (e as Error)?.message ?? "Something went wrong. Please try again.",
                );
              });
          },
        },
      ],
    );
  }, [deleteAccount]);

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={8}
          >
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.headerTitle}>Settings</UiText>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Account section */}
          <UiText style={styles.sectionLabel}>Account</UiText>
          <View style={styles.sectionCard}>
            <Pressable
              onPress={() => router.push("/edit-profile")}
              style={styles.row}
            >
              <User color={theme.textMuted} size={18} strokeWidth={2} />
              <UiText style={styles.rowText}>Edit Profile</UiText>
              <ChevronLeft
                color={theme.textDim}
                size={18}
                strokeWidth={2}
                style={{ transform: [{ rotate: "180deg" }] }}
              />
            </Pressable>
          </View>

          {/* Safety section */}
          <UiText style={styles.sectionLabel}>Safety</UiText>
          <View style={styles.sectionCard}>
            <Pressable
              onPress={() => router.push("/settings/blocked-accounts")}
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ban color={theme.textMuted} size={18} strokeWidth={2} />
              <UiText style={styles.rowText}>Blocked Accounts</UiText>
              <ChevronLeft
                color={theme.textDim}
                size={18}
                strokeWidth={2}
                style={{ transform: [{ rotate: "180deg" }] }}
              />
            </Pressable>
          </View>

          {/* Legal section */}
          <UiText style={styles.sectionLabel}>Legal</UiText>
          <View style={styles.sectionCard}>
            <Pressable
              onPress={() =>
                Linking.openURL(
                  "https://brendanmccormack2025-sketch.github.io/DropDay-Legal/privacy.html",
                )
              }
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Shield color={theme.textMuted} size={18} strokeWidth={2} />
              <UiText style={styles.rowText}>Privacy Policy</UiText>
              <ChevronLeft
                color={theme.textDim}
                size={18}
                strokeWidth={2}
                style={{ transform: [{ rotate: "180deg" }] }}
              />
            </Pressable>
            <View style={styles.rowDivider} />
            <Pressable
              onPress={() =>
                Linking.openURL(
                  "https://brendanmccormack2025-sketch.github.io/DropDay-Legal/terms.html",
                )
              }
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.6 },
              ]}
            >
              <FileText color={theme.textMuted} size={18} strokeWidth={2} />
              <UiText style={styles.rowText}>Terms of Use</UiText>
              <ChevronLeft
                color={theme.textDim}
                size={18}
                strokeWidth={2}
                style={{ transform: [{ rotate: "180deg" }] }}
              />
            </Pressable>
          </View>

          {/* Session section */}
          <UiText style={styles.sectionLabel}>Session</UiText>
          <View style={styles.sectionCard}>
            <Pressable onPress={handleSignOut} style={styles.row}>
              <LogOut color={theme.textMuted} size={18} strokeWidth={2} />
              <UiText style={styles.rowText}>Sign Out</UiText>
            </Pressable>
          </View>

          {/* Danger zone */}
          <View style={styles.dangerDivider} />
          <View style={styles.dangerCard}>
            <Pressable
              onPress={handleDeleteAccount}
              disabled={deleting}
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.6 },
              ]}
            >
              {deleting ? (
                <ActivityIndicator size="small" color={theme.danger} />
              ) : (
                <Trash2 color={theme.danger} size={18} strokeWidth={2} />
              )}
              <UiText style={styles.dangerText}>
                {deleting ? "Deleting account…" : "Delete Account"}
              </UiText>
            </Pressable>
          </View>

          <UiText style={styles.footerText}>
            Deleting your account permanently removes all your posts,
            reactions, and profile data. This action cannot be undone.
          </UiText>
        </ScrollView>
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
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "900" as const,
    letterSpacing: -0.3,
  },
  headerSpacer: { width: 40 },

  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 60,
  },

  sectionLabel: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "900" as const,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 20,
    marginLeft: 4,
  },

  sectionCard: {
    backgroundColor: theme.card,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.07)",
    overflow: "hidden",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  rowText: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    fontWeight: "600" as const,
  },

  dangerDivider: {
    height: 1,
    backgroundColor: "rgba(232,41,28,0.15)",
    marginVertical: 28,
  },

  dangerCard: {
    backgroundColor: "rgba(232,41,28,0.06)",
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(232,41,28,0.15)",
    overflow: "hidden",
  },
  dangerText: {
    flex: 1,
    color: theme.danger,
    fontSize: 15,
    fontWeight: "700" as const,
  },

  rowDivider: {
    height: 1,
    backgroundColor: "rgba(10,10,10,0.05)",
    marginLeft: 46,
  },

  footerText: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    marginLeft: 4,
  },
});
