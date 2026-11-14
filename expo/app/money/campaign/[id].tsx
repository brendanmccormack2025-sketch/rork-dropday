import React, { useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SettingsScaffold, settingsStyles as s } from "@/components/SettingsScaffold";
import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import Check from "@/components/money/Check";
import CoachMark from "@/components/money/CoachMark";
import { FeedAvatar } from "@/components/Avatar";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { useUserBlocks } from "@/hooks/useUserBlocks";
import { campaignDetail, campaignPaymentInfo, joinCampaign, reportMoney, setCampaignStatus } from "@/lib/moneyApi";
import { CLIPPER_AGREEMENT, MESSAGING_NOTICE } from "@/lib/moneyContent";
import { PAYMENT_LABELS, PLATFORM_LABELS, cardModel, dollars, moneyErrorMessage, profileBadge, type PaymentMethod } from "@/lib/moneyCampaign";
import { useMoney } from "@/hooks/useMoney";

/** One campaign: the terms, the creator's record, Join ("I'm in"), Report and Block. The payment handle is plain text, never a link. */
export default function CampaignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { profile } = useMoney();
  const { blockUser } = useUserBlocks();
  const [agreeOpen, setAgreeOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const me = user?.id ?? "";

  const q = useQuery({ queryKey: ["money", "campaign", id, me], enabled: !!id && !!me, queryFn: () => campaignDetail(String(id), me) });
  const d = q.data;
  const pay = useQuery({ queryKey: ["money", "pay", id], enabled: !!d && (d.joined || d.mine), queryFn: () => campaignPaymentInfo(String(id)) });

  if (q.isLoading) return <SettingsScaffold title="Campaign"><ActivityIndicator color={theme.accent} /></SettingsScaffold>;
  if (!d) return <SettingsScaffold title="Campaign"><UiText style={s.text}>This campaign isn't available.</UiText></SettingsScaffold>;

  const c = d.item.row;
  const m = cardModel(c, d.item.stats);
  const canJoin = !d.mine && !d.joined && c.status === "open" && (profile?.role === "clipper" || profile?.role === "both");
  const refresh = () => qc.invalidateQueries({ queryKey: ["money"] });

  const join = async () => {
    setMsg(null);
    setBusy(true);
    try {
      await joinCampaign(c.id);
      await refresh();
      setAgreeOpen(false);
      setMsg("You're in. We opened a message thread with the creator.");
    } catch (e) {
      setMsg(moneyErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const report = () => {
    const reasons: Array<[string, "spam" | "harassment" | "nudity" | "other"]> = [["Spam or misleading", "spam"], ["Harassment or bullying", "harassment"], ["Nudity or sexual content", "nudity"], ["Other", "other"]];
    Alert.alert("Report this campaign", "Why are you reporting it?", [
      ...reasons.map(([label, reason]) => ({
        text: label,
        onPress: () => { reportMoney(me, "campaign", c.id, reason).then(() => Alert.alert("Thanks", "We'll review it.")).catch(() => Alert.alert("Couldn't send the report", "Try again.")); },
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  const block = () => {
    Alert.alert("Block this creator?", "You won't see their campaigns, and they can't see yours or join them.", [
      { text: "Block", style: "destructive", onPress: () => { blockUser(c.creator_id); router.back(); } },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const close = () => Alert.alert("Close this campaign?", "It stops taking new clips. This can't be undone.", [
    { text: "Close it", style: "destructive", onPress: () => { setCampaignStatus(c.id, "closed").then(refresh).catch((e) => setMsg(moneyErrorMessage((e as Error).message))); } },
    { text: "Cancel", style: "cancel" },
  ]);

  return (
    <SettingsScaffold title="Campaign">
      <View style={styles.creator}>
        <FeedAvatar profile={d.item.creator} name={d.item.creator?.username ?? "?"} size={40} />
        <View style={{ flex: 1 }}>
          <UiText style={styles.name}>{d.item.creator ? `@${d.item.creator.username}` : "Creator"}</UiText>
          <UiText style={s.text}>{profileBadge(d.item.stats)}</UiText>
          <UiText style={s.text}>{m.record}</UiText>
        </View>
      </View>
      <UiText style={s.heading}>{c.title}</UiText>
      <UiText style={styles.body}>{c.description}</UiText>
      <View style={styles.terms}>
        <Row k="Pay" v={`${m.rate}, ${m.cap}`} />
        {m.guarantee ? <Row k="Guaranteed" v={m.guarantee} /> : null}
        <Row k="Views needed" v={`${c.min_views.toLocaleString("en-US")} before the per-view rate applies`} />
        <Row k="Budget" v={m.budgetLeft} />
        <Row k="Post on" v={m.platforms} />
        <Row k="View window" v={`${c.view_window_days} days`} />
        <Row k="Clips each" v={`up to ${c.max_clips_per_clipper}`} />
        <Row k="Deadline" v={m.deadline} />
        <Row k="Payment" v={m.payVia} />
      </View>
      {c.terms_frozen_at ? <UiText style={s.text}>Terms are frozen: the first clipper has joined.</UiText> : <UiText style={s.text}>Terms freeze when the first clipper joins.</UiText>}

      {(d.joined || d.mine) ? (
        <View style={styles.terms}>
          <UiText style={styles.name}>How you get paid</UiText>
          {/* plain text on purpose: a handle is never a link or a button (no payments in the app) */}
          <UiText style={s.text}>{pay.data ? `${PAYMENT_LABELS[pay.data.payment_method as PaymentMethod] ?? pay.data.payment_method}: ${pay.data.payment_handle}` : "…"}</UiText>
          <UiText style={s.text}>The creator pays you directly, outside the app.</UiText>
          <Pressable onPress={() => Linking.openURL(c.footage_url).catch(() => {})} accessibilityRole="link"><UiText style={styles.link}>Open the footage</UiText></Pressable>
        </View>
      ) : null}

      {msg ? <UiText style={styles.msg}>{msg}</UiText> : null}

      {d.joined ? <PrimaryButton label="Message the creator" onPress={() => router.push(`/messages/${c.creator_id}` as never)} /> : null}

      {canJoin && !agreeOpen ? <PrimaryButton label="I'm in" onPress={() => setAgreeOpen(true)} /> : null}
      {canJoin && agreeOpen ? (
        <View style={styles.terms}>
          <CoachMark id="join" />
          <UiText style={styles.name}>Clipper Agreement</UiText>
          <UiText style={s.text}>You're joining on these terms. They can't change once someone has joined.</UiText>
          {CLIPPER_AGREEMENT.map((line) => <UiText key={line} style={s.text}>• {line === MESSAGING_NOTICE ? line : line.charAt(0).toUpperCase() + line.slice(1) + "."}</UiText>)}
          <Check checked={agreed} onToggle={() => setAgreed(!agreed)} label="I accept the Clipper Agreement" />
          <PrimaryButton label="Join" onPress={join} loading={busy} disabled={!agreed} />
        </View>
      ) : null}

      {d.mine && c.status === "open" ? <PrimaryButton label="Close campaign" variant="outline" onPress={close} /> : null}
      {!d.mine ? (
        <View style={styles.safety}>
          <Pressable onPress={report} accessibilityRole="button"><UiText style={styles.safetyText}>Report</UiText></Pressable>
          <Pressable onPress={block} accessibilityRole="button"><UiText style={styles.safetyText}>Block creator</UiText></Pressable>
        </View>
      ) : null}
    </SettingsScaffold>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <UiText style={styles.k}>{k}</UiText>
      <UiText style={styles.v}>{v}</UiText>
    </View>
  );
}

const styles = StyleSheet.create({
  creator: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { color: theme.text, fontSize: 16, fontWeight: "800" as const },
  body: { color: theme.text, fontSize: 16, lineHeight: 23 },
  terms: { backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  k: { color: theme.textMuted, fontSize: 14 },
  v: { color: theme.text, fontSize: 14, fontWeight: "700" as const, flex: 1, textAlign: "right" },
  link: { color: theme.accent, fontSize: 15, fontWeight: "700" as const },
  msg: { color: theme.text, fontSize: 14, fontWeight: "600" as const },
  safety: { flexDirection: "row", justifyContent: "center", gap: 28, paddingVertical: 8 },
  safetyText: { color: theme.textMuted, fontSize: 14, fontWeight: "700" as const },
});
