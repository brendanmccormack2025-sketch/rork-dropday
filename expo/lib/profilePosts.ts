import { supabase } from "@/lib/supabase";

/**
 * The ids of the posts this viewer may see on a profile, newest first (server-side rules: profile_posts() in
 * migration-survived-profile.sql). null when the function is not deployed yet: the caller then falls back to a direct
 * query with the same rules (lib/profileVisibility.ts).
 */
export async function profilePostIds(userId: string, limit = 100): Promise<string[] | null> {
  try {
    const { data, error } = await (supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    }).rpc("profile_posts", { p_user_id: userId, p_limit: limit });
    if (error) return null;
    return ((data ?? []) as Array<{ post_id: string }>).map((r) => r.post_id);
  } catch {
    return null;
  }
}
