// Must import before any JSX is evaluated — patches the JSX runtime on web
// to strip `collapsable` from DOM-bound elements (React 19 compat).
import "@/lib/webCompat";
import { installGlobalErrorHandlers, setErrorContext, flushClientErrors } from "@/lib/clientErrors";

// Before anything else can throw: fatal errors and unhandled rejections are recorded.
installGlobalErrorHandlers();

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, usePathname, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { Appearance, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
// One import per weight: the package index would pull in every weight of a family (Montserrat alone is 6 MB).
import { PlusJakartaSans_300Light } from "@expo-google-fonts/plus-jakarta-sans/300Light";
import { PlusJakartaSans_400Regular } from "@expo-google-fonts/plus-jakarta-sans/400Regular";
import { PlusJakartaSans_500Medium } from "@expo-google-fonts/plus-jakarta-sans/500Medium";
import { PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans/700Bold";
import { PlusJakartaSans_800ExtraBold } from "@expo-google-fonts/plus-jakarta-sans/800ExtraBold";
import { Montserrat_700Bold } from "@expo-google-fonts/montserrat/700Bold";
import { Montserrat_800ExtraBold } from "@expo-google-fonts/montserrat/800ExtraBold";
// Text overlay fonts (lib/fonts.ts), one weight each, all SIL Open Font License.
import { TikTokSans_700Bold } from "@expo-google-fonts/tiktok-sans/700Bold";
import { Anton_400Regular } from "@expo-google-fonts/anton/400Regular";
import { ArchivoBlack_400Regular } from "@expo-google-fonts/archivo-black/400Regular";
import { Poppins_600SemiBold } from "@expo-google-fonts/poppins/600SemiBold";
import { PermanentMarker_400Regular } from "@expo-google-fonts/permanent-marker/400Regular";
import { Caveat_700Bold } from "@expo-google-fonts/caveat/700Bold";
import { DMSerifDisplay_400Regular } from "@expo-google-fonts/dm-serif-display/400Regular";
import { SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk/700Bold";

import SaveToRollToast from "@/components/SaveToRollToast";
import { AuthProvider, useAuth } from "@/providers/AuthProvider";
import { UserBlocksProvider } from "@/hooks/useUserBlocks";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { syncContactsIfDue } from "@/lib/contacts";
import { redeemPendingInvite } from "@/lib/invite";
import { scheduleLaunchCleanup } from "@/lib/storageCleanup";
import { installPushHandlers, registerForPush, watchPushToken } from "@/lib/push";
import { phonePromptKey } from "@/lib/phonePrompt";
import { PostsProvider } from "@/providers/PostsProvider";
import { GroupsProvider } from "@/providers/GroupsProvider";
import { NotificationsProvider } from "@/providers/NotificationsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import RenderReportToast from "@/components/RenderReportToast";
import { theme } from "@/constants/theme";


// The app is cream-only: never follow the phone's Dark Mode.
Appearance.setColorScheme("light");

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const pathname = usePathname();

  // The error recorder knows where the app is and who is signed in; reports saved by an earlier run go up now.
  useEffect(() => {
    setErrorContext({ screen: pathname });
  }, [pathname]);
  useEffect(() => {
    const id = session?.user?.id ?? null;
    setErrorContext({ userId: id });
    if (id) void flushClientErrors(id);
  }, [session?.user?.id]);

  // Temporary video files left by earlier runs (camera takes, merges, renders, staged uploads) are deleted a few
  // seconds after launch; drafts and pending uploads keep theirs (lib/storageCleanup.ts).
  useEffect(() => scheduleLaunchCleanup(), []);

  // A tap on a push opens the screen it names (only routes the app knows); the saved token follows system changes.
  useEffect(() => {
    const offTap = installPushHandlers((route) => router.push(route as never));
    const offToken = watchPushToken();
    return () => {
      offTap();
      offToken();
    };
  }, [router]);

  // Build in silence: re-sync contacts (only if the user turned it on) on app open, at most weekly; and offer the
  // optional phone number step once per account (after the auth screens are gone).
  const phoneStepChecked = React.useRef<string | null>(null);
  useEffect(() => {
    const id = session?.user?.id;
    if (!id || segments[0] === "(auth)") return;
    if (phoneStepChecked.current === id) return;
    phoneStepChecked.current = id;
    void syncContactsIfDue(id);
    void redeemPendingInvite();   // an invite link opened before the account existed
    void registerForPush(id);     // ask once, then save this phone's Expo push token for the account
    AsyncStorage.getItem(phonePromptKey(id)).then((seen) => {
      if (!seen) router.push("/onboarding-phone" as never);
    }, () => {});
  }, [session?.user?.id, segments, router]);

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
            // Black behind the camera preview: any gap in the preview (session rebuild) must never show the light app background.
            contentStyle: { backgroundColor: "#000" },
          }}
        />
        <Stack.Screen
          name="edit"
          options={{
            presentation: "fullScreenModal",
            animation: "slide_from_right",
            gestureEnabled: false,
            contentStyle: { backgroundColor: theme.bg },
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
            contentStyle: { backgroundColor: theme.bg },
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
        <Stack.Screen
          name="settings"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="group/new"
          options={{
            presentation: "card",
            animation: "slide_from_right",
            headerShown: false,
            contentStyle: { backgroundColor: theme.bg },
          }}
        />
        <Stack.Screen
          name="group/[id]"
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
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_300Light,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
    TikTokSans_700Bold,
    Anton_400Regular,
    ArchivoBlack_400Regular,
    Poppins_600SemiBold,
    PermanentMarker_400Regular,
    Caveat_700Bold,
    DMSerifDisplay_400Regular,
    SpaceGrotesk_700Bold,
  });
  // A font that fails to load must not keep the app on the splash screen: text falls back to Montserrat / the system
  // font (lib/textLook.ts textFontFamily checks what is loaded).
  const fontsReady = fontsLoaded || !!fontError;

  useEffect(() => {
    if (fontsReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsReady]);

  if (!fontsReady) {
    return null;
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.bg }}>
            <StatusBar style="dark" />
            <RenderReportToast />
            <SaveToRollToast />
            <AuthProvider>
              <UserBlocksProvider>
                <PostsProvider>
                  <GroupsProvider>
                    <NotificationsProvider>
                    <AuthGate>
                      <RootLayoutNav />
                    </AuthGate>
                    </NotificationsProvider>
                  </GroupsProvider>
                </PostsProvider>
              </UserBlocksProvider>
            </AuthProvider>
          </GestureHandlerRootView>
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
