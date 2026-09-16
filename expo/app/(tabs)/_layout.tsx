import { Tabs, useRouter } from "expo-router";
import { Compass, Home, User, Users } from "lucide-react-native";
import React, { useCallback } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";

import CenterPostButton from "@/components/CenterPostButton";
import { theme } from "@/constants/theme";
import { useNotifications } from "@/providers/NotificationsProvider";
import UiText from "@/components/UiText";

export default function TabLayout() {
  const router = useRouter();
  const { unreadCount } = useNotifications();

  const openCamera = useCallback(() => {
    router.push("/camera");
  }, [router]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textDim,
        tabBarStyle: styles.tabBar,
        tabBarBackground: () =>
          Platform.OS === "ios" ? (
            <BlurView
              tint="light"
              intensity={60}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}
            />
          ),
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Feed",
          tabBarIcon: ({ color, size }) => (
            <Home color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: "Explore",
          tabBarIcon: ({ color, size }) => <Compass color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="drop"
        options={{
          title: "",
          tabBarButton: () => (
            <Pressable
              onPress={openCamera}
              style={styles.centerSlot}
              android_ripple={null}
              hitSlop={12}
            >
              <CenterPostButton onPress={openCamera} />
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
              <Users color={color} size={size} />
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
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute",
    borderTopWidth: 1,
    borderTopColor: theme.border,
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
