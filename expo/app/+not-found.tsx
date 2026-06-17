import { Link, Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

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
          <Text style={styles.title}>This drop slipped away</Text>
          <Text style={styles.sub}>That screen doesn&apos;t exist.</Text>
          <Link href="/(tabs)" style={styles.link}>
            <Text style={styles.linkText}>Back to tonight</Text>
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
  title: { color: theme.text, fontSize: 22, fontWeight: "800" as const },
  sub: { color: theme.textMuted, fontSize: 14 },
  link: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: theme.primary,
  },
  linkText: { color: "#fff", fontWeight: "700" as const },
});
