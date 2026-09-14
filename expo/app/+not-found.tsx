import { Link, Stack } from "expo-router";
import { StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";

import ScreenBackground from "@/components/ScreenBackground";
import DropletLogo from "@/components/DropletLogo";
import { theme } from "@/constants/theme";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Lost drop", headerShown: false }} />
      <ScreenBackground>
        <View style={styles.container}>
          <DropletLogo size={80} />
          <UiText style={styles.title}>This drop slipped away</UiText>
          <UiText style={styles.sub}>That screen doesn&apos;t exist.</UiText>
          <Link href="/(tabs)" style={styles.link}>
            <UiText style={styles.linkText}>Back to tonight</UiText>
          </Link>
        </View>
      </ScreenBackground>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  title: { color: theme.text, fontSize: 22, fontWeight: "900" as const },
  sub: { color: theme.textMuted, fontSize: 14 },
  link: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: theme.primary,
  },
  linkText: { color: "#fff", fontWeight: "700" as const },
});
