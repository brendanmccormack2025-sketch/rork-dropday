/**
 * Invite links, on the phone: remember a link opened before sign-in, and redeem it. Redeeming is the server's job
 * (redeem_invite: signed token, friends at once and once); this only carries the token there.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Alert } from "react-native";

import { friendlyError, inviteAppLink, inviteMessage, inviteWebLink, parseInviteToken } from "@/lib/friendsCore";
import { myInviteToken, redeemInvite } from "@/lib/friends";
import { supabase } from "@/lib/supabase";

const KEY = "tryal:pendingInvite";
export const INVITE_BASE = process.env.EXPO_PUBLIC_INVITE_BASE_URL && process.env.EXPO_PUBLIC_INVITE_BASE_URL.length > 0 ? process.env.EXPO_PUBLIC_INVITE_BASE_URL : undefined;

/** An invite opened while signed out is kept until the person has an account. */
export async function savePendingInvite(token: string): Promise<void> {
  const t = parseInviteToken(token);
  if (!t) return;
  try {
    await AsyncStorage.setItem(KEY, t);
  } catch {
    // best effort
  }
}

export async function takePendingInvite(): Promise<string | null> {
  try {
    const t = await AsyncStorage.getItem(KEY);
    if (t) await AsyncStorage.removeItem(KEY);
    return t ? parseInviteToken(t) : null;
  } catch {
    return null;
  }
}

export type RedeemResult = { ok: true; inviterId: string } | { ok: false; message: string };

export async function redeemToken(token: string): Promise<RedeemResult> {
  const t = parseInviteToken(token);
  if (!t) return { ok: false, message: friendlyError(new Error("invalid invite")) };
  try {
    return { ok: true, inviterId: await redeemInvite(t) };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}

/** My personal link and the message to send with it. */
export async function myInvite(): Promise<{ token: string; link: string; message: string; appLink: string }> {
  const scheme = typeof Constants.expoConfig?.scheme === "string" ? Constants.expoConfig.scheme : "tryal";
  const token = await myInviteToken();
  const link = inviteWebLink(token, INVITE_BASE);
  return { token, link, message: inviteMessage(link), appLink: inviteAppLink(token, scheme) };
}

/**
 * Redeem a token for the signed-in person and tell them the result. Used right after opening a link while signed in, and
 * after sign-up / sign-in for a link that was opened before. Returns the inviter's id when they are now friends.
 */
export async function redeemAndTell(token: string): Promise<string | null> {
  const res = await redeemToken(token);
  if (!res.ok) {
    Alert.alert("Invite", res.message);
    return null;
  }
  let who = "your friend";
  try {
    const { data } = await supabase.from("profiles").select("username").eq("id", res.inviterId).maybeSingle();
    if (data?.username) who = `@${data.username as string}`;
  } catch {
    // the name is a nicety
  }
  Alert.alert("You're friends", `You and ${who} are now friends on Tryal.`);
  return res.inviterId;
}

/** After sign-in: a link opened earlier is redeemed once. */
export async function redeemPendingInvite(): Promise<void> {
  const token = await takePendingInvite();
  if (token) await redeemAndTell(token);
}
