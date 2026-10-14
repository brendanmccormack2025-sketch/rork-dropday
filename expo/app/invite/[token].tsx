import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";
import { parseInviteToken } from "@/lib/friendsCore";
import { redeemAndTell, savePendingInvite } from "@/lib/invite";
import { useAuth } from "@/providers/AuthProvider";

/**
 * An invite link opened in the app (tryal-scheme://invite/<token>, or the web link forwarded here). Signed in: friends at
 * once (the server checks the signature). Signed out: the link is kept, and redeemed when the person has an account.
 */
export default function InviteScreen() {
  const router = useRouter();
  const { session, loading } = useAuth();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (loading) return;
    const t = parseInviteToken(String(token));
    if (!t) {
      setDone(true);
      return;
    }
    if (!session) {
      void savePendingInvite(t);
      return; // the sign-in gate takes the person to the welcome screen; the link is redeemed afterwards
    }
    let alive = true;
    void redeemAndTell(t).then((inviter) => {
      if (!alive) return;
      if (inviter) router.replace(`/messages/${inviter}` as never);
      else setDone(true);
    });
    return () => {
      alive = false;
    };
  }, [token, session, loading, router]);

  return (
    <View style={styles.root}>
      {done ? (
        <>
          <UiText style={styles.text}>This invite link isn't valid any more.</UiText>
          <Pressable onPress={() => router.replace("/(tabs)")} style={styles.btn}>
            <UiText style={styles.btnText}>Go to Tryal</UiText>
          </Pressable>
        </>
      ) : (
        <ActivityIndicator color={theme.accent} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  text: { color: theme.textMuted, fontSize: 15, textAlign: "center" },
  btn: { backgroundColor: theme.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  btnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
