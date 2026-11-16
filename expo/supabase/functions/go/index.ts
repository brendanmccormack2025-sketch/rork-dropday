// The tracked short link for "Watch on <platform>": GET /functions/v1/go/<code>. See core.ts and supabase/migration-post-links.sql.
// Deploy:  supabase functions deploy go --no-verify-jwt     (a browser opens it, so it cannot carry a login; listed in supabase/FUNCTIONS.txt for ship.sh)
// Secret:  supabase secrets set LINK_SALT=<a long random value>    (without it links still redirect, but taps are not counted)
// It reads the address and records the tap with the service role the platform provides; neither function is callable by apps.
import { handle } from "./core.ts";

const base = Deno.env.get("SUPABASE_URL") ?? "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

Deno.serve((req: Request) =>
  handle(req, {
    salt: Deno.env.get("LINK_SALT") ?? null,
    lookup: async (code) => {
      const rows = await rpc<Array<{ url: string }>>("link_target", { p_code: code });
      return rows && rows[0] ? { url: rows[0].url } : null;
    },
    record: async (code, fp) => (await rpc<boolean>("record_link_tap", { p_code: code, p_fp: fp })) === true,
  }),
);
