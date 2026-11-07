import { supabase } from "@/lib/supabase";
import type { DmPolicy, InteractionMode } from "@/lib/safetyText";

/** Every call is a database function that checks who is asking (supabase/migration-harassment.sql). */
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: Rpc = (fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args ?? {});

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
async function rows<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  return ((await call<T[] | null>(fn, args)) ?? []) as T[];
}

export type ReportRow = { report_id: string; target_type: string; target_id: string; reason: string; status: string; created_at: string; reporter_username: string | null; reported_user_id: string | null; reported_username: string | null; preview: string | null; thumbnail_url: string | null; report_count: number };
export type FlagRow = { id: string; user_id: string; username: string | null; target_id: string | null; target_username: string | null; kind: string; detail: Record<string, unknown>; status: string; created_at: string };
export type ReportAction = "dismiss" | "reviewed" | "hide" | "remove";

export const getDmPolicy = async (): Promise<DmPolicy> => ((await rows<{ dm_policy: DmPolicy }>("my_controls"))[0]?.dm_policy ?? "friends");
export const setDmPolicy = (policy: DmPolicy) => call<void>("set_dm_policy", { p_policy: policy });
export const getPostInteractionMode = (post: string) => call<InteractionMode>("my_post_interaction_mode", { p_post: post });
export const setPostInteractions = (post: string, mode: InteractionMode) => call<void>("set_post_interactions", { p_post: post, p_mode: mode });
export const removeReactionOnMyPost = (reaction: string) => call<void>("remove_reaction_on_my_post", { p_reaction: reaction });

export const adminReports = (status = "pending") => rows<ReportRow>("admin_reports_queue", { p_status: status, p_limit: 50 });
export const adminResolveReport = (report: string, action: ReportAction) => call<void>("admin_report_resolve", { p_report: report, p_action: action });
export const adminFlags = (status = "open") => rows<FlagRow>("admin_flags_list", { p_status: status, p_limit: 50 });
export const adminResolveFlag = (flag: string, status: "reviewed" | "dismissed") => call<void>("admin_flag_resolve", { p_flag: flag, p_status: status });
export const adminTerms = async () => (await rows<{ term: string }>("admin_filter_terms")).map((r) => r.term);
export const adminAddTerm = (term: string) => call<void>("admin_filter_add", { p_term: term });
export const adminRemoveTerm = (term: string) => call<void>("admin_filter_remove", { p_term: term });
