import { supabase } from "@/lib/supabase";
import type { Sanction } from "@/lib/sanctionText";

/** The sanction in force on the signed-in account, or null. The database decides (my_sanction); a failure means "none" so a network error never locks anyone out. */
export async function mySanction(): Promise<Sanction | null> {
  try {
    const { data, error } = await (supabase as unknown as { rpc: (fn: string) => Promise<{ data: unknown; error: unknown }> }).rpc("my_sanction");
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as { kind?: string; until?: string | null } | null | undefined;
    if (!row || (row.kind !== "suspend" && row.kind !== "ban")) return null;
    return { kind: row.kind, until: row.until ?? null };
  } catch {
    return null;
  }
}
