#!/usr/bin/env node
/**
 * scripts/dump-live-definitions.mjs, run for real: a scratch PostgreSQL stands in for the live database (objects shaped like
 * the hand-applied ones), a small local server plays the Supabase Management API in front of it, and the generated
 * migration is applied to a second, empty database twice. Checks that the snapshot is read-only, complete, idempotent and
 * faithful (same function bodies, grants, views, INSTEAD OF triggers), that a missing object stops it before anything is
 * written, that the token is never printed, and that MIGRATIONS_ORDER.txt gets the line once, before known-connections.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-dump-live.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, chownSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, queries, withSnapshotInOrder, REQUIRED_FUNCTIONS, REQUIRED_TRIGGERS, REQUIRED_VIEWS } from "./dump-live-definitions.mjs";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const here = new URL(".", import.meta.url).pathname;
const script = join(here, "dump-live-definitions.mjs");

// ── pure parts (always) ──
{
  const base = "a.sql\nmigration-friends-messages.sql\nmigration-push.sql\nmigration-known-connections.sql\n\n# tail\n";
  const once = withSnapshotInOrder(base);
  eq("the snapshot is listed right before known-connections (which stays last), once", [once.split("\n").filter((l) => l && !l.startsWith("#")).slice(-3), withSnapshotInOrder(once) === once], [["migration-push.sql", "migration-live-snapshot.sql", "migration-known-connections.sql"], true]);
  let err = null;
  try { withSnapshotInOrder("a.sql\n"); } catch (e) { err = e.code; }
  eq("an order file without known-connections is refused", err, 2);
  const sql = Object.values(queries(REQUIRED_FUNCTIONS, REQUIRED_VIEWS)).join("\n");
  ok("every query is a plain SELECT (the dump can never change the database)", Object.values(queries(REQUIRED_FUNCTIONS, REQUIRED_VIEWS)).every((q) => /^\s*select\b/i.test(q)) && !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\s/i.test(sql.replace(/pg_get_[a-z_]+/g, "")));
  ok("names are cleaned before they reach SQL", !/'[^']*;[^']*'/.test(queries(["a'; drop table x; --"], ["v"]).functions));
  const rows = { functions: REQUIRED_FUNCTIONS.map((n) => ({ name: n, sig: `public.${n}()`, def: `CREATE OR REPLACE FUNCTION public.${n}() RETURNS void LANGUAGE sql AS $function$ select 1 $function$\n`, grantees: ["authenticated"] })), views: REQUIRED_VIEWS.map((n) => ({ name: n, kind: "v", def: " SELECT 1 AS x;", options: [], grants: [] })), triggers: REQUIRED_TRIGGERS.map((n, i) => ({ rel: REQUIRED_VIEWS[i], name: n, def: "CREATE TRIGGER x" })) };
  let missing = null;
  try { buildSnapshot({ ...rows, functions: rows.functions.slice(1) }, { requiredFunctions: REQUIRED_FUNCTIONS, requiredViews: REQUIRED_VIEWS, requiredTriggers: REQUIRED_TRIGGERS }); } catch (e) { missing = [e.code, /get_feed_engine/.test(e.message)]; }
  eq("a required object that is not in the live database stops the snapshot (code 2, named)", missing, [2, true]);
}

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/14/bin", "/usr/local/bin", "/usr/bin"].find((d) => existsSync(join(d, "initdb")));
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const run = (cmd, args, opts = {}) => spawnSync(asRoot && opts.asPostgres ? "runuser" : cmd, asRoot && opts.asPostgres ? ["-u", "postgres", "--", cmd, ...args] : args, { encoding: "utf8" });

if (!BIN) {
  console.log("SKIP  PostgreSQL not installed on this machine: the database checks were not run");
} else {
  const dir = mkdtempSync(join(tmpdir(), "pgt-"));
  if (asRoot) chownSync(dir, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
  const data = join(dir, "data");
  const port = String(55300 + Math.floor(Math.random() * 400));
  const initdb = run(join(BIN, "initdb"), ["-D", data, "-A", "trust"], { asPostgres: true });
  const start = run(join(BIN, "pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir}`, "-l", join(dir, "log"), "-w", "start"], { asPostgres: true });
  const psql = (db, sql, extra = []) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-d", db, ...extra, "-c", sql], { encoding: "utf8" });
  const psqlFile = (db, file) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, "-f", file], { encoding: "utf8" });
  const TOKEN = "sbp_TOPSECRETTOKEN0123456789";
  let server = null;
  try {
    if (initdb.status !== 0 || start.status !== 0) {
      console.log("SKIP  could not start a scratch PostgreSQL: the database checks were not run");
    } else {
      for (const db of ["live", "fresh"]) {
        psql("postgres", `create database ${db}`);
        psql(db, `do $$ begin
            if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
          end $$; grant usage on schema public to anon, authenticated, service_role;`);
      }
      // the "live" database: hand-applied objects as they might look
      const liveSetup = join(dir, "live.sql");
      writeFileSync(liveSetup, `
        create table public.chat_conversations (id uuid primary key default gen_random_uuid(), user_a uuid not null, user_b uuid not null, created_at timestamptz default now());
        create table public.chat_messages (id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_id uuid, body text, created_at timestamptz default now());
        create function public.get_feed_engine(p_limit integer default 20, p_offset integer default 0, p_seen uuid[] default '{}')
          returns table (post_id uuid, "position" integer, page_rows integer) language plpgsql security definer set search_path = public as $f$
          begin return query select null::uuid, p_limit + p_offset, coalesce(cardinality(p_seen), 0); end; $f$;
        create function public.expire_posts() returns integer language plpgsql security definer set search_path = public as $f$ begin -- it's "survived posts never expire"
          return 0; end; $f$;
        create function public.chat_can_send_post(p_post_id uuid, p_sender uuid, p_to uuid) returns boolean language sql stable as $f$ select p_sender <> p_to $f$;
        create function public.chat_post_available(p_post_id uuid, p_recipient uuid, p_sender uuid) returns boolean language sql stable as $f$ select true $f$;
        create view public.conversations with (security_invoker = true) as select id, user_a as participant_1_id, user_b as participant_2_id, created_at from public.chat_conversations;
        create view public.messages as select id, conversation_id, sender_id, body as text, created_at from public.chat_messages;
        create function public.compat_conversations_insert_fn() returns trigger language plpgsql as $f$ begin
          insert into public.chat_conversations (id, user_a, user_b) values (coalesce(new.id, gen_random_uuid()), least(new.participant_1_id, new.participant_2_id), greatest(new.participant_1_id, new.participant_2_id)) returning id into new.id; return new; end; $f$;
        create function public.compat_messages_insert_fn() returns trigger language plpgsql as $f$ begin
          insert into public.chat_messages (conversation_id, sender_id, body) values (new.conversation_id, new.sender_id, new.text) returning id into new.id; return new; end; $f$;
        create trigger compat_conversations_insert instead of insert on public.conversations for each row execute function public.compat_conversations_insert_fn();
        create trigger compat_messages_insert instead of insert on public.messages for each row execute function public.compat_messages_insert_fn();
        revoke all on function public.get_feed_engine(integer, integer, uuid[]) from public;
        grant execute on function public.get_feed_engine(integer, integer, uuid[]) to authenticated;
        grant execute on function public.chat_can_send_post(uuid, uuid, uuid) to authenticated, service_role;
        revoke all on function public.expire_posts() from public;
        grant select, insert on public.conversations, public.messages to authenticated;
        grant select on public.messages to anon;`);
      const l = psqlFile("live", liveSetup);
      eq("(setup) the stand-in live database builds", l.status, 0);
      const before = psql("live", "select count(*) from pg_proc where pronamespace='public'::regnamespace").stdout.trim();

      // the Management API stand-in: runs a SELECT on the live database and answers rows as JSON
      let calls = 0, lastAuth = "", mode = "ok";
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          calls++;
          lastAuth = req.headers.authorization ?? "";
          if (lastAuth !== `Bearer ${TOKEN}` || mode === "unauthorized") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "Unauthorized" })); return; }
          const q = JSON.parse(body).query;
          const r = psql("live", `select coalesce(json_agg(t), '[]'::json) from (${q}) t`);
          res.writeHead(r.status === 0 ? 200 : 400, { "content-type": "application/json" });
          res.end(r.status === 0 ? r.stdout.trim() : JSON.stringify({ message: r.stderr }));
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const dump = (args, env = {}) => new Promise((resolve) => {
        const p = spawn("node", [script, ...args], { env: { ...process.env, SUPABASE_API_BASE: base, SUPABASE_ACCESS_TOKEN: ` ${TOKEN}\n`, ...env } });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out, err }));
      });
      const orderFile = join(dir, "MIGRATIONS_ORDER.txt");
      const outFile = join(dir, "migration-live-snapshot.sql");
      writeFileSync(orderFile, "migration-friends-messages.sql\nmigration-push.sql\nmigration-known-connections.sql\n");

      const res = await dump(["--out", outFile, "--order", orderFile]);
      eq("the dump runs (the token has stray whitespace and is trimmed)", [res.code, lastAuth], [0, `Bearer ${TOKEN}`]);
      ok("the token is never printed", !(res.out + res.err).includes("TOPSECRET"));
      const snap = readFileSync(outFile, "utf8");
      ok("the snapshot holds all four functions, both views, both triggers and the trigger functions", [...REQUIRED_FUNCTIONS, ...REQUIRED_VIEWS, ...REQUIRED_TRIGGERS, "compat_conversations_insert_fn", "compat_messages_insert_fn"].every((n) => snap.includes(n)));
      ok("it says what it is and not to edit it", /DO NOT EDIT BY HAND/.test(snap) && /record of what was live/i.test(snap));
      ok("the live function body is kept verbatim, comment and all", /-- it's "survived posts never expire"/.test(snap));
      eq("it only READ the live database (same objects, no writes by the dump)", psql("live", "select count(*) from pg_proc where pronamespace='public'::regnamespace").stdout.trim(), before);
      eq("MIGRATIONS_ORDER.txt now lists the snapshot before known-connections, once", readFileSync(orderFile, "utf8").trim().split("\n"), ["migration-friends-messages.sql", "migration-push.sql", "migration-live-snapshot.sql", "migration-known-connections.sql"]);
      const again = await dump(["--out", outFile, "--order", orderFile]);
      eq("running it again changes nothing in the order file (idempotent)", [again.code, readFileSync(orderFile, "utf8").split("migration-live-snapshot.sql").length - 1], [0, 1]);
      const dryRun = await dump(["--dry", "--out", join(dir, "never.sql"), "--order", orderFile]);
      ok("--dry prints the snapshot and writes nothing", dryRun.code === 0 && dryRun.out === snap && !existsSync(join(dir, "never.sql")));

      // apply to an empty database, twice
      psqlFile("fresh", join(dir, "live.sql").replace("live.sql", "live.sql"));   // the same base tables (functions are replaced below)
      // fresh = tables only: drop what the snapshot must recreate
      psql("fresh", `drop trigger if exists compat_conversations_insert on public.conversations; drop trigger if exists compat_messages_insert on public.messages; drop view public.conversations; drop view public.messages;
                     drop function public.get_feed_engine(integer, integer, uuid[]); drop function public.expire_posts(); drop function public.chat_can_send_post(uuid, uuid, uuid); drop function public.chat_post_available(uuid, uuid, uuid);
                     drop function public.compat_conversations_insert_fn(); drop function public.compat_messages_insert_fn();`);
      const a1 = psqlFile("fresh", outFile), a2 = psqlFile("fresh", outFile);
      if (a1.status !== 0 || a2.status !== 0) console.log((a1.stderr + a2.stderr).split("\n").filter((x) => /ERROR/.test(x)).slice(0, 4).join("\n"));
      eq("the snapshot applies cleanly to a database without them, and again (idempotent)", [a1.status, a2.status], [0, 0]);
      const defs = (db) => psql(db, "select string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.proname) from pg_proc p where p.pronamespace='public'::regnamespace").stdout.trim();
      eq("every function is identical to the live one", defs("fresh"), defs("live"));
      const grants = (db) => psql(db, "select string_agg(p.proname || ':' || r || ':' || has_function_privilege(r, p.oid, 'execute')::text, '|' order by p.proname, r) from pg_proc p cross join unnest(array['public','anon','authenticated','service_role']) r where p.pronamespace='public'::regnamespace and p.proname in ('get_feed_engine','chat_can_send_post','expire_posts','chat_post_available')").stdout.trim();
      const g = (s) => s.replace(/postgres/g, "o");
      eq("who may execute each function matches the live database (public, anon, authenticated, service_role)", grants("fresh"), grants("live"));
      const viewGrants = (db) => psql(db, "select string_agg(c.relname || ':' || coalesce(c.relacl::text,'-') || ':' || coalesce(c.reloptions::text,'-'), '|' order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='v'").stdout.trim();
      eq("view privileges and options match (security_invoker kept)", g(viewGrants("fresh")), g(viewGrants("live")));
      eq("the INSTEAD OF triggers are back and work: an insert through the views lands in the chat tables", [
        psql("fresh", "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in ('conversations','messages') and not t.tgisinternal").stdout.trim(),
        (() => { psql("fresh", "insert into public.conversations (participant_1_id, participant_2_id) values ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001')"); return psql("fresh", "select user_a::text from public.chat_conversations").stdout.trim(); })(),
      ], ["2", "00000000-0000-0000-0000-000000000001"]);
      const b4 = psql("fresh", "select count(*) from pg_proc where pronamespace='public'::regnamespace").stdout.trim();
      psqlFile("fresh", outFile);
      eq("a third application changes nothing", psql("fresh", "select count(*) from pg_proc where pronamespace='public'::regnamespace").stdout.trim(), b4);
      psql("fresh", "drop view public.messages; create table public.messages (id int)");
      const onTable = psqlFile("fresh", outFile);
      eq("if a real TABLE has a view's name the view is skipped with a notice, never replaced", [onTable.status, psql("fresh", "select relkind from pg_class where relname='messages' and relnamespace='public'::regnamespace").stdout.trim()], [0, "r"]);

      // failures
      psql("live", "drop function public.chat_post_available(uuid, uuid, uuid)");
      const miss = await dump(["--out", join(dir, "partial.sql"), "--order", orderFile]);
      ok("a required object missing live: exit 2, the object is named, nothing is written", miss.code === 2 && /chat_post_available/.test(miss.err) && !existsSync(join(dir, "partial.sql")));
      mode = "unauthorized";
      const bad = await dump(["--dry"]);
      ok("an API error: exit 1, the API's message, no token in the output", bad.code === 1 && /Unauthorized/.test(bad.err) && !(bad.out + bad.err).includes("TOPSECRET"));
      const noToken = await dump(["--dry"], { SUPABASE_ACCESS_TOKEN: "" });
      eq("no token: exit 2 and no request is made", [noToken.code, /not set/.test(noToken.err)], [2, true]);
      const badOpt = await dump(["--nope"]);
      eq("an unknown option is refused", badOpt.code, 2);
    }
  } finally {
    server?.close();
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
