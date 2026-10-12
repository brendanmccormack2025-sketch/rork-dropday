// Deletes the Storage files queued by trial_hide_post() (posts that ended or stayed incomplete, and their reactions).
// Deploy:   done by expo/ship.sh (npx supabase functions deploy delete-media --project-ref tfdjymogbtfavdzgfqas)
// Dry run:  POST /functions/v1/delete-media            (lists what it would delete; deletes nothing)
// Delete:   POST /functions/v1/delete-media?run=1      (removes the files, marks the queue rows done)
// Only a service-level key may call it (Authorization: Bearer <key>): the legacy service_role JWT or a new sb_secret_ key.
// The function checks the caller itself, so it is deployed with --no-verify-jwt (the gateway's JWT check would reject sb_secret_ keys).
// Schedule: applied by ship.sh (supabase/schedule-delete-media.sql, see supabase/FUNCTIONS.txt).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Is this bearer a service-level key? Exact match with the function's own key, or (for the other key kind / a rotated key)
// proof by use: only a service-level key may call the Auth admin API.
async function isServiceKey(bearer: string): Promise<boolean> {
  if (!bearer) return false;
  const own = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (own && bearer === own) return true;
  if (!/^(sb_secret_|eyJ)/.test(bearer)) return false;
  const probe = createClient(Deno.env.get("SUPABASE_URL") ?? "", bearer, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!(await isServiceKey(bearer))) return new Response("forbidden", { status: 403 });
  const run = new URL(req.url).searchParams.get("run") === "1";
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", bearer, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: rows, error } = await sb
    .from("trial_media_delete_queue")
    .select("id, bucket, path")
    .is("deleted_at", null)
    .order("id")
    .limit(500);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const byBucket = new Map<string, { id: number; path: string }[]>();
  for (const r of rows ?? []) {
    const list = byBucket.get(r.bucket) ?? [];
    list.push({ id: r.id, path: r.path });
    byBucket.set(r.bucket, list);
  }
  const summary: Record<string, number> = {};
  for (const [bucket, list] of byBucket) summary[bucket] = list.length;
  if (!run) return new Response(JSON.stringify({ dryRun: true, wouldDelete: summary }), { headers: { "content-type": "application/json" } });

  let deleted = 0;
  let failed = 0;
  for (const [bucket, list] of byBucket) {
    const { error: rmError } = await sb.storage.from(bucket).remove(list.map((f) => f.path));
    const ids = list.map((f) => f.id);
    if (rmError) {
      failed += ids.length;
      await sb.from("trial_media_delete_queue").update({ error: rmError.message }).in("id", ids);
    } else {
      deleted += ids.length;
      await sb.from("trial_media_delete_queue").update({ deleted_at: new Date().toISOString(), error: null }).in("id", ids);
    }
  }
  return new Response(JSON.stringify({ deleted, failed }), { headers: { "content-type": "application/json" } });
});
