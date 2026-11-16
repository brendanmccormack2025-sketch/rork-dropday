import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ExternalLink } from "lucide-react-native";
import UiText from "@/components/UiText";
import CreatorLinkIcons from "@/components/CreatorLinkIcons";
import type { CreatorLinkSource } from "@/lib/creatorLinks";
import { getPostLink, myPostLinkTaps, openPostLink, tapsLine, watchLabel, type PostLink } from "@/lib/postLinks";

type Props = {
  postId: string;
  profile: CreatorLinkSource;
  isOwner: boolean;
  /** Called just before the external app opens (to pause the video). */
  onBeforeOpen?: () => void;
};

/**
 * Under a post: a "Watch on <platform>" button when the post carries a video link (it opens the tracked short link, never the raw address),
 * otherwise the creator's own social links, exactly as before. The post's owner also sees how many people the link sent to the video.
 */
export default function PostLinkOrSocials({ postId, profile, isOwner, onBeforeOpen }: Props) {
  const [link, setLink] = useState<PostLink | null>(null);
  const [taps, setTaps] = useState(0);
  useEffect(() => {
    let live = true;
    getPostLink(postId).then((l) => { if (live) setLink(l); });
    return () => { live = false; };
  }, [postId]);
  useEffect(() => {
    if (!isOwner || !link) return;
    let live = true;
    myPostLinkTaps(postId).then((n) => { if (live) setTaps(n); });
    return () => { live = false; };
  }, [isOwner, link, postId]);

  if (!link) return <CreatorLinkIcons profile={profile} onBeforeOpen={onBeforeOpen} />;
  const line = isOwner ? tapsLine(taps) : null;
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => { onBeforeOpen?.(); void openPostLink(link); }}
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.8 }]}
        accessibilityRole="link"
        accessibilityLabel={watchLabel(link.platform)}
      >
        <ExternalLink color="#fff" size={14} />
        <UiText style={styles.btnText}>{watchLabel(link.platform)}</UiText>
      </Pressable>
      {line ? <UiText style={styles.taps}>{line}</UiText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4, alignItems: "flex-start", marginTop: 4 },
  btn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#E8291C", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btnText: { color: "#fff", fontSize: 14, fontWeight: "800" as const },
  taps: { color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: "600" as const },
});
