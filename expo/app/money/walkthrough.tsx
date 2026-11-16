import React, { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { BadgeCheck, CircleDollarSign, Film, Link2, ListChecks, Lock, MessageCircle, ShieldAlert, Smartphone, Wallet, Workflow, X } from "lucide-react-native";

import UiText from "@/components/UiText";
import PrimaryButton from "@/components/PrimaryButton";
import Check from "@/components/money/Check";
import { theme } from "@/constants/theme";
import { useMoney } from "@/hooks/useMoney";
import { completeOnboarding } from "@/lib/moneyApi";
import { cardLines, cardsFor, requiredRules, RULE_LABELS, type Card, type CardIcon, type MoneyRole } from "@/lib/moneyContent";
import { moneyErrorMessage } from "@/lib/moneyCampaign";

const ICONS: Record<CardIcon, React.ComponentType<{ color?: string; size?: number }>> = {
  workflow: Workflow, link: Link2, dollar: CircleDollarSign, lock: Lock, check: BadgeCheck, wallet: Wallet, film: Film, phone: Smartphone, shield: ShieldAlert, list: ListChecks, chat: MessageCircle,
};
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
type Page = { kind: "card"; card: Card } | { kind: "agreement" };

/**
 * The full-screen swipeable walkthrough for a role (spec 13b): cards with one picture, a title and at most two short lines, then the agreement
 * with one checkbox per rule. The person cannot finish until every box is ticked and they tap Agree (the server checks the rules again).
 * `review=1` (the "?" button) only reads: no agreement to sign, just Done.
 */
export default function MoneyWalkthrough() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ role?: string; review?: string }>();
  const role: MoneyRole = params.role === "creator" || params.role === "clipper" || params.role === "both" ? params.role : "clipper";
  const review = params.review === "1";
  const money = useMoney();
  const pages = useMemo<Page[]>(() => [...cardsFor(role).map((card): Page => ({ kind: "card", card })), { kind: "agreement" }], [role]);
  const rules = useMemo(() => requiredRules(role), [role]);
  const [index, setIndex] = useState(0);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<Page>>(null);
  const allTicked = rules.every((r) => ticked[r]);
  const last = index === pages.length - 1;

  const go = useCallback((i: number) => { list.current?.scrollToIndex({ index: i, animated: true }); setIndex(i); }, []);
  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width));

  const agree = async () => {
    setError(null);
    setBusy(true);
    try {
      await completeOnboarding(role, rules);
      await money.refresh();
      router.replace("/(tabs)/money" as never);
    } catch (e) {
      setError(moneyErrorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const renderPage = ({ item }: { item: Page }) => {
    if (item.kind === "card") {
      const Icon = ICONS[item.card.icon];
      const { lines, notes } = cardLines(item.card);
      return (
        <View style={[styles.page, { width }]}>
          <View style={styles.pic}><Icon color={theme.accent} size={54} /></View>
          <UiText style={styles.cardTitle}>{item.card.title}</UiText>
          {lines.map((l, i) => <UiText key={i} style={styles.line}>{l}</UiText>)}
          {notes.map((n) => <UiText key={n} style={styles.note}>{n}</UiText>)}
        </View>
      );
    }
    return (
      <ScrollView style={{ width }} contentContainerStyle={styles.agreement}>
        <UiText style={styles.cardTitle}>{review ? "The rules" : "Agree to the rules"}</UiText>
        <UiText style={styles.sub}>{review ? "These are the rules you agreed to." : "Tick every box to continue."}</UiText>
        {rules.map((r) => (
          <Check key={r} checked={review ? true : !!ticked[r]} disabled={review} onToggle={() => setTicked((t) => ({ ...t, [r]: !t[r] }))} label={cap(RULE_LABELS[r] ?? r)} />
        ))}
        {error ? <UiText style={styles.error}>{error}</UiText> : null}
      </ScrollView>
    );
  };

  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.top}>
          <UiText style={styles.step}>{index + 1} / {pages.length}</UiText>
          {review ? <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close"><X color={theme.text} size={22} /></Pressable> : <View style={{ width: 22 }} />}
        </View>
        <FlatList
          ref={list}
          data={pages}
          keyExtractor={(p, i) => (p.kind === "card" ? p.card.id : `agreement-${i}`)}
          renderItem={renderPage}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScrollEnd}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          style={{ flex: 1 }}
        />
        <View style={styles.dots}>{pages.map((_, i) => <View key={i} style={[styles.dot, i === index && styles.dotOn]} />)}</View>
        <View style={styles.foot}>
          {index > 0 ? <Pressable onPress={() => go(index - 1)} style={styles.back} accessibilityRole="button"><UiText style={styles.backText}>Back</UiText></Pressable> : <View style={styles.back} />}
          <View style={{ flex: 1 }}>
            {!last ? <PrimaryButton label="Next" onPress={() => go(index + 1)} />
              : review ? <PrimaryButton label="Done" onPress={() => router.back()} />
              : <PrimaryButton label="I agree" onPress={agree} loading={busy} disabled={!allTicked} />}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: 8 },
  step: { color: theme.textMuted, fontSize: 13, fontWeight: "700" as const },
  page: { paddingHorizontal: 28, alignItems: "center", justifyContent: "center", gap: 14 },
  pic: { width: 120, height: 120, borderRadius: 60, backgroundColor: "rgba(232,41,28,0.10)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  cardTitle: { color: theme.text, fontSize: 28, fontWeight: "900" as const, letterSpacing: -0.6, textAlign: "center" },
  line: { color: theme.text, fontSize: 17, lineHeight: 24, textAlign: "center" },
  note: { color: theme.textMuted, fontSize: 13, lineHeight: 18, textAlign: "center", marginTop: 6 },
  sub: { color: theme.textMuted, fontSize: 15, lineHeight: 21 },
  agreement: { paddingHorizontal: 24, paddingTop: 24, gap: 8 },
  error: { color: theme.danger, fontSize: 14, fontWeight: "600" as const, marginTop: 8 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, paddingVertical: 10 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.border },
  dotOn: { backgroundColor: theme.accent, width: 18 },
  foot: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingBottom: 12 },
  back: { width: 64 },
  backText: { color: theme.textMuted, fontSize: 16, fontWeight: "700" as const },
});
