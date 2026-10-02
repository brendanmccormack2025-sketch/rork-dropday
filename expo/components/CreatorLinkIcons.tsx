import React, { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Globe, Instagram, Youtube } from "lucide-react-native";
import UiText from "@/components/UiText";
import {
  getCreatorLinks,
  openCreatorLink,
  type CreatorLinkKind,
  type CreatorLinkSource,
} from "@/lib/creatorLinks";

const ICON_SIZE = 22;
const LABELS: Record<CreatorLinkKind, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  website: "Website",
};

type Props = {
  profile: CreatorLinkSource;
  /** Called just before the external app opens (e.g. to pause the video). */
  onBeforeOpen?: () => void;
};

/** Small icon row of the creator's own links. Renders nothing when none are set. */
function CreatorLinkIcons({ profile, onBeforeOpen }: Props) {
  const links = useMemo(
    () => getCreatorLinks(profile),
    [profile?.instagram_handle, profile?.tiktok_handle, profile?.youtube_url, profile?.website],
  );
  if (links.length === 0) return null;
  return (
    <View style={styles.row}>
      {links.map((l) => (
        <Pressable
          key={l.kind}
          style={styles.btn}
          accessibilityRole="link"
          accessibilityLabel={`${LABELS[l.kind]} ${l.label}`}
          onPress={() => {
            onBeforeOpen?.();
            void openCreatorLink(l.url);
          }}
        >
          {l.kind === "instagram" ? (
            <Instagram size={ICON_SIZE} color="#fff" />
          ) : l.kind === "youtube" ? (
            <Youtube size={ICON_SIZE} color="#fff" />
          ) : l.kind === "website" ? (
            <Globe size={ICON_SIZE} color="#fff" />
          ) : (
            <View style={styles.chip}>
              <UiText style={styles.chipText}>TT</UiText>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  );
}

export default memo(CreatorLinkIcons);

// 44x44 touch targets; the 22px icons sit 44px apart (22px visible gap).
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginLeft: -11 },
  btn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  chip: {
    height: ICON_SIZE,
    minWidth: ICON_SIZE,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { color: "#fff", fontSize: 10, fontWeight: "700" as const },
});
