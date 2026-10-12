#!/usr/bin/env node
/**
 * Helpers that need the project's service role key, fetched with the personal access token (Management API) and kept in
 * memory only. The key is never printed.
 *
 *   node scripts/supabase-service.mjs dry-run <function> [extra query, e.g. ?x=1]
 *        calls the Edge Function WITHOUT ?run=1 (the dry run: it lists what it would delete, deletes nothing), prints the answer
 *   node scripts/supabase-service.mjs vault-sync
 *        stores (or refreshes) the service role key in Supabase Vault as `service_role_key`, which the pg_cron job that
 *        calls delete-media reads (see supabase/schedule-delete-media.sql)
 *
 * Needs SUPABASE_ACCESS_TOKEN (sbp_..., whitespace stripped). SUPABASE_API_BASE / SUPABASE_FUNCTIONS_BASE /
 * SUPABASE_PROJECT_REF exist for the tests.
 */
const API = (process.env.SUPABASE_API_BASE || "https://api.supabase.com").replace(/\/+$/, "");
const REF = process.env.SUPABASE_PROJECT_REF || "tfdjymogbtfavdzgfqas";
const FUNCTIONS = (process.env.SUPABASE_FUNCTIONS_BASE || `https://${REF}.supabase.co`).replace(/\/+$/, "");
const token = (process.env.SUPABASE_ACCESS_TOKEN || "").replace(/\s+/g, "");
const [mode, arg, extra = ""] = process.argv.slice(2);

const die = (m, code = 1) => { console.error(m); process.exit(code); };
if (!token) die("SUPABASE_ACCESS_TOKEN is not set");
if (mode !== "dry-run" && mode !== "vault-sync") die("usage: supabase-service.mjs dry-run <function> | vault-sync", 2);

async function call(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    return die(`request failed: ${e?.message || e}`);
  }
}
const messageOf = (text) => {
  try { const j = JSON.parse(text); return j.message || j.error || JSON.stringify(j); } catch { return text.trim().slice(0, 500) || "(empty response)"; }
};

// The service role key (legacy JWT, the one Edge Functions receive as SUPABASE_SERVICE_ROLE_KEY).
const keysRes = await call(`${API}/v1/projects/${REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } });
const keysText = await keysRes.text();
if (!keysRes.ok) die(`could not read the project's API keys (HTTP ${keysRes.status}): ${messageOf(keysText)}`);
let key = "";
try {
  const list = JSON.parse(keysText);
  const hit = (Array.isArray(list) ? list : []).find((k) => k && k.name === "service_role" && typeof k.api_key === "string");
  key = (hit?.api_key || "").replace(/\s+/g, "");
} catch { /* handled below */ }
if (!key) die("the project's service_role key was not found in the API keys response");
if (!/^[A-Za-z0-9._-]+$/.test(key)) die("the service_role key has an unexpected format");

if (mode === "dry-run") {
  if (!arg) die("missing function name", 2);
  const res = await call(`${FUNCTIONS}/functions/v1/${arg}${extra}`, { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) die(`${arg} dry run failed (HTTP ${res.status}): ${messageOf(text)}`);
  console.log(text.trim());
} else {
  // create or refresh the Vault secret (the key is validated above, so it is safe inside the quotes)
  const sql = `do $$ begin
    if exists (select 1 from vault.secrets where name = 'service_role_key') then
      perform vault.update_secret((select id from vault.secrets where name = 'service_role_key' limit 1), new_secret := '${key}');
    else
      perform vault.create_secret('${key}', 'service_role_key');
    end if;
  end $$;`;
  const res = await call(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) die(`could not store the key in Vault (HTTP ${res.status}): ${messageOf(text)}`);
  console.log("service role key stored in Vault as service_role_key");
}
