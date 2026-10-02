import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Globe, Instagram, Music2, Youtube } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import {
  getCreatorLinks,
  openCreatorLink,
  type CreatorLinkKind,
  type CreatorLinkSource,
} from "@/lib/creatorLinks";

function KindIcon({ kind }: { kind: CreatorLinkKind }) {
  const common = { size: 12, strokeWidth: 2 } as const;
  if (kind === "instagram") return <Instagram color="#E8291C" {...common} />;
  if (kind === "tiktok") return <Music2 color={theme.text} {...common} />;
  if (kind === "youtube") return <Youtube color="#E8291C" {...common} />;
  return <Globe color={theme.accent} {...common} />;
}

/** Row of tappable creator links (only the ones that are set and valid). */
export default function CreatorLinkPills({ profile }: { profile: CreatorLinkSource }) {
  const links = getCreatorLinks(profile);
  if (links.length === 0) return null;
  return (
    <View style={styles.linksRow}>
      {links.map((l) => (
        <Pressable
          key={l.kind}
          style={styles.linkPill}
          onPress={() => {
            void openCreatorLink(l.url);
          }}
        >
          <KindIcon kind={l.kind} />
          <UiText style={styles.linkText} numberOfLines={1}>
            {l.label}
          </UiText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  linksRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  linkPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(10,10,10,0.07)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(10,10,10,0.08)",
  },
  linkText: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: "600" as const,
    maxWidth: 150,
  },
});
