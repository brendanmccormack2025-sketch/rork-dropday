import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CircleHelp, Plus } from "lucide-react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import CampaignCard from "@/components/money/CampaignCard";
import { theme } from "@/constants/theme";
import { useAuth } from "@/providers/AuthProvider";
import { useMoney } from "@/hooks/useMoney";
import { browseCampaigns, myCampaigns, myJoinedCampaigns, type CampaignWithCreator } from "@/lib/moneyApi";
import { dollars, deadlineLabel, sortCampaigns, type SortKey } from "@/lib/moneyCampaign";

type Tab = "browse" | "campaigns" | "clips";
const SORTS: Array<[SortKey, string]> = [["newest", "Newest"], ["rate", "Highest rate"], ["rating", "Best rated"]];

/**
 * The Money tab. It is only in the tab bar when the database says Money is on for this person (see (tabs)/_layout.tsx); this screen
 * still checks, so nothing shows before the walkthrough and agreement are done.
 */
export default function MoneyTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { features, profile, loaded, refresh } = useMoney();
  const [tab, setTab] = useState<Tab>("browse");
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  if (!loaded) return <Center><ActivityIndicator color={theme.accent} /></Center>;
  if (!features.money) return <Center><UiText style={styles.muted}>Money isn't available for this account.</UiText></Center>;
  if (features.needs_birthdate) {
    return (
      <Center>
        <UiText style={styles.h1}>Confirm you're 18 or older</UiText>
        <UiText style={styles.muted}>Money is for people 18 and over. We ask once.</UiText>
        <PrimaryButton label="Continue" onPress={() => router.push("/onboarding-birthdate" as never)} />
      </Center>
    );
  }
  if (!profile) return <Center><ActivityIndicator color={theme.accent} /></Center>;
  if (!profile.ready) {
    return (
      <Center>
        <UiText style={styles.h1}>Money</UiText>
        <UiText style={styles.muted}>Creators hire clippers. Clippers get paid for views. Tryal keeps everyone honest. Payments happen outside the app.</UiText>
        <PrimaryButton label={profile.role ? "Read the rules again" : "Get started"} onPress={() => router.push("/money/onboarding" as never)} />
      </Center>
    );
  }

  const role = profile.role ?? "clipper";
  const canCreate = role === "creator" || role === "both";
  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <View style={styles.header}>
          <UiText style={styles.h1}>Money</UiText>
          <View style={styles.headerRight}>
            <Pressable onPress={() => router.push({ pathname: "/money/walkthrough", params: { role, review: "1" } } as never)} hitSlop={10} accessibilityLabel="How it works"><CircleHelp color={theme.text} size={22} /></Pressable>
            {canCreate ? <Pressable onPress={() => router.push("/money/create-campaign" as never)} hitSlop={10} accessibilityLabel="Post a campaign"><Plus color={theme.accent} size={26} /></Pressable> : null}
          </View>
        </View>
        <View style={styles.tabs}>
          {([["browse", "Browse"], ["campaigns", "My Campaigns"], ["clips", "My Clips"]] as Array<[Tab, string]>).map(([k, label]) => (
            <Pressable key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
              <UiText style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</UiText>
            </Pressable>
          ))}
        </View>
        {tab === "browse" ? <Browse myId={user?.id ?? ""} canCreate={canCreate} /> : tab === "campaigns" ? <MyCampaigns myId={user?.id ?? ""} canCreate={canCreate} /> : <MyClips myId={user?.id ?? ""} />}
      </SafeAreaView>
    </View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={[styles.root, styles.center]}>{children}</View>;
}

function Empty({ title, body, action }: { title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.empty}>
      <UiText style={styles.emptyTitle}>{title}</UiText>
      {body ? <UiText style={styles.muted}>{body}</UiText> : null}
      {action ? <PrimaryButton label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

function Browse({ myId, canCreate }: { myId: string; canCreate: boolean }) {
  const router = useRouter();
  const [sort, setSort] = useState<SortKey>("newest");
  const q = useQuery({ queryKey: ["money", "browse", myId], enabled: !!myId, queryFn: () => browseCampaigns(myId) });
  const items = sortCampaigns(q.data ?? [], sort);
  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.row.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={theme.accent} />}
      ListHeaderComponent={
        <View style={styles.sorts}>
          {SORTS.map(([k, label]) => (
            <Pressable key={k} onPress={() => setSort(k)} style={[styles.chip, sort === k && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: sort === k }}>
              <UiText style={[styles.chipText, sort === k && styles.chipTextOn]}>{label}</UiText>
            </Pressable>
          ))}
        </View>
      }
      ListEmptyComponent={q.isLoading ? <ActivityIndicator color={theme.accent} /> : q.isError ? <Empty title="Couldn't load campaigns" body="Pull down to try again." /> : (
        <Empty title="No campaigns yet — be the first creator" action={canCreate ? { label: "Post a campaign", onPress: () => router.push("/money/create-campaign" as never) } : undefined} body={canCreate ? undefined : "Switch to Creator or Both from the ? button to post one."} />
      )}
      renderItem={({ item }: { item: CampaignWithCreator }) => <CampaignCard item={item} onPress={() => router.push(`/money/campaign/${item.row.id}` as never)} />}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
    />
  );
}

function MyCampaigns({ myId, canCreate }: { myId: string; canCreate: boolean }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["money", "mine", myId], enabled: !!myId, queryFn: () => myCampaigns(myId) });
  if (!canCreate) return <Empty title="You're set up as a clipper" body="Switch to Creator or Both to post campaigns." action={{ label: "Change role", onPress: () => router.push("/money/onboarding" as never) }} />;
  return (
    <FlatList
      data={q.data ?? []}
      keyExtractor={(c) => c.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={theme.accent} />}
      ListEmptyComponent={q.isLoading ? <ActivityIndicator color={theme.accent} /> : <Empty title="No campaigns yet — be the first creator" action={{ label: "Post a campaign", onPress: () => router.push("/money/create-campaign" as never) }} />}
      renderItem={({ item: c }) => (
        <Pressable onPress={() => router.push(`/money/campaign/${c.id}` as never)} style={styles.row} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <UiText style={styles.rowTitle}>{c.title}</UiText>
            <UiText style={styles.muted}>{dollars(Number(c.budget_left))} left of {dollars(Number(c.total_budget))} · {deadlineLabel(c.deadline)}</UiText>
          </View>
          <UiText style={[styles.status, c.status !== "open" && { color: theme.textMuted }]}>{c.status}</UiText>
        </Pressable>
      )}
      ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
    />
  );
}

function MyClips({ myId }: { myId: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["money", "joined", myId], enabled: !!myId, queryFn: () => myJoinedCampaigns(myId) });
  return (
    <FlatList
      data={q.data ?? []}
      keyExtractor={(i) => i.row.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={theme.accent} />}
      ListEmptyComponent={q.isLoading ? <ActivityIndicator color={theme.accent} /> : <Empty title="Join a campaign to start earning" />}
      renderItem={({ item }) => <CampaignCard item={item} onPress={() => router.push(`/money/campaign/${item.row.id}` as never)} />}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 6 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  h1: { color: theme.text, fontSize: 30, fontWeight: "900" as const, letterSpacing: -0.7 },
  muted: { color: theme.textMuted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  tabOn: { backgroundColor: theme.text, borderColor: theme.text },
  tabText: { color: theme.text, fontSize: 14, fontWeight: "700" as const },
  tabTextOn: { color: "#fff" },
  list: { paddingHorizontal: 20, paddingBottom: 120 },
  sorts: { flexDirection: "row", gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.border },
  chipOn: { borderColor: theme.accent, backgroundColor: "rgba(232,41,28,0.08)" },
  chipText: { color: theme.textMuted, fontSize: 13, fontWeight: "700" as const },
  chipTextOn: { color: theme.accent },
  empty: { alignItems: "center", gap: 12, paddingTop: 48, paddingHorizontal: 12 },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: "900" as const, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.card, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14 },
  rowTitle: { color: theme.text, fontSize: 16, fontWeight: "800" as const },
  status: { color: theme.success, fontSize: 13, fontWeight: "800" as const, textTransform: "capitalize" },
});
