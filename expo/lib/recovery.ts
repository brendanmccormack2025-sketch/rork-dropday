import { supabase } from "@/lib/supabase";

/** Every call is a database function that checks who is asking (supabase/migration-recovery.sql). */
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: Rpc = (fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args ?? {});

export type RecoveryOffer = { offer_id: string; status: string; created_at: string; expires_at: string | null; boost_hours: number; boost_max_viewers: number };
export type AdminRecovery = { id: string; creator_id: string; creator_username: string | null; source: string; status: string; created_at: string; accepted_at: string | null; boost_post_id: string | null; boost_ends_at: string | null; boosted_viewers: number };

export async function myRecoveryOffer(): Promise<RecoveryOffer | null> {
  const { data, error } = await rpc("my_recovery_offer");
  if (error) throw new Error(error.message);
  return ((data ?? []) as RecoveryOffer[])[0] ?? null;
}
export async function respondRecovery(offer: string, accept: boolean): Promise<string> {
  const { data, error } = await rpc("respond_recovery_offer", { p_offer: offer, p_accept: accept });
  if (error) throw new Error(error.message);
  return String(data);
}
export async function adminRecovery(): Promise<AdminRecovery[]> {
  const { data, error } = await rpc("admin_recovery_list", { p_limit: 50 });
  if (error) throw new Error(error.message);
  return (data ?? []) as AdminRecovery[];
}
