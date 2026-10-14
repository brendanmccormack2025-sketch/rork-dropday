// Sends Expo push notifications for rows in public.notifications.
// Deploy:   done by expo/ship.sh (see supabase/FUNCTIONS.txt). Scheduled every minute by supabase/schedule-send-push.sql.
// Dry run:  POST /functions/v1/send-push            (claims nothing, sends nothing: shows how many rows are waiting)
// Send:     POST /functions/v1/send-push?run=1      (claims rows, sends, records the results, checks receipts)
// Only a service-level key may call it (Authorization: Bearer <key>), like delete-media; deployed with --no-verify-jwt.
// Optional secret EXPO_ACCESS_TOKEN (Expo "enhanced push security"): supabase secrets set EXPO_ACCESS_TOKEN=... (sent as a bearer).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildPushes, chunk, interpretReceipts, interpretTickets, toExpoMessages, type ClaimedRow, type Receipt, type Ticket } from "./map.ts";

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";

async function isServiceKey(bearer: string): Promise<boolean> {
  if (!bearer) return false;
  const own = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (own && bearer === own) return true;
  if (!/^(sb_secret_|eyJ)/.test(bearer)) return false;
  const probe = createClient(Deno.env.get("SUPABASE_URL") ?? "", bearer, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

function expoHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", "accept-encoding": "gzip, deflate", "content-type": "application/json" };
  const token = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; json?: { data?: unknown }; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: expoHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `Expo HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: `Expo request failed: ${(e as Error)?.message ?? e}` };
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!(await isServiceKey(bearer))) return new Response("forbidden", { status: 403 });
  const run = new URL(req.url).searchParams.get("run") === "1";
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", bearer, { auth: { persistSession: false, autoRefreshToken: false } });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  if (!run) {
    const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).is("push_sent_at", null).is("push_skip_reason", null);
    return json({ dryRun: true, waiting: count ?? 0 });
  }

  const summary = { claimed: 0, pushes: 0, messages: 0, sent: 0, retried: 0, skipped: 0, tokensRemoved: 0, receiptsChecked: 0, errors: [] as string[] };

  // 1. receipts of earlier tickets: this is where most DeviceNotRegistered answers arrive
  try {
    const { data: due } = await sb.rpc("push_due_tickets", { p_limit: 300 });
    const tickets = (due ?? []) as Array<{ ticket_id: string; token: string }>;
    if (tickets.length > 0) {
      const res = await post(EXPO_RECEIPTS, { ids: tickets.map((t) => t.ticket_id) });
      if (res.ok) {
        const { removeTokens, finished } = interpretReceipts(tickets, ((res.json?.data ?? {}) as Record<string, Receipt>));
        if (removeTokens.length) {
          const { data: n } = await sb.rpc("push_remove_tokens", { p_tokens: removeTokens });
          summary.tokensRemoved += Number(n ?? 0);
        }
        if (finished.length) await sb.rpc("push_finish_tickets", { p_ids: finished });
        summary.receiptsChecked = finished.length;
      } else summary.errors.push(res.error ?? "receipts failed");
    }
  } catch (e) {
    summary.errors.push(`receipts: ${(e as Error)?.message ?? e}`);
  }

  // 2. new notifications
  const { data: claimed, error } = await sb.rpc("push_claim_batch", { p_limit: 200 });
  if (error) return json({ ...summary, error: error.message }, 500);
  const rows = (claimed ?? []) as ClaimedRow[];
  summary.claimed = rows.length;
  const pushes = buildPushes(rows);
  summary.pushes = pushes.length;
  const messages = toExpoMessages(pushes);
  summary.messages = messages.length;

  for (const part of chunk(messages, 100)) {
    const res = await post(EXPO_SEND, part.map((m) => m.message));
    const tickets = res.ok ? ((res.json?.data ?? null) as Ticket[] | null) : null;
    const out = interpretTickets(part, Array.isArray(tickets) ? tickets : null, res.error);
    if (out.sent.length) await sb.rpc("push_mark_sent", { p_ids: out.sent });
    for (const r of out.retry) await sb.rpc("push_mark_retry", { p_ids: r.ids, p_error: r.error });
    if (out.skipped.length) await sb.rpc("push_mark_skipped", { p_ids: out.skipped, p_reason: "every token was invalid" });
    if (out.removeTokens.length) {
      const { data: n } = await sb.rpc("push_remove_tokens", { p_tokens: [...new Set(out.removeTokens)] });
      summary.tokensRemoved += Number(n ?? 0);
    }
    if (out.tickets.length) await sb.rpc("push_save_tickets", { p_tickets: out.tickets });
    summary.sent += out.sent.length;
    summary.retried += out.retry.reduce((n, r) => n + r.ids.length, 0);
    summary.skipped += out.skipped.length;
    if (res.error) summary.errors.push(res.error);
  }
  return json(summary);
});
