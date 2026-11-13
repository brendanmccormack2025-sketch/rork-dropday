/** What the server says about Money for the signed-in person (my_features). Nothing client-side decides this. */
import { supabase } from "@/lib/supabase";
import { birthdateServerError, type AgeTier } from "@/lib/birthdate";

export type MyFeatures = { money: boolean; needs_birthdate: boolean; allowed: boolean };

export const NO_FEATURES: MyFeatures = { money: false, needs_birthdate: false, allowed: false };

/** Parse the my_features() payload defensively: anything missing or odd is "off". */
export function parseFeatures(raw: unknown): MyFeatures {
  if (!raw || typeof raw !== "object") return NO_FEATURES;
  const r = raw as Record<string, unknown>;
  return { money: r.money === true, needs_birthdate: r.needs_birthdate === true, allowed: r.allowed === true };
}

export async function fetchMyFeatures(): Promise<MyFeatures> {
  try {
    const { data, error } = await supabase.rpc("my_features");
    if (error) {
      console.log("[money] my_features failed", error.message);
      return NO_FEATURES;
    }
    return parseFeatures(data);
  } catch (e) {
    console.log("[money] my_features threw", (e as Error)?.message);
    return NO_FEATURES;
  }
}

/** Save my birthdate (once). Returns the age tier, or an error message to show. */
export async function saveMyBirthdate(iso: string): Promise<{ tier: AgeTier } | { error: string }> {
  try {
    const { data, error } = await supabase.rpc("set_my_birthdate", { p_birthdate: iso });
    if (error) {
      console.log("[money] set_my_birthdate failed", error.message);
      return { error: birthdateServerError(error.message) };
    }
    return { tier: data as AgeTier };
  } catch (e) {
    console.log("[money] set_my_birthdate threw", (e as Error)?.message);
    return { error: birthdateServerError(null) };
  }
}
