import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft } from "lucide-react-native";

import ScreenBackground from "@/components/ScreenBackground";
import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import {
  TERMS_OF_USE,
  PRIVACY_POLICY,
  type LegalDocument,
} from "@/constants/legal";

type LegalTab = "terms" | "privacy";

const DOCUMENTS: Record<LegalTab, LegalDocument> = {
  terms: TERMS_OF_USE,
  privacy: PRIVACY_POLICY,
};

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function LegalScreen() {
  const params = useLocalSearchParams<{ tab?: LegalTab }>();
  const [tab, setTab] = useState<LegalTab>(
    params.tab === "privacy" ? "privacy" : "terms",
  );
  const doc = DOCUMENTS[tab];

  return (
    <ScreenBackground>
      <SafeAreaView style={styles.safe}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace("/(auth)/sign-up");
            }}
            style={styles.back}
            hitSlop={12}
          >
            <ArrowLeft color={theme.text} size={22} />
          </Pressable>
          <View style={styles.tabSwitcher}>
            <Pressable
              onPress={() => setTab("terms")}
              style={({ pressed }) => [
                styles.tab,
                tab === "terms" && styles.tabActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <UiText
                style={tab === "terms" ? styles.tabTextActive : styles.tabText}
              >
                Terms of Use
              </UiText>
            </Pressable>
            <Pressable
              onPress={() => setTab("privacy")}
              style={({ pressed }) => [
                styles.tab,
                tab === "privacy" && styles.tabActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <UiText
                style={
                  tab === "privacy" ? styles.tabTextActive : styles.tabText
                }
              >
                Privacy Policy
              </UiText>
            </Pressable>
          </View>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={true}
        >
          <UiText style={styles.docTitle}>{doc.title}</UiText>
          <UiText style={styles.updated}>
            Last updated: {formatDate(doc.lastUpdated)}
          </UiText>
          <UiText style={styles.intro}>{doc.intro}</UiText>

          {doc.sections.map((section, i) => (
            <View key={`${tab}-${i}`} style={styles.section}>
              <UiText style={styles.sectionHeading}>
                {section.heading}
              </UiText>
              {section.paragraphs.map((p, j) => (
                <UiText key={j} style={styles.paragraph}>
                  {p}
                </UiText>
              ))}
            </View>
          ))}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 20 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingBottom: 12,
  },
  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
    backgroundColor: theme.card,
  },
  tabSwitcher: {
    flexDirection: "row",
    backgroundColor: theme.card,
    borderRadius: 0,
    padding: 3,
  },
  tab: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 0,
  },
  tabActive: {
    backgroundColor: theme.accent,
  },
  tabText: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  tabTextActive: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700" as const,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 60 },
  docTitle: {
    color: theme.text,
    fontSize: 24,
    fontWeight: "900" as const,
    marginTop: 8,
  },
  updated: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  intro: {
    color: theme.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 24,
  },
  section: {
    marginBottom: 20,
  },
  sectionHeading: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "900" as const,
    marginBottom: 8,
  },
  paragraph: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 8,
  },
});
