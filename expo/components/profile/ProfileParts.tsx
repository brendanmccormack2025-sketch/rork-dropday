import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Globe, Heart, Instagram, Music2, Youtube } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { AVATAR_SIZE, SIDE_MARGIN, colors, radius, space, type } from "@/constants/design";
import { getCreatorLinks, openCreatorLink, type CreatorLinkKind, type CreatorLinkSource } from "@/lib/creatorLinks";
import { avatarInitial, avatarTint, gridTileSize } from "@/lib/profileUi";
import { resolveAvatarUrl, type Post } from "@/providers/PostsProvider";

/** Round avatar: the photo, or the initial on a soft tinted circle. */
export function RoundAvatar({ avatarUrl, name, size = AVATAR_SIZE }: { avatarUrl: string | null | undefined; name: string; size?: number }) {
  const uri = useMemo(() => resolveAvatarUrl(avatarUrl ?? null), [avatarUrl]);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarTint(name) }]}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={100} cachePolicy="memory" />
      ) : (
        <UiText style={[styles.avatarInitial, { fontSize: size * 0.4 }]}>{avatarInitial(name)}</UiText>
      )}
    </View>
  );
}

/** A small round soft-fill icon button (settings, back, links). 40 pt by default, with a padded touch area. */
export function RoundIconButton({ children, onPress, label, size = 40 }: { children: React.ReactNode; onPress: () => void; label: string; size?: number }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={size < 44 ? (44 - size) / 2 : 0}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.round, { width: size, height: size, borderRadius: size / 2 }, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

/** A single soft rounded button (Edit profile, Block). No border; primary actions use `primary`. */
export function SoftButton({ label, onPress, icon, primary, disabled }: { label: string; onPress: () => void; icon?: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.softBtn, primary && styles.softBtnPrimary, pressed && styles.pressed, disabled && { opacity: 0.5 }]}
    >
      {icon}
      <UiText style={[styles.softBtnText, primary && { color: colors.onPrimary }]}>{label}</UiText>
    </Pressable>
  );
}

const LINK_LABEL: Record<CreatorLinkKind, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", website: "Website" };

/** Round icon buttons for the links that are set (Instagram, TikTok, YouTube, website). They open outside the app. */
export function LinkIconRow({ profile }: { profile: CreatorLinkSource }) {
  const links = getCreatorLinks(profile);
  if (links.length === 0) return null;
  const icon = (k: CreatorLinkKind) => {
    const p = { size: 18, color: colors.text, strokeWidth: 2 } as const;
    return k === "instagram" ? <Instagram {...p} /> : k === "youtube" ? <Youtube {...p} /> : k === "website" ? <Globe {...p} /> : <Music2 {...p} />;
  };
  return (
    <View style={styles.linkRow}>
      {links.map((l) => (
        <RoundIconButton key={l.kind} size={36} label={`${LINK_LABEL[l.kind]} ${l.label}`} onPress={() => void openCreatorLink(l.url)}>
          {icon(l.kind)}
        </RoundIconButton>
      ))}
    </View>
  );
}

/** Text tabs with an animated underline. */
export function ProfileTabs<K extends string>({ tabs, active, onChange }: { tabs: Array<{ key: K; label: string }>; active: K; onChange: (k: K) => void }) {
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, tabs.findIndex((t) => t.key === active));
  const tabW = width / tabs.length;
  useEffect(() => {
    if (width === 0) return;
    Animated.timing(x, { toValue: index * tabW, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [index, tabW, width, x]);
  return (
    <View style={styles.tabs} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessibilityRole="tablist">
      {tabs.map((t) => (
        <Pressable key={t.key} onPress={() => onChange(t.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: t.key === active }}>
          <UiText style={[styles.tabLabel, t.key === active && styles.tabLabelActive]}>{t.label}</UiText>
        </Pressable>
      ))}
      {width > 0 && <Animated.View style={[styles.underline, { width: 28, left: (tabW - 28) / 2, transform: [{ translateX: x }] }]} />}
    </View>
  );
}

/** One post tile: a 9:16 thumbnail, the like count bottom-left over a soft gradient. A queued post carries a small label. */
export function PostTile({ post, onPress, queued }: { post: Post; onPress: () => void; queued?: boolean }) {
  const { width: screenW } = useWindowDimensions();
  const { width, height } = gridTileSize(screenW);
  const cover = post.thumbnail_url ?? post.media_url;
  return (
    <Pressable onPress={onPress} style={[styles.tile, { width, height }]} accessibilityRole="button">
      <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={100} />
      <LinearGradient colors={["transparent", "rgba(0,0,0,0.55)"]} style={styles.tileGrad} pointerEvents="none" />
      {queued ? (
        <View style={styles.queuedPill}>
          <UiText style={styles.queuedText}>Queued</UiText>
        </View>
      ) : null}
      <View style={styles.tileStats} pointerEvents="none">
        <Heart color="#fff" fill="#fff" size={11} />
        <UiText style={styles.tileCount}>{post.like_count ?? 0}</UiText>
      </View>
    </Pressable>
  );
}

/** A draft tile, in the same grid. */
export function DraftTileView({ cover, label, onPress }: { cover: string; label: string; onPress: () => void }) {
  const { width: screenW } = useWindowDimensions();
  const { width, height } = gridTileSize(screenW);
  return (
    <Pressable onPress={onPress} style={[styles.tile, { width, height }]} accessibilityRole="button">
      <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={100} />
      <LinearGradient colors={["transparent", "rgba(0,0,0,0.55)"]} style={styles.tileGrad} pointerEvents="none" />
      <View style={styles.tileStats} pointerEvents="none">
        <UiText style={styles.tileCount}>{label}</UiText>
      </View>
    </Pressable>
  );
}

export function ProfileEmpty({ icon, title, body, actionLabel, onAction }: { icon?: React.ReactNode; title: string; body?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={styles.empty}>
      {icon}
      <UiText style={styles.emptyTitle}>{title}</UiText>
      {body ? <UiText style={styles.emptyBody}>{body}</UiText> : null}
      {actionLabel && onAction ? <SoftButton primary label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

export const gridStyles = StyleSheet.create({
  row: { gap: 2, paddingHorizontal: SIDE_MARGIN, marginBottom: 2 },
  list: { paddingBottom: 120 },
});

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarInitial: { color: colors.text, fontWeight: "800" as const },
  round: { alignItems: "center", justifyContent: "center", backgroundColor: colors.fill },
  pressed: { backgroundColor: colors.fillPressed },
  softBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, minHeight: 40, paddingHorizontal: space.xl, borderRadius: radius.button, backgroundColor: colors.fill },
  softBtnPrimary: { backgroundColor: colors.primary },
  softBtnText: { color: colors.text, ...type.button },
  linkRow: { flexDirection: "row", justifyContent: "center", gap: space.sm, marginTop: space.md },
  tabs: { flexDirection: "row", marginTop: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  tab: { flex: 1, alignItems: "center", paddingVertical: space.md },
  tabLabel: { color: colors.textTertiary, ...type.tab },
  tabLabelActive: { color: colors.text },
  underline: { position: "absolute", bottom: 0, height: 3, borderRadius: 2, backgroundColor: colors.text },
  tile: { borderRadius: radius.tile, overflow: "hidden", backgroundColor: colors.fill },
  tileGrad: { position: "absolute", left: 0, right: 0, bottom: 0, height: "38%" },
  tileStats: { position: "absolute", left: space.sm, bottom: space.sm, flexDirection: "row", alignItems: "center", gap: 4 },
  tileCount: { color: "#fff", ...type.caption },
  queuedPill: { position: "absolute", top: space.sm, left: space.sm, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: "rgba(0,0,0,0.55)" },
  queuedText: { color: "#fff", fontSize: 10, fontWeight: "700" as const },
  empty: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingTop: space.xxl },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: "800" as const, textAlign: "center" },
  emptyBody: { color: colors.textSecondary, ...type.body, textAlign: "center", marginBottom: space.md },
});

export { theme };
