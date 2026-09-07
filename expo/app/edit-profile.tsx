import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import UiText from "@/components/UiText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { EncodingType, readAsStringAsync } from "@/lib/fileSystemCompat";
import { decode } from "base64-arraybuffer";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  Check,
  Globe,
  Instagram,
  Music2,
  X,
} from "lucide-react-native";

import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { usePosts, type MyProfile } from "@/providers/PostsProvider";
import { supabase } from "@/lib/supabase";

const BIO_MAX_LENGTH = 150;
const BUCKET = "drops";

/**
 * Read a local file URI into a Uint8Array for Supabase upload.
 * Uses expo-file-system base64 reading + base64-arraybuffer decode
 * because React Native does not support Blob/ArrayBuffer uploads with Supabase.
 */
async function uriToBlob(uri: string): Promise<Uint8Array> {
  const base64 = await readAsStringAsync(uri, {
    encoding: EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) {
    throw new Error(`File read returned empty data from ${uri.slice(0, 60)}`);
  }
  const fileData = new Uint8Array(decode(base64));
  return fileData;
}

export default function EditProfileScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { myProfile, updateProfile, refetchProfile } = usePosts();
  const insets = useSafeAreaInsets();

  const [displayName, setDisplayName] = useState(
    myProfile?.display_name ?? "",
  );
  const [username, setUsername] = useState(myProfile?.username ?? "");
  const [bio, setBio] = useState(myProfile?.bio ?? "");
  const [website, setWebsite] = useState(myProfile?.website ?? "");
  const [instagram, setInstagram] = useState(
    myProfile?.instagram_handle ?? "",
  );
  const [tiktok, setTiktok] = useState(myProfile?.tiktok_handle ?? "");
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => {
    if (avatarUri !== null) return true;
    if (displayName !== (myProfile?.display_name ?? "")) return true;
    if (username !== (myProfile?.username ?? "")) return true;
    if (bio !== (myProfile?.bio ?? "")) return true;
    if (website !== (myProfile?.website ?? "")) return true;
    if (instagram !== (myProfile?.instagram_handle ?? "")) return true;
    if (tiktok !== (myProfile?.tiktok_handle ?? "")) return true;
    return false;
  }, [myProfile, displayName, username, bio, website, instagram, tiktok, avatarUri]);

  const pickAvatar = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photo Access",
        "Grant photo library access in Settings to change your profile photo.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Open Settings",
            onPress: () => {
              if (Platform.OS === "ios") {
                Linking.openURL("app-settings:");
              }
            },
          },
        ],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (!result.canceled && result.assets.length > 0) {
      setAvatarUri(result.assets[0]!.uri);
    }
  }, []);

  const avatarSource = useMemo(() => {
    if (avatarUri) return { uri: avatarUri };
    if (myProfile?.avatar_url) return { uri: myProfile.avatar_url };
    return null;
  }, [avatarUri, myProfile?.avatar_url]);

  const avatarInitial = useMemo(() => {
    const name = displayName || myProfile?.display_name || username || "?";
    return name.charAt(0).toUpperCase();
  }, [displayName, myProfile?.display_name, username]);

  const handleSave = useCallback(async () => {
    if (!username.trim()) {
      Alert.alert("Username required", "Please enter a username.");
      return;
    }
    setSaving(true);
    try {
      let finalAvatarUrl = myProfile?.avatar_url ?? null;

      if (avatarUri && user?.id) {
        const ext = avatarUri.endsWith(".png") ? "png" : "jpg";
        const path = `${user.id}/avatar_${Date.now()}.${ext}`;
        const fileData = await uriToBlob(avatarUri);
        const { data: upData, error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, fileData, {
            contentType: ext === "png" ? "image/png" : "image/jpeg",
            upsert: true,
          });
        if (upErr) {
          console.error(`[saveProfile] upload FAIL`, upErr);
          Alert.alert("Upload Failed", upErr.message);
          setSaving(false);
          return;
        }
        const { data: pub } = supabase.storage
          .from(BUCKET)
          .getPublicUrl(path);
        finalAvatarUrl = pub.publicUrl;
      }

      await updateProfile.mutateAsync({
        username: username.trim(),
        display_name: displayName.trim() || null,
        avatar_url: finalAvatarUrl,
        bio: bio.trim() || null,
        website: website.trim() || null,
        instagram_handle: instagram.trim() || null,
        tiktok_handle: tiktok.trim() || null,
      });

      // Force a fresh refetch so the profile screen has the latest data
      // when we navigate back. Invalidation alone may not complete in time.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["profile", user?.id] }),
        qc.invalidateQueries({ queryKey: ["posts"] }),
        refetchProfile(),
      ]);

      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/(tabs)");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save profile.";
      Alert.alert("Error", message);
    } finally {
      setSaving(false);
    }
  }, [
    username,
    displayName,
    bio,
    website,
    instagram,
    tiktok,
    avatarUri,
    myProfile,
    user,
    updateProfile,
    refetchProfile,
    qc,
    router,
  ]);

  return (
    <View style={styles.root}>
      <View style={[styles.safe, { paddingTop: insets.top }]}>
        {/* Top bar */}
        <View style={[styles.topBar, { marginTop: 8 }]}>
          <Pressable
            onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }}
            style={styles.topBtn}
            hitSlop={8}
          >
            <X color={theme.textMuted} size={22} strokeWidth={2} />
          </Pressable>
          <UiText style={styles.topTitle}>Edit Profile</UiText>
          <Pressable
            onPress={handleSave}
            style={[
              styles.topBtn,
              styles.saveBtn,
              (!dirty || saving) && styles.saveBtnDisabled,
            ]}
            hitSlop={8}
            disabled={!dirty || saving}
          >
            {saving ? (
              <UiText style={styles.saveBtnText}>…</UiText>
            ) : (
              <Check
                color={dirty ? theme.accent : theme.textDim}
                size={20}
                strokeWidth={2.5}
              />
            )}
          </Pressable>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Avatar */}
            <Pressable onPress={pickAvatar} style={styles.avatarWrap}>
              <View style={styles.avatar}>
                {avatarSource ? (
                  <Image
                    source={avatarSource}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={100}
                  />
                ) : (
                  <UiText style={styles.avatarText}>{avatarInitial}</UiText>
                )}
                <View style={styles.avatarOverlay}>
                  <Camera color="#fff" size={16} strokeWidth={2} />
                </View>
              </View>
              <UiText style={styles.avatarHint}>Change photo</UiText>
            </Pressable>

            {/* Display Name */}
            <View style={styles.field}>
              <UiText style={styles.label}>Display Name</UiText>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Your name"
                placeholderTextColor={theme.textDim}
                maxLength={50}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>

            {/* Username */}
            <View style={styles.field}>
              <UiText style={styles.label}>Username</UiText>
              <View style={styles.inputRow}>
                <UiText style={styles.atPrefix}>@</UiText>
                <TextInput
                  style={[styles.input, styles.inputInline]}
                  value={username}
                  onChangeText={(t) =>
                    setUsername(
                      t
                        .toLowerCase()
                        .replace(/[^a-z0-9._]/g, "")
                        .slice(0, 30),
                    )
                  }
                  placeholder="username"
                  placeholderTextColor={theme.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />
              </View>
            </View>

            {/* Bio */}
            <View style={styles.field}>
              <UiText style={styles.label}>Bio</UiText>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={bio}
                onChangeText={(t) => setBio(t.slice(0, BIO_MAX_LENGTH))}
                placeholder="Write a short bio…"
                placeholderTextColor={theme.textDim}
                maxLength={BIO_MAX_LENGTH}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                returnKeyType="next"
              />
              <UiText style={styles.charCount}>
                {bio.length}/{BIO_MAX_LENGTH}
              </UiText>
            </View>

            {/* Website */}
            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Globe color={theme.textMuted} size={14} strokeWidth={2} />
                <UiText style={styles.label}>Website / Link</UiText>
              </View>
              <TextInput
                style={styles.input}
                value={website}
                onChangeText={setWebsite}
                placeholder="your-link.com"
                placeholderTextColor={theme.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="next"
              />
            </View>

            {/* Instagram */}
            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Instagram
                  color={theme.textMuted}
                  size={14}
                  strokeWidth={2}
                />
                <UiText style={styles.label}>Instagram (optional)</UiText>
              </View>
              <TextInput
                style={styles.input}
                value={instagram}
                onChangeText={(t) =>
                  setInstagram(
                    t
                      .replace(/^@/, "")
                      .replace(/[^a-zA-Z0-9._]/g, "")
                      .slice(0, 30),
                  )
                }
                placeholder="username"
                placeholderTextColor={theme.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            {/* TikTok */}
            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Music2 color={theme.textMuted} size={14} strokeWidth={2} />
                <UiText style={styles.label}>TikTok (optional)</UiText>
              </View>
              <TextInput
                style={styles.input}
                value={tiktok}
                onChangeText={(t) =>
                  setTiktok(
                    t
                      .replace(/^@/, "")
                      .replace(/[^a-zA-Z0-9._]/g, "")
                      .slice(0, 30),
                  )
                }
                placeholder="username"
                placeholderTextColor={theme.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
              />
            </View>

            {/* Bottom spacer */}
            <View style={styles.bottomSpacer} />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  flex: { flex: 1 },

  /* Top bar */
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  topBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  topTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "700" as const,
  },
  saveBtn: {},
  saveBtnDisabled: {
    opacity: 0.3,
  },
  saveBtnText: {
    color: theme.accent,
    fontSize: 15,
    fontWeight: "700" as const,
  },

  /* Scroll */
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
  },

  /* Avatar */
  avatarWrap: {
    alignItems: "center",
    marginBottom: 28,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: theme.primaryDeep,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.2)",
  },
  avatarText: {
    color: "#fff",
    fontSize: 36,
    fontWeight: "800" as const,
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 48,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarHint: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: "600" as const,
    marginTop: 8,
  },

  /* Fields */
  field: {
    marginBottom: 20,
  },
  label: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: "700" as const,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 16,
    fontWeight: "500" as const,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  inputMultiline: {
    minHeight: 80,
    paddingTop: 12,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  atPrefix: {
    color: theme.textMuted,
    fontSize: 16,
    fontWeight: "600" as const,
    marginRight: 4,
  },
  inputInline: {
    flex: 1,
  },
  charCount: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: "600" as const,
    textAlign: "right",
    marginTop: 4,
  },

  /* Bottom spacer */
  bottomSpacer: {
    height: 60,
  },
});
