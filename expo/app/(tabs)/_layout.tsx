import { Tabs, useRouter } from "expo-router";
import { Home, User } from "lucide-react-native";
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";

import { colors } from "@/constants/design";
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
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: styles.tabBar,
        // Light bar for the light theme: the cream page, slightly see-through, over a subtle blur, with a hairline top border.
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.tabBar }]} />
          </View>
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
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
