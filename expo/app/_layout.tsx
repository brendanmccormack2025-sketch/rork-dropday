// Must import before any JSX is evaluated — patches the JSX runtime on web
// to strip `collapsable` from DOM-bound elements (React 19 compat).
import "@/lib/webCompat";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  useFonts,
  PlusJakartaSans_300Light,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";

import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { PostsProvider } from "@/providers/PostsProvider";
import { NotificationsProvider } from "@/providers/NotificationsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { theme } from "@/constants/theme";

console.log("[DEBUG] Supabase URL in use:", process.env.EXPO_PUBLIC_SUPABASE_URL);

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!session && !inAuthGroup) {
      // Debounce: don't redirect on a single transient null-session render.
      // If session flips back to non-null within 400ms (e.g. a token
      // refresh momentarily emits SIGNED_OUT before SIGNED_IN), this
      // effect re-runs and the cleanup below cancels the redirect.
      const timeout = setTimeout(() => {
        router.replace("/(auth)/welcome");
      }, 400);
      return () => clearTimeout(timeout);
    } else if (session && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [session, loading, segments, router]);

  return <>{children}</>;
}

function RootLayoutNav() {
  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="camera"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_bottom",
            gestureEnabled: false,
            contentStyle: { backgroundColor: "#0A0A14" },
          }}
        />
        <Stack.Screen
          name="edit"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_right",
            gestureEnabled: false,
            contentStyle: { backgroundColor: "#0A0A14" },
          }}
        />
        <Stack.Screen
          name="post/[id]/reactions"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="post/[id]/reaction-tree"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_bottom",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="edit-profile"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_bottom",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="follow-list"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="dm/inbox"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="dm/[conversationId]"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="dm/new"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="profile-drops"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_bottom",
            headerShown: false,
            contentStyle: { backgroundColor: "#0A0A14" },
          }}
        />
        <Stack.Screen
          name="user/[id]"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_300Light,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <View style={{ flex: 1, backgroundColor: theme.bg }}>
            <StatusBar style="light" />
            <AuthProvider>
              <PostsProvider>
                <NotificationsProvider>
                  <AuthGate>
                    <RootLayoutNav />
                  </AuthGate>
                </NotificationsProvider>
              </PostsProvider>
            </AuthProvider>
          </View>
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
