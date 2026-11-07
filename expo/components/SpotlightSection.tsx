import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { getSpotlight, thumbUri } from "@/lib/spotlight";
import { categoryLabel, SPOTLIGHT_SECTION_TITLE } from "@/lib/spotlightText";
import { useAuth } from "@/providers/AuthProvider";

/**
 * The Spotlight section (top of Explore): only what the database returns for this viewer, i.e. creators who said yes and for
 * whom this viewer is eligible. Empty: the section is not drawn at all.
 */
export function SpotlightSection() {
  const router = useRouter();
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ["spotlight", "section", user?.id], enabled: !!user?.id, staleTime: 60_000, queryFn: () => getSpotlight(10) });
  if (!data || data.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Star color={theme.accent} size={14} strokeWidth={2.5} fill={theme.accent} />
        <UiText style={styles.title}>{SPOTLIGHT_SECTION_TITLE}</UiText>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {data.map((s) => {
          const uri = thumbUri(s.thumbnail_url);
          return (
            <Pressable key={s.pick_id} onPress={() => router.push(`/user/${s.creator_id}` as never)} style={styles.card} accessibilityRole="button" accessibilityLabel={`${categoryLabel(s.category)}: @${s.username}`}>
              {uri ? <Image source={{ uri }} style={styles.thumb} contentFit="cover" /> : <View style={[styles.thumb, styles.noThumb]} />}
              <UiText style={styles.cat} numberOfLines={1}>{categoryLabel(s.category)}</UiText>
              <UiText style={styles.name} numberOfLines={1}>@{s.username}</UiText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  title: { color: theme.text, fontSize: 16, fontWeight: "800" as const },
  row: { gap: 10, paddingRight: 8 },
  card: { width: 120 },
  thumb: { width: 120, height: 170, borderRadius: 12, backgroundColor: theme.border },
  noThumb: { backgroundColor: theme.border },
  cat: { color: theme.accent, fontSize: 11, fontWeight: "800" as const, marginTop: 6 },
  name: { color: theme.text, fontSize: 13, fontWeight: "600" as const },
});
