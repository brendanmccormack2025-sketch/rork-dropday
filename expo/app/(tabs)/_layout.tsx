import { Tabs, useRouter } from "expo-router";
import { Home, User } from "lucide-react-native";
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import CenterPostButton from "@/components/CenterPostButton";
import PostChoiceSheet from "@/components/PostChoiceSheet";

export default function TabLayout() {
  const router = useRouter();
  const [chooserOpen, setChooserOpen] = useState<boolean>(false);

  const openChooser = useCallback(() => {
    setChooserOpen(true);
  }, []);

  return (
    <>
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#FF5A44",
        tabBarInactiveTintColor: "rgba(255,255,255,0.75)",
        tabBarStyle: styles.tabBar,
        // Bottom scrim behind the tab bar: transparent → rgba(0,0,0,0.75)
        // reached at 45% of the bar height, so icons stay legible over any
        // full-bleed video content.
        tabBarBackground: () => (
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.75)"]}
            locations={[0, 0.45]}
            style={StyleSheet.absoluteFill}
          />
        ),
        tabBarLabelStyle: styles.label,
        // 3px gap between icon and label.
        tabBarIconStyle: { marginBottom: 3 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Feed",
          tabBarIcon: ({ color }) => (
            <Home color={color} size={23} />
          ),
        }}
      />
      {/* Hidden (files stay): only Feed, the center + and Me are visible. */}
      <Tabs.Screen name="explore" options={{ href: null }} />
      <Tabs.Screen
        name="drop"
        options={{
          title: "",
          tabBarButton: () => (
            <Pressable
              onPress={openChooser}
              style={styles.centerSlot}
              android_ripple={null}
              hitSlop={12}
            >
              <CenterPostButton onPress={openChooser} />
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen name="friends" options={{ href: null }} />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Me",
          tabBarIcon: ({ color }) => <User color={color} size={23} />,
        }}
      />
    </Tabs>
    <PostChoiceSheet visible={chooserOpen} onClose={() => setChooserOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute",
    backgroundColor: "transparent",
    height: 88,
    paddingTop: 6,
  },
  label: {
    fontSize: 10,
    fontWeight: "700" as const,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  centerSlot: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});
