import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { isDebugOwner } from "@/constants/debug";
import { adminAddTerm, adminFlags, adminRemoveTerm, adminReports, adminResolveFlag, adminResolveReport, adminTerms, type ReportAction } from "@/lib/safety";
import { adminRecovery } from "@/lib/recovery";
import { useAuth } from "@/providers/AuthProvider";

type Tab = "reports" | "flags" | "recovery" | "words";

/**
 * Owner only (the database checks the admin list again on every call). Reports (posts, reactions, messages), flags from the
 * unwanted-contact checks, and the word list. Existing report and block paths are unchanged: this is where they are reviewed.
 */
export default function ModerationAdminScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const qc = useQueryClient();
  const owner = isDebugOwner(user?.id);
  const [tab, setTab] = useState<Tab>("reports");
  const [term, setTerm] = useState("");

  const reports = useQuery({ queryKey: ["mod", "reports"], queryFn: () => adminReports("pending"), enabled: owner });
  const flags = useQuery({ queryKey: ["mod", "flags"], queryFn: () => adminFlags("open"), enabled: owner });
  const recovery = useQuery({ queryKey: ["mod", "recovery"], queryFn: adminRecovery, enabled: owner });
  const terms = useQuery({ queryKey: ["mod", "terms"], queryFn: adminTerms, enabled: owner });

  const fail = (e: unknown) => Alert.alert("Couldn't do that", e instanceof Error ? e.message : undefined);
  const resolve = useCallback((id: string, action: ReportAction) => {
    adminResolveReport(id, action).then(() => qc.invalidateQueries({ queryKey: ["mod", "reports"] })).catch(fail);
  }, [qc]);
  const resolveFlag = useCallback((id: string, status: "reviewed" | "dismissed") => {
    adminResolveFlag(id, status).then(() => qc.invalidateQueries({ queryKey: ["mod", "flags"] })).catch(fail);
  }, [qc]);
  const addTerm = useCallback(() => {
    const t = term.trim();
    if (!t) return;
    adminAddTerm(t).then(() => { setTerm(""); return qc.invalidateQueries({ queryKey: ["mod", "terms"] }); }).catch(fail);
  }, [term, qc]);
  const removeTerm = useCallback((t: string) => {
    Alert.alert("Remove this term?", t, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => adminRemoveTerm(t).then(() => qc.invalidateQueries({ queryKey: ["mod", "terms"] })).catch(fail) },
    ]);
  }, [qc]);

  if (!owner) return <Redirect href="/(tabs)" />;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8}>
            <ChevronLeft color={theme.text} size={22} strokeWidth={2.5} />
          </Pressable>
          <UiText style={styles.title}>Moderation (admin)</UiText>
          <View style={styles.back} />
        </View>
        <View style={styles.tabs}>
          {([["reports", `Reports${reports.data ? ` (${reports.data.length})` : ""}`], ["flags", `Flags${flags.data ? ` (${flags.data.length})` : ""}`], ["recovery", "Recovery"], ["words", "Word list"]] as Array<[Tab, string]>).map(([k, label]) => (
            <Pressable key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]}>
              <UiText style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</UiText>
            </Pressable>
          ))}
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {tab === "reports" && (reports.isLoading ? <ActivityIndicator color={theme.accent} /> : (reports.data ?? []).length === 0 ? <UiText style={styles.muted}>No pending reports.</UiText> : (reports.data ?? []).map((r) => (
            <View key={r.report_id} style={styles.card}>
              <UiText style={styles.cardTitle}>{r.target_type} · {r.reason} · {r.report_count} report{r.report_count === 1 ? "" : "s"}</UiText>
              <UiText style={styles.muted}>@{r.reported_username ?? "?"} reported by @{r.reporter_username ?? "?"}</UiText>
              {r.preview ? <UiText style={styles.preview} numberOfLines={4}>{r.preview}</UiText> : null}
              <View style={styles.actions}>
                {(["dismiss", "reviewed", "hide", "remove"] as ReportAction[]).map((a) => (
                  <Pressable key={a} onPress={() => resolve(r.report_id, a)} style={[styles.action, (a === "hide" || a === "remove") && styles.actionDanger]}>
                    <UiText style={[styles.actionText, (a === "hide" || a === "remove") && styles.actionTextDanger]}>{a === "reviewed" ? "Mark reviewed" : a[0]!.toUpperCase() + a.slice(1)}</UiText>
                  </Pressable>
                ))}
              </View>
            </View>
          )))}
          {tab === "flags" && (flags.isLoading ? <ActivityIndicator color={theme.accent} /> : (flags.data ?? []).length === 0 ? <UiText style={styles.muted}>No open flags.</UiText> : (flags.data ?? []).map((f) => (
            <View key={f.id} style={styles.card}>
              <UiText style={styles.cardTitle}>{f.kind.replace(/_/g, " ")}</UiText>
              <UiText style={styles.muted}>@{f.username ?? "?"}{f.target_username ? ` → @${f.target_username}` : ""} · {new Date(f.created_at).toLocaleString()}</UiText>
              <UiText style={styles.preview}>{JSON.stringify(f.detail)}</UiText>
              <View style={styles.actions}>
                <Pressable onPress={() => resolveFlag(f.id, "dismissed")} style={styles.action}><UiText style={styles.actionText}>Dismiss</UiText></Pressable>
                <Pressable onPress={() => resolveFlag(f.id, "reviewed")} style={styles.action}><UiText style={styles.actionText}>Mark reviewed</UiText></Pressable>
              </View>
            </View>
          )))}
          {tab === "recovery" && (recovery.isLoading ? <ActivityIndicator color={theme.accent} /> : (recovery.data ?? []).length === 0 ? <UiText style={styles.muted}>No Recovery Boost offers yet.</UiText> : (recovery.data ?? []).map((o) => (
            <View key={o.id} style={styles.card}>
              <UiText style={styles.cardTitle}>@{o.creator_username ?? "?"} · {o.status} · {o.source}</UiText>
              <UiText style={styles.muted}>offered {new Date(o.created_at).toLocaleDateString()}{o.boost_post_id ? ` · boosted to ${o.boosted_viewers} people until ${o.boost_ends_at ? new Date(o.boost_ends_at).toLocaleString() : "?"}` : ""}</UiText>
            </View>
          )))}
          {tab === "words" && (
            <>
              <View style={styles.addRow}>
                <TextInput value={term} onChangeText={setTerm} placeholder="Add a word or phrase" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} style={styles.input} onSubmitEditing={addTerm} />
                <Pressable onPress={addTerm} style={styles.addBtn}><UiText style={styles.addText}>Add</UiText></Pressable>
              </View>
              <UiText style={styles.muted}>Case, punctuation and look-alike characters are ignored; whole words and phrases only. Applies to messages and captions.</UiText>
              {(terms.data ?? []).map((t) => (
                <Pressable key={t} onPress={() => removeTerm(t)} style={styles.term}>
                  <UiText style={styles.cardTitle}>{t}</UiText>
                  <UiText style={styles.actionTextDanger}>Remove</UiText>
                </Pressable>
              ))}
            </>
          )}
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
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  tabOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  tabText: { color: theme.text, fontSize: 13, fontWeight: "600" as const },
  tabTextOn: { color: "#fff" },
  body: { padding: 16, gap: 10, paddingBottom: 60 },
  muted: { color: theme.textMuted, fontSize: 13 },
  card: { backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 6 },
  cardTitle: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  preview: { color: theme.text, fontSize: 13, backgroundColor: theme.bg, borderRadius: 8, padding: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  action: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: theme.border },
  actionDanger: { borderColor: theme.danger },
  actionText: { color: theme.text, fontSize: 13, fontWeight: "600" as const },
  actionTextDanger: { color: theme.danger, fontSize: 13, fontWeight: "700" as const },
  addRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 10, color: theme.text },
  addBtn: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
  addText: { color: "#fff", fontWeight: "800" as const },
  term: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border, padding: 12 },
});
