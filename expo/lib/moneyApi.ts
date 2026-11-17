/** The app's side of migration-money-board.sql: every write goes through a database function, every read through a policy that needs money_ready(). */
import { supabase } from "@/lib/supabase";
import type { CampaignArgs, CampaignRow, CreatorStats } from "@/lib/moneyCampaign";
import type { MoneyRole } from "@/lib/moneyContent";

/** Every column the card needs. NOT payment_handle (apps cannot select it; members get it through campaign_payment_info). */
export const CAMPAIGN_COLUMNS =
  "id, creator_id, title, description, full_video_url, rate_per_1k, cap_per_clip, total_budget, guaranteed_per_clip, platforms, view_window_days, min_views, payment_method, deadline, max_clips_per_clipper, status, terms_frozen_at, budget_committed, budget_left, created_at";

export type MoneyProfile = {
  allowed: boolean; ready: boolean; role: MoneyRole | null; needs_onboarding: boolean; banned: boolean;
  agreement_version: number | null; current_agreement_version: number | null;
};
export type Creator = { id: string; username: string; avatar_url: string | null };
export type CampaignWithCreator = { row: CampaignRow; creator: Creator | null; stats: CreatorStats };

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchMoneyProfile = () => rpc<MoneyProfile>("my_money_profile");
export const completeOnboarding = (role: MoneyRole, rules: string[]) => rpc<MoneyProfile>("money_complete_onboarding", { p_role: role, p_rules: rules });
export const createCampaign = (args: CampaignArgs) => rpc<string>("money_create_campaign_with_footage", args as unknown as Record<string, unknown>);
export const joinCampaign = (id: string) => rpc<void>("money_join_campaign", { p_campaign: id, p_agree: true });
export const setCampaignStatus = (id: string, status: "open" | "paused" | "closed") => rpc<void>("money_set_campaign_status", { p_campaign: id, p_status: status });
export const campaignPaymentInfo = (id: string) => rpc<{ payment_method: string; payment_handle: string }>("campaign_payment_info", { p_campaign: id });
export const creatorStats = (userId: string) => rpc<CreatorStats>("money_profile_stats", { p_user: userId });

async function withCreators(rows: CampaignRow[]): Promise<CampaignWithCreator[]> {
  const ids = [...new Set(rows.map((r) => r.creator_id))];
  const creators = new Map<string, Creator>();
  const stats = new Map<string, CreatorStats>();
  if (ids.length) {
    const { data } = await supabase.from("profiles").select("id, username, avatar_url").in("id", ids);
    for (const p of (data ?? []) as Creator[]) creators.set(p.id, p);
    await Promise.all(ids.map(async (id) => { try { stats.set(id, await creatorStats(id)); } catch { stats.set(id, null); } }));
  }
  return rows.map((row) => ({ row, creator: creators.get(row.creator_id) ?? null, stats: stats.get(row.creator_id) ?? null }));
}

/** Browse: what the database lets this person see (open, before the deadline, no block between us). Own and joined campaigns are not listed here. */
export async function browseCampaigns(myId: string): Promise<CampaignWithCreator[]> {
  const { data, error } = await supabase.from("campaigns").select(CAMPAIGN_COLUMNS).eq("status", "open").gt("deadline", new Date().toISOString()).neq("creator_id", myId).order("created_at", { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return withCreators((data ?? []) as unknown as CampaignRow[]);
}

export async function myCampaigns(myId: string): Promise<CampaignRow[]> {
  const { data, error } = await supabase.from("campaigns").select(CAMPAIGN_COLUMNS).eq("creator_id", myId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CampaignRow[];
}

export async function myJoinedCampaigns(myId: string): Promise<CampaignWithCreator[]> {
  const { data: mem, error } = await supabase.from("campaign_members").select("campaign_id, joined_at").eq("clipper_id", myId).order("joined_at", { ascending: false });
  if (error) throw new Error(error.message);
  const ids = (mem ?? []).map((m) => (m as { campaign_id: string }).campaign_id);
  if (!ids.length) return [];
  const { data, error: e2 } = await supabase.from("campaigns").select(CAMPAIGN_COLUMNS).in("id", ids);
  if (e2) throw new Error(e2.message);
  const byId = new Map(((data ?? []) as unknown as CampaignRow[]).map((r) => [r.id, r]));
  return withCreators(ids.map((id) => byId.get(id)).filter((r): r is CampaignRow => !!r));
}

export async function campaignDetail(id: string, myId: string): Promise<{ item: CampaignWithCreator; joined: boolean; mine: boolean } | null> {
  const { data, error } = await supabase.from("campaigns").select(CAMPAIGN_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as unknown as CampaignRow;
  const [item] = await withCreators([row]);
  const { data: mem } = await supabase.from("campaign_members").select("campaign_id").eq("campaign_id", id).eq("clipper_id", myId).maybeSingle();
  return { item, joined: !!mem, mine: row.creator_id === myId };
}

export async function joinedCount(campaignId: string): Promise<number> {
  const { count } = await supabase.from("campaign_members").select("campaign_id", { count: "exact", head: true }).eq("campaign_id", campaignId);
  return count ?? 0;
}

export type MoneyReportTarget = "campaign" | "submission" | "money_review" | "money_user" | "footage";
export async function reportMoney(reporterId: string, type: MoneyReportTarget, targetId: string, reason: "spam" | "harassment" | "nudity" | "other"): Promise<void> {
  const { error } = await supabase.from("reports").insert({ reporter_id: reporterId, target_type: type, target_id: targetId, reason });
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
}

export type FootageRow = { id: string; duration_seconds: number | string; width: number; height: number; thumb_ok: boolean; thumb_path: string; storage_path: string; sort_order: number };
/** The campaign's ready videos: the creator and the clippers who joined can read them (the table policy), nobody else. */
export async function campaignFootage(campaignId: string): Promise<FootageRow[]> {
  const { data, error } = await supabase.from("campaign_footage").select("id, duration_seconds, width, height, thumb_ok, thumb_path, storage_path, sort_order").eq("campaign_id", campaignId).eq("status", "ready").order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as FootageRow[];
}

/** The creator's optional Google Drive / Dropbox link: only the creator and the clippers who joined get it (it is not a readable column). */
export const campaignFootageLink = (campaignId: string) => rpc<string | null>("campaign_footage_link", { p_campaign: campaignId });
