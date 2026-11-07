import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import { adminCreators, adminList, adminOffer, adminPosts, adminWithdraw, thumbUri, type AdminCreator } from "@/lib/spotlight";
import { SPOTLIGHT_CATEGORIES, categoryLabel } from "@/lib/spotlightText";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Admin only (the owner; the database checks spotlight_admins again on every call). Pick a creator, one of their survived posts
 * and a category, and send the offer. The creator then chooses; nothing is shown to anyone before they say yes.
 */
export default function SpotlightAdminScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [creator, setCreator] = useState<AdminCreator | null>(null);
  const [postId, setPostId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(SPOTLIGHT_CATEGORIES[0].key);
  const [busy, setBusy] = useState(false);

  const creators = useQuery({ queryKey: ["spotlight", "admin", "creators", query], queryFn: () => adminCreators(query), enabled: isDebugOwner(user?.id) });
  const posts = useQuery({ queryKey: ["spotlight", "admin", "posts", creator?.id], queryFn: () => adminPosts(creator!.id), enabled: !!creator });
  const picks = useQuery({ queryKey: ["spotlight", "admin", "list"], queryFn: adminList, enabled: isDebugOwner(user?.id) });

  const send = useCallback(async () => {
    if (!creator || !postId) return;
    setBusy(true);
    try {
      await adminOffer(creator.id, postId, category);
      Alert.alert("Offer sent", `@${creator.username} was notified and can answer from the notification.`);
      setCreator(null);
      setPostId(null);
      void qc.invalidateQueries({ queryKey: ["spotlight", "admin"] });
    } catch (e) {
      Alert.alert("Couldn't send the offer", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }, [creator, postId, category, qc]);

  const withdraw = useCallback(
    (id: string) => {
      Alert.alert("Withdraw this pick?", "It disappears everywhere at once.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Withdraw",
          style: "destructive",
          onPress: () => {
            adminWithdraw(id)
              .then(() => qc.invalidateQueries({ queryKey: ["spotlight"] }))
              .catch((e) => Alert.alert("Couldn't withdraw", e instanceof Error ? e.message : undefined));
          },
        },
      ]);
    },
    [qc],
  );

  if (!isDebugOwner(user?.id)) return <Redirect href="/(tabs)" />;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Spotlight (admin)</UiText>
          <View style={styles.back} />
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <UiText style={styles.h}>1. Creator</UiText>
          <TextInput value={query} onChangeText={setQuery} placeholder="Search creators with survived posts" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          {creators.isLoading && <ActivityIndicator color={theme.accent} />}
          {(creators.data ?? []).map((c) => {
            const blocked = c.next_eligible_at && new Date(c.next_eligible_at).getTime() > Date.now();
            return (
              <Pressable key={c.id} onPress={() => { setCreator(c); setPostId(null); }} style={[styles.row, creator?.id === c.id && styles.rowOn]}>
                <UiText style={styles.rowTitle}>@{c.username}</UiText>
                <UiText style={styles.rowSub}>{c.survived_posts} survived{blocked ? ` · can be featured again ${new Date(c.next_eligible_at!).toLocaleDateString()}` : ""}</UiText>
              </Pressable>
            );
          })}

          {creator && (
            <>
              <UiText style={styles.h}>2. Post of @{creator.username}</UiText>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {(posts.data ?? []).map((p) => {
                  const uri = thumbUri(p.thumbnail_url);
                  return (
                    <Pressable key={p.post_id} onPress={() => setPostId(p.post_id)} style={[styles.post, postId === p.post_id && styles.rowOn]}>
                      {uri ? <Image source={{ uri }} style={styles.postThumb} contentFit="cover" /> : <View style={styles.postThumb} />}
                      <UiText style={styles.rowSub}>{p.likes} likes</UiText>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <UiText style={styles.h}>3. Category</UiText>
              <View style={styles.cats}>
                {SPOTLIGHT_CATEGORIES.map((c) => (
                  <Pressable key={c.key} onPress={() => setCategory(c.key)} style={[styles.cat, category === c.key && styles.catOn]}>
                    <UiText style={[styles.catText, category === c.key && styles.catTextOn]}>{c.label}</UiText>
                  </Pressable>
                ))}
              </View>
              <Pressable disabled={!postId || busy} onPress={() => void send()} style={[styles.send, (!postId || busy) && { opacity: 0.4 }]} accessibilityRole="button">
                <UiText style={styles.sendText}>{busy ? "Sending…" : "Send the offer"}</UiText>
              </Pressable>
            </>
          )}

          <UiText style={styles.h}>Picks</UiText>
          {(picks.data ?? []).map((p) => (
            <View key={p.id} style={styles.row}>
              <UiText style={styles.rowTitle}>@{p.username ?? "?"} · {categoryLabel(p.category)}</UiText>
              <UiText style={styles.rowSub}>{p.status}{p.ends_at ? ` · until ${new Date(p.ends_at).toLocaleString()}` : ""}</UiText>
              {["offered", "full", "strangers"].includes(p.status) && (
                <Pressable onPress={() => withdraw(p.id)} hitSlop={8}>
                  <UiText style={styles.withdraw}>Withdraw</UiText>
                </Pressable>
              )}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  safe: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, height: 48 },
  back: { width: 36, alignItems: "center" },
  title: { color: theme.text, fontSize: 17, fontWeight: "700" as const },
  body: { padding: 16, gap: 10, paddingBottom: 60 },
  h: { color: theme.text, fontSize: 15, fontWeight: "800" as const, marginTop: 10 },
  input: { backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 10, color: theme.text },
  row: { backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 10, gap: 2 },
  rowOn: { borderColor: theme.accent, borderWidth: 2 },
  rowTitle: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  rowSub: { color: theme.textMuted, fontSize: 12 },
  post: { width: 90, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 4, alignItems: "center" },
  postThumb: { width: 80, height: 110, borderRadius: 8, backgroundColor: theme.border },
  cats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cat: { borderRadius: 999, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.card },
  catOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  catText: { color: theme.text, fontSize: 13, fontWeight: "600" as const },
  catTextOn: { color: "#fff" },
  send: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 6 },
  sendText: { color: "#fff", fontSize: 15, fontWeight: "800" as const },
  withdraw: { color: theme.danger, fontSize: 13, fontWeight: "700" as const, marginTop: 4 },
});
