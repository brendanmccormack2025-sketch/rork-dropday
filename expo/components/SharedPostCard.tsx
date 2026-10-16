import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Play } from "lucide-react-native";

import { FeedAvatar } from "@/components/Avatar";
import UiText from "@/components/UiText";
import { POST_UNAVAILABLE_TEXT } from "@/lib/friendsCore";
import { supabase } from "@/lib/supabase";

/**
 * The tall preview of a post sent in a chat (like Instagram / TikTok DMs): cover image, the creator, a play button.
 * Only reads the post row (no view is recorded; opening it goes through open_shared_post as before). Whether it can be
 * shown is still decided by the server: if the row can't be read, or the post has ended or its video is gone, the card
 * says so instead.
 */
type Preview = { cover: string | null; username: string | null; avatar_url: string | null; available: boolean };

const cache = new Map<string, Preview>();

function resolveStorageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  return supabase.storage.from("drops").getPublicUrl(raw).data?.publicUrl ?? null;
}

async function loadPreview(postId: string): Promise<Preview> {
  const hit = cache.get(postId);
  if (hit) return hit;
  const { data } = await supabase
    .from("posts")
    .select("thumbnail_url, media_url, media_type, status, distribution_expires_at, media_deleted_at, profiles!posts_user_id_fkey(username, avatar_url)")
    .eq("id", postId)
    .maybeSingle();
  const row = data as Record<string, any> | null;
  const profile = (Array.isArray(row?.profiles) ? row?.profiles[0] : row?.profiles) ?? null;
  const ended =
    !row ||
    !!row.media_deleted_at ||
    row.status === "archived" ||
    row.status === "expired" ||
    row.status === "incomplete" ||
    (row.status === "survived" && row.distribution_expires_at && new Date(row.distribution_expires_at).getTime() < Date.now());
  const cover = row ? resolveStorageUrl(row.thumbnail_url) ?? (row.media_type === "image" ? resolveStorageUrl(row.media_url) : null) : null;
  const p: Preview = { cover: ended ? null : cover, username: profile?.username ?? null, avatar_url: profile?.avatar_url ?? null, available: !ended };
  cache.set(postId, p);
  return p;
}

export const SHARED_POST_CARD_WIDTH = 184;

export default function SharedPostCard({ postId }: { postId: string | null }) {
  const [p, setP] = useState<Preview | null>(postId ? cache.get(postId) ?? null : { cover: null, username: null, avatar_url: null, available: false });

  useEffect(() => {
    if (!postId || cache.has(postId)) return;
    let alive = true;
    loadPreview(postId)
      .then((v) => alive && setP(v))
      .catch(() => alive && setP({ cover: null, username: null, avatar_url: null, available: false }));
    return () => {
      alive = false;
    };
  }, [postId]);

  const gone = p ? !p.available : false;
  return (
    <View style={styles.card}>
      {p?.cover ? <Image source={{ uri: p.cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" /> : null}
      {gone ? (
        <View style={styles.goneWrap}>
          <UiText style={styles.goneText}>{POST_UNAVAILABLE_TEXT}</UiText>
        </View>
      ) : (
        <>
          <LinearGradient colors={["rgba(0,0,0,0.55)", "transparent"]} style={styles.topShade} pointerEvents="none" />
          {p?.username ? (
            <View style={styles.creator}>
              <FeedAvatar profile={{ avatar_url: p.avatar_url }} name={p.username} size={24} />
              <UiText style={styles.username} numberOfLines={1}>
                {p.username}
              </UiText>
            </View>
          ) : null}
          <View style={styles.playWrap} pointerEvents="none">
            <View style={styles.play}>
              <Play color="#fff" fill="#fff" size={20} style={{ marginLeft: 3 }} />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: SHARED_POST_CARD_WIDTH, aspectRatio: 9 / 16, borderRadius: 20, overflow: "hidden", backgroundColor: "#1C1B19" },
  topShade: { position: "absolute", top: 0, left: 0, right: 0, height: 72 },
  creator: { position: "absolute", top: 10, left: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 7 },
  username: { color: "#fff", fontSize: 13, fontWeight: "800", flexShrink: 1, textShadowColor: "rgba(0,0,0,0.4)", textShadowRadius: 4 },
  playWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  play: { width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(0,0,0,0.35)", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.7)", alignItems: "center", justifyContent: "center" },
  goneWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 16 },
  goneText: { color: "rgba(255,255,255,0.6)", fontSize: 13, textAlign: "center" },
});
