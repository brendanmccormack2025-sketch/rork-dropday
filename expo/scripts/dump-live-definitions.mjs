#!/usr/bin/env node
/**
 * Writes supabase/migration-live-snapshot.sql: the definitions that were applied by hand to the LIVE database and are not in
 * the repo (get_feed_engine, expire_posts, chat_can_send_post, chat_post_available, the compat views conversations and
 * messages with their INSTEAD OF triggers), read from the database itself with pg_get_functiondef / pg_get_viewdef /
 * pg_get_triggerdef. READ ONLY: it only runs SELECTs through the Supabase Management API, like scripts/supabase-sql.mjs.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/dump-live-definitions.mjs            writes supabase/migration-live-snapshot.sql
 *   node scripts/dump-live-definitions.mjs --dry                                      prints it instead of writing
 *   node scripts/dump-live-definitions.mjs --functions a,b --views c                  more objects (they must exist)
 *   node scripts/dump-live-definitions.mjs --out <file> --order <file>                 other paths (the tests use them)
 *
 * Why: ship.sh re-runs the migrations in supabase/MIGRATIONS_ORDER.txt on every release, and several of them define OLDER
 * versions of these objects. The snapshot is listed right before migration-known-connections.sql (which stays last), so the
 * live version is always the last one applied. The script adds that line to MIGRATIONS_ORDER.txt (once). Every statement is
 * idempotent (create or replace / drop trigger if exists), and a view is skipped when a real table has its name.
 * The token comes from SUPABASE_ACCESS_TOKEN (whitespace stripped) and is never printed. Exit 1 on an API error, 2 on bad
 * usage or when a required object is missing (nothing is written then).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.SUPABASE_API_BASE || "https://api.supabase.com").replace(/\/+$/, "");
const REF = process.env.SUPABASE_PROJECT_REF || "tfdjymogbtfavdzgfqas";
const TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || "").replace(/\s+/g, "");
const OUT = "supabase/migration-live-snapshot.sql";
const ORDER = "supabase/MIGRATIONS_ORDER.txt";
const SNAPSHOT_NAME = "migration-live-snapshot.sql";

export const REQUIRED_FUNCTIONS = ["get_feed_engine", "expire_posts", "chat_can_send_post", "chat_post_available"];
export const REQUIRED_VIEWS = ["conversations", "messages"];
export const REQUIRED_TRIGGERS = ["compat_conversations_insert", "compat_messages_insert"];
const ROLES = ["anon", "authenticated", "service_role"];

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const sqlList = (names) => `array[${names.map((n) => `'${n.replace(/[^A-Za-z0-9_]/g, "")}'`).join(", ")}]::text[]`;

/** The three read-only queries. Exported so the test can run them on a scratch database. */
export function queries(functions, views) {
  const viewList = sqlList(views);
  return {
    functions: `
      select p.proname::text as name,
             'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
             pg_get_functiondef(p.oid) as def,
             coalesce((select json_agg(distinct case when a.grantee = 0 then 'public' else r.rolname::text end)
                         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         left join pg_roles r on r.oid = a.grantee
                        where a.privilege_type = 'EXECUTE'), '[]'::json) as grantees
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
         and (p.proname = any(${sqlList(functions)})
              or p.oid in (select t.tgfoid from pg_trigger t join pg_class c on c.oid = t.tgrelid
                            where c.relnamespace = 'public'::regnamespace and c.relname = any(${viewList}) and not t.tgisinternal))
       order by 1, 2`,
    views: `
      select c.relname::text as name, c.relkind::text as kind, pg_get_viewdef(c.oid, true) as def,
             coalesce(c.reloptions, '{}'::text[]) as options,
             coalesce((select json_agg(json_build_object('role', r.rolname::text, 'privilege', a.privilege_type))
                         from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                         join pg_roles r on r.oid = a.grantee), '[]'::json) as grants
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname = any(${viewList})
       order by 1`,
    triggers: `
      select c.relname::text as rel, t.tgname::text as name, pg_get_triggerdef(t.oid, true) as def
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'public'::regnamespace and c.relname = any(${viewList}) and not t.tgisinternal
       order by 1, 2`,
  };
}

/** The snapshot file's text from the rows the queries returned. Throws (code 2) when a required object is missing. */
export function buildSnapshot({ functions, views, triggers }, { requiredFunctions, requiredViews, requiredTriggers, ref = REF, today = new Date().toISOString().slice(0, 10) }) {
  const missing = [];
  for (const f of requiredFunctions) if (!functions.some((r) => r.name === f)) missing.push(`function ${f}`);
  for (const v of requiredViews) if (!views.some((r) => r.name === v)) missing.push(`view ${v}`);
  for (const t of requiredTriggers) if (!triggers.some((r) => r.name === t)) missing.push(`trigger ${t}`);
  if (missing.length) {
    const e = new Error(`not found in the live database: ${missing.join(", ")}`);
    e.code = 2;
    throw e;
  }
  const out = [];
  out.push(`-- Tryal: the live database's own definitions of what was applied by hand (generated by scripts/dump-live-definitions.mjs, ${today}, project ${ref}).
-- DO NOT EDIT BY HAND: this file is the RECORD of what was live. Fix things in a newer migration that is ordered after it.
-- It is listed in MIGRATIONS_ORDER.txt right before migration-known-connections.sql, so every release re-applies the live version
-- AFTER the older migrations that define earlier versions of the same objects. Idempotent: create or replace / drop trigger if exists.
-- Contents: ${[...new Set(functions.map((f) => f.name))].join(", ")}; views ${views.map((v) => v.name).join(", ")}; triggers ${triggers.map((t) => t.name).join(", ")}.
`);
  const fnSql = (f) => {
    const granted = new Set(f.grantees ?? []);
    const lines = [f.def.trim().replace(/;?$/, ";"), `revoke all on function ${f.sig} from public, anon, authenticated, service_role;`];
    const to = ROLES.filter((r) => granted.has(r));
    if (granted.has("public")) to.unshift("public");
    if (to.length) lines.push(`grant execute on function ${f.sig} to ${to.join(", ")};`);
    return lines.join("\n");
  };
  // trigger functions first (the triggers need them), then everything else
  const triggerFnNames = new Set();
  for (const f of functions) if (!requiredFunctions.includes(f.name)) triggerFnNames.add(f.name);
  const ordered = [...functions.filter((f) => triggerFnNames.has(f.name)), ...functions.filter((f) => !triggerFnNames.has(f.name))];
  out.push("-- ── functions ──");
  for (const f of ordered) out.push(fnSql(f), "");
  out.push("-- ── views ──");
  for (const v of views) {
    const body = v.def.trim().replace(/;+\s*$/, "");
    const kind = v.kind === "m" ? "materialized view" : "view";
    if (kind !== "view") {
      out.push(`-- ${v.name} is a materialized view in the live database: not recreated here (create or replace cannot).`, "");
      continue;
    }
    out.push(`do $snap_view$
begin
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = '${v.name}' and c.relkind in ('r', 'p')) then
    raise notice 'public.${v.name} is a table here: the view definition is not applied';
  else
    execute $snap_def$create or replace view public.${v.name} as
${body}$snap_def$;
  end if;
end $snap_view$;`);
    for (const opt of v.options ?? []) {
      if (/^[a-z_]+=[A-Za-z0-9_]+$/.test(opt)) out.push(`do $snap_opt$ begin if (select c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = '${v.name}') = 'v' then alter view public.${v.name} set (${opt}); end if; end $snap_opt$;`);
    }
    out.push(`revoke all on public.${v.name} from anon, authenticated, service_role;`);
    const privs = new Map();
    for (const g of v.grants ?? []) if (ROLES.includes(g.role)) privs.set(g.role, [...(privs.get(g.role) ?? []), g.privilege]);
    for (const [role, list] of privs) out.push(`grant ${[...new Set(list)].join(", ")} on public.${v.name} to ${role};`);
    out.push("");
  }
  out.push("-- ── triggers ──");
  for (const t of triggers) {
    // only where the name is a view (INSTEAD OF triggers exist only on views)
    out.push(`do $snap_trg$
begin
  if (select c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = '${t.rel}') = 'v' then
    drop trigger if exists "${t.name}" on public.${t.rel};
    execute $snap_def$${t.def.trim().replace(/;$/, "")}$snap_def$;
  end if;
end $snap_trg$;`, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** MIGRATIONS_ORDER.txt text with the snapshot listed right before migration-known-connections.sql (once). */
export function withSnapshotInOrder(text) {
  const lines = text.split("\n");
  if (lines.some((l) => l.trim() === SNAPSHOT_NAME)) return text;
  const i = lines.findIndex((l) => l.trim() === "migration-known-connections.sql");
  if (i < 0) throw Object.assign(new Error("migration-known-connections.sql is not listed in MIGRATIONS_ORDER.txt"), { code: 2 });
  lines.splice(i, 0, SNAPSHOT_NAME);
  return lines.join("\n");
}

async function run(sql) {
  let res;
  try {
    res = await fetch(`${BASE}/v1/projects/${REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    die(`request failed: ${e?.message || e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.trim().slice(0, 1000);
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error || msg;
    } catch {
      /* plain text */
    }
    die(`API error (HTTP ${res.status}): ${msg}`);
  }
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return die("the API answered something that is not JSON");
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  };
  for (const a of args) if (a.startsWith("--") && !["--dry", "--functions", "--views", "--out", "--order"].includes(a)) die(`unknown option ${a}`, 2);
  const outFile = opt("--out")[0] ?? join(root, OUT);
  const orderFile = opt("--order")[0] ?? join(root, ORDER);
  if (!TOKEN) die("SUPABASE_ACCESS_TOKEN is not set", 2);
  const extraFns = opt("--functions");
  const extraViews = opt("--views");
  const q = queries([...REQUIRED_FUNCTIONS, ...extraFns], [...REQUIRED_VIEWS, ...extraViews]);
  const rows = { functions: await run(q.functions), views: await run(q.views), triggers: await run(q.triggers) };
  let text;
  try {
    text = buildSnapshot(rows, { requiredFunctions: [...REQUIRED_FUNCTIONS, ...extraFns], requiredViews: [...REQUIRED_VIEWS, ...extraViews], requiredTriggers: REQUIRED_TRIGGERS });
  } catch (e) {
    die(`${e.message}\nNothing was written.`, e.code ?? 1);
  }
  if (dry) {
    process.stdout.write(text);
  } else {
    const order = readFileSync(orderFile, "utf8");
    let next;
    try {
      next = withSnapshotInOrder(order);   // before anything is written: the order file must be as expected
    } catch (e) {
      die(`${e.message}\nNothing was written.`, e.code ?? 1);
    }
    writeFileSync(outFile, text);
    if (next !== order) writeFileSync(orderFile, next);
    console.log(`wrote ${OUT} (${text.length} bytes; ${rows.functions.length} functions, ${rows.views.length} views, ${rows.triggers.length} triggers)`);
    console.log(next !== order ? `listed ${SNAPSHOT_NAME} in ${ORDER} (before migration-known-connections.sql)` : `${ORDER} already lists it`);
    console.log("Next: review the file, then   git add expo/supabase/migration-live-snapshot.sql expo/supabase/MIGRATIONS_ORDER.txt && git commit && git push");
  }
}
