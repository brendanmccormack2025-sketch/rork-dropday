import { supabase } from "@/lib/supabase";
import type { SpotlightChoice } from "@/lib/spotlightText";

/** Every call goes to a database function that decides who may see what (supabase/migration-spotlight.sql). */
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: Rpc = (fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args ?? {});

async function rows<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export type SpotlightItem = { pick_id: string; category: string; creator_id: string; username: string; display_name: string | null; avatar_url: string | null; post_id: string; thumbnail_url: string | null; ends_at: string };
export type SpotlightBadgeRow = { category: string; starts_at: string; active: boolean };
export type SpotlightOffer = { pick_id: string; category: string; post_id: string; thumbnail_url: string | null; status: string; created_at: string; expires_at: string | null };
export type AdminCreator = { id: string; username: string; display_name: string | null; avatar_url: string | null; survived_posts: number; last_pick_at: string | null; next_eligible_at: string | null };
export type AdminPost = { post_id: string; caption: string | null; thumbnail_url: string | null; survived_at: string; likes: number };
export type AdminPick = { id: string; creator_id: string; username: string | null; post_id: string; category: string; status: string; created_at: string; responded_at: string | null; starts_at: string | null; ends_at: string | null };

export const getSpotlight = (limit = 10) => rows<SpotlightItem>("get_spotlight", { p_limit: limit });
export const profileSpotlight = async (userId: string): Promise<SpotlightBadgeRow | null> => (await rows<SpotlightBadgeRow>("profile_spotlight", { p_user_id: userId }))[0] ?? null;
export const myOffers = () => rows<SpotlightOffer>("my_spotlight_offers");
export async function respondToOffer(pick: string, choice: SpotlightChoice): Promise<string> {
  const { data, error } = await rpc("respond_spotlight_offer", { p_pick: pick, p_choice: choice });
  if (error) throw new Error(error.message);
  return String(data);
}

export const adminCreators = (query: string) => rows<AdminCreator>("admin_spotlight_creators", { p_query: query, p_limit: 20 });
export const adminPosts = (creator: string) => rows<AdminPost>("admin_spotlight_posts", { p_creator: creator });
export const adminList = () => rows<AdminPick>("admin_spotlight_list", { p_limit: 50 });
export async function adminOffer(creator: string, post: string, category: string): Promise<string> {
  const { data, error } = await rpc("admin_spotlight_offer", { p_creator: creator, p_post: post, p_category: category });
  if (error) throw new Error(error.message);
  return String(data);
}
export async function adminWithdraw(pick: string): Promise<void> {
  const { error } = await rpc("admin_spotlight_withdraw", { p_pick: pick });
  if (error) throw new Error(error.message);
}

/** A thumbnail path or URL as something an Image can show. */
export function thumbUri(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  return supabase.storage.from("drops").getPublicUrl(raw).data?.publicUrl ?? null;
}
