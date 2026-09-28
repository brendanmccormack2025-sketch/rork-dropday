import { Tabs, useRouter } from "expo-router";
import { Compass, Home, User, Users } from "lucide-react-native";
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import CenterPostButton from "@/components/CenterPostButton";
import PostChoiceSheet from "@/components/PostChoiceSheet";
import { theme } from "@/constants/theme";
import { useNotifications } from "@/providers/NotificationsProvider";
import UiText from "@/components/UiText";

export default function TabLayout() {
  const router = useRouter();
  const { unreadCount } = useNotifications();

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
      <Tabs.Screen
        name="explore"
        options={{
          title: "Explore",
          tabBarIcon: ({ color }) => <Compass color={color} size={23} />,
        }}
      />
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
      <Tabs.Screen
        name="friends"
        options={{
          title: "Friends",
          tabBarIcon: ({ color, size }) => (
            <View>
              <Users color={color} size={23} />
              {unreadCount > 0 && (
                <View style={styles.tabBadge}>
                  <UiText style={styles.tabBadgeText}>
                    {unreadCount > 9 ? "9+" : String(unreadCount)}
                  </UiText>
                </View>
              )}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
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
  tabBadge: {
    position: "absolute",
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    borderRadius: 0,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: theme.bg,
  },
  tabBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "900" as const,
  },
});
