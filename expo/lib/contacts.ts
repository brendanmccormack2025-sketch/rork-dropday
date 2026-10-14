/**
 * Contacts matching (build in silence). The native module (expo-contacts) ships in build 1.0.5; builds before that
 * have no ExpoContacts module, so everything here checks for it at runtime and quietly does nothing without it.
 * Only phone numbers are read, normalised on the phone, and sent over TLS to an RPC that hashes them (HMAC with a
 * server-side pepper). Raw numbers are never stored or logged. The app works fully if contacts are denied.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { requireOptionalNativeModule } from "expo";

import { supabase } from "@/lib/supabase";
import { collectNumbers, contactsAvailable, shouldResync } from "@/lib/contactsSync";
import { regionFromLocale } from "@/lib/phone";

type ContactsModule = {
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  getPermissionsAsync: () => Promise<{ granted: boolean }>;
  getContactsAsync: (o: { fields: string[]; pageSize: number; pageOffset: number }) => Promise<{
    data: Array<{ id?: string; name?: string; phoneNumbers?: Array<{ number?: string; digits?: string }> }>;
    hasNextPage: boolean;
  }>;
  Fields: { PhoneNumbers: string; Name?: string };
};

export function isContactsAvailable(): boolean {
  return contactsAvailable(() => requireOptionalNativeModule("ExpoContacts"));
}

function loadModule(): ContactsModule | null {
  if (!isContactsAvailable()) return null;
  try {
    // required lazily: importing the JS module without its native module throws
    return require("expo-contacts") as ContactsModule;
  } catch {
    return null;
  }
}

export function deviceRegion(): string | null {
  try {
    return regionFromLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

const keyOf = (userId: string) => `contacts_synced_at:${userId}`;
const enabledKey = (userId: string) => `contacts_enabled:${userId}`;

async function readAllNumbers(mod: ContactsModule): Promise<string[]> {
  const region = deviceRegion();
  const all = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const res = await mod.getContactsAsync({ fields: [mod.Fields.PhoneNumbers], pageSize: 500, pageOffset: offset });
    for (const n of collectNumbers(res.data, region)) all.add(n);
    if (!res.hasNextPage) break;
    offset += 500;
  }
  return [...all];
}

async function upload(userId: string, mod: ContactsModule): Promise<boolean> {
  const numbers = await readAllNumbers(mod);
  const { error } = await supabase.rpc("sync_my_contacts", { p_numbers: numbers });
  if (error) return false;
  await AsyncStorage.setItem(keyOf(userId), String(Date.now()));
  return true;
}

/** Explainer accepted: asks the system for permission, then syncs. Returns "granted" | "denied" | "unavailable". */
export async function enableContacts(userId: string): Promise<"granted" | "denied" | "unavailable"> {
  const mod = loadModule();
  if (!mod) return "unavailable";
  const perm = await mod.requestPermissionsAsync();
  if (!perm.granted) return "denied";
  await AsyncStorage.setItem(enabledKey(userId), "1");
  await upload(userId, mod);
  return "granted";
}

/** On app open: re-sync at most once a week, only if the user turned it on and permission is still granted. */
export async function syncContactsIfDue(userId: string): Promise<void> {
  try {
    const mod = loadModule();
    if (!mod) return;
    if ((await AsyncStorage.getItem(enabledKey(userId))) !== "1") return;
    const last = Number(await AsyncStorage.getItem(keyOf(userId)));
    if (!shouldResync(Number.isFinite(last) && last > 0 ? last : null, Date.now())) return;
    const perm = await mod.getPermissionsAsync();
    if (!perm.granted) return;
    await upload(userId, mod);
  } catch {
    // never blocks the app
  }
}

export async function removeContactsData(userId: string): Promise<boolean> {
  const { error } = await supabase.rpc("remove_my_contacts");
  await AsyncStorage.multiRemove([keyOf(userId), enabledKey(userId)]).catch(() => {});
  return !error;
}

export async function isContactsEnabled(userId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(enabledKey(userId))) === "1";
}

export type InviteContact = { id: string; name: string; number: string };

/**
 * The names and numbers the "Invite" list shows: read on the phone when the person taps "Choose from contacts", kept in
 * memory only and never uploaded (this is not the contacts sync above). Asks the system for permission; a person who says no
 * still has the invite link and username search.
 */
export async function listContactsToInvite(): Promise<{ status: "ok" | "denied" | "unavailable"; contacts: InviteContact[] }> {
  const mod = loadModule();
  if (!mod) return { status: "unavailable", contacts: [] };
  const perm = await mod.requestPermissionsAsync();
  if (!perm.granted) return { status: "denied", contacts: [] };
  const region = deviceRegion();
  const out: InviteContact[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const res = await mod.getContactsAsync({ fields: [mod.Fields.PhoneNumbers, mod.Fields.Name ?? "name"], pageSize: 500, pageOffset: offset });
    for (const c of res.data) {
      const number = collectNumbers([c], region)[0];
      if (number && c.name) out.push({ id: c.id ?? `${c.name}:${number}`, name: c.name, number });
    }
    if (!res.hasNextPage) break;
    offset += 500;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { status: "ok", contacts: out };
}
