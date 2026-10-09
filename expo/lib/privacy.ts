import { supabase } from "@/lib/supabase";
import { deviceRegion } from "@/lib/contacts";
import { normalizeE164 } from "@/lib/phone";

export type PrivacyStatus = { has_phone: boolean; contacts_count: number; contacts_synced_at: string | null };

export async function getPrivacyStatus(): Promise<PrivacyStatus | null> {
  const { data, error } = await supabase.rpc("my_privacy_status");
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as PrivacyStatus | undefined;
  return row ?? null;
}

/** Normalises on the phone, then the server hashes it. Returns an error message or null. */
export async function savePhone(raw: string): Promise<string | null> {
  const e164 = normalizeE164(raw, deviceRegion());
  if (!e164) return "Enter a full phone number, including the country code (for example +1 415 555 2671).";
  const { error } = await supabase.rpc("set_my_phone", { p_e164: e164 });
  return error ? "Couldn't save your number. Try again." : null;
}

export async function removePhone(): Promise<boolean> {
  const { error } = await supabase.rpc("clear_my_phone");
  return !error;
}
