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

import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { PostsProvider } from "@/providers/PostsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { theme } from "@/constants/theme";

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
          contentStyle: { backgroundColor: "#000" },
        }}
      />
      <Stack.Screen
        name="edit"
        options={{
          presentation: "fullScreenModal",
          animation: "slide_from_right",
          gestureEnabled: false,
          contentStyle: { backgroundColor: "#000" },
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
        name="cover-picker"
        options={{
          presentation: "fullScreenModal",
          animation: "slide_from_right",
          gestureEnabled: false,
          headerShown: false,
          contentStyle: { backgroundColor: "#08080B" },
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
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <View style={{ flex: 1, backgroundColor: theme.bg }}>
            <StatusBar style="light" />
            <AuthProvider>
              <PostsProvider>
                <AuthGate>
                  <RootLayoutNav />
                </AuthGate>
              </PostsProvider>
            </AuthProvider>
          </View>
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
