/**
 * Expo push on the phone: ask for permission once, get the Expo push token, save it for the signed-in person, remove it on
 * sign-out, and open the right screen when a push is tapped. The server side is supabase/functions/send-push.
 * expo-notifications is required lazily and every call is guarded: a build without the native module, a simulator, or a
 * denied permission just does nothing and never breaks sign-in.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { EXPO_TOKEN_RE, normalizePrefs, routeFromPushData, type PushPrefs } from "@/lib/pushCore";
import { supabase } from "@/lib/supabase";

type NotificationsModule = typeof import("expo-notifications");

function load(): NotificationsModule | null {
  try {
    return require("expo-notifications") as NotificationsModule;
  } catch {
    return null;
  }
}

const TOKEN_KEY = "tryal:pushToken";
const askedKey = (userId: string) => `tryal:pushAsked:${userId}`;

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/** Save this phone's token for the person (the server moves it if someone else had it). */
async function save(token: string): Promise<void> {
  if (!EXPO_TOKEN_RE.test(token)) return;
  const { error } = await supabase.rpc("register_push_token", { p_token: token, p_platform: Platform.OS === "android" ? "android" : "ios" });
  if (!error) await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {});
}

/**
 * On sign-in: ask for permission the first time for this account (afterwards only a silent refresh, if it is still
 * granted), then register the token. Safe to call on every app start.
 */
let registeredFor: string | null = null;
export async function registerForPush(userId: string): Promise<void> {
  if (registeredFor === userId) return; // once per app run and account
  registeredFor = userId;
  try {
    if (Platform.OS === "web") return;
    const N = load();
    if (!N) return;
    let perm = await N.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain && (await AsyncStorage.getItem(askedKey(userId))) === null) {
      await AsyncStorage.setItem(askedKey(userId), "1");
      perm = await N.requestPermissionsAsync();
    }
    if (!perm.granted) return;
    if (Platform.OS === "android") {
      await N.setNotificationChannelAsync("default", { name: "Tryal", importance: N.AndroidImportance.DEFAULT }).catch(() => {});
    }
    const res = await N.getExpoPushTokenAsync(projectId() ? { projectId: projectId() } : undefined);
    await save(res.data);
  } catch {
    // no token on this device (simulator, no network): nothing to do
  }
}

/**
 * Deliberately does nothing. It used to listen for token changes and fetch the Expo token again on each one, but fetching
 * the token makes iOS report the device token again, which fired the listener again: an endless loop that heated the
 * phone and made the camera and editor crash. registerForPush() at every launch keeps the saved token current instead.
 */
export function watchPushToken(): () => void {
  return () => {};
}

/** Before signing out: this phone stops getting this person's pushes. */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (token) {
      await supabase.rpc("remove_push_token", { p_token: token });
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // signing out must never fail because of this
  }
}

/** Shows pushes while the app is open, and opens the right screen when one is tapped. Returns the unsubscribe function. */
export function installPushHandlers(open: (route: string) => void): () => void {
  try {
    const N = load();
    if (!N) return () => {};
    N.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
    });
    const sub = N.addNotificationResponseReceivedListener((response) => {
      const route = routeFromPushData(response.notification.request.content.data);
      if (route) open(route);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export async function getPushPrefs(): Promise<PushPrefs> {
  const { data, error } = await supabase.rpc("get_push_prefs");
  if (error) throw new Error(error.message);
  return normalizePrefs((Array.isArray(data) ? data[0] : data) as Partial<PushPrefs> | null);
}

export async function setPushPrefs(patch: Partial<PushPrefs>): Promise<void> {
  const { error } = await supabase.rpc("set_push_prefs", { p_prefs: patch });
  if (error) throw new Error(error.message);
}
