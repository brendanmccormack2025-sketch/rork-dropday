#!/usr/bin/env node
/**
 * MONEY FOOTAGE (supabase/migration-money-footage.sql: campaign footage uploaded to a private bucket, MONEY_TAB_SPEC.md sections 3 and 4), on top of
 * post-links, money and money-board, run for real on a scratch PostgreSQL (harness copied from test-money-board-sql.mjs). The first block below is the
 * board test's description.
 *   node --experimental-strip-types --no-warnings scripts/test-money-footage-sql.mjs
 * MONEY BOARD, step 1 (supabase/migration-money-board.sql: schema, RLS and triggers for the v1 job board, MONEY_TAB_SPEC.md sections 1 and 11),
 * on top of migration-money.sql and everything before it, run for real on a scratch PostgreSQL (same harness as test-money-sql.mjs).
 *   node --experimental-strip-types --no-warnings scripts/test-money-board-sql.mjs
 * (older description, same harness) MONEY, steps 1-2 (supabase/migration-money.sql: the feature flag, the strict adult check, birthdate collection and lock-down) on top of everything before it, run for real on a scratch PostgreSQL (same
 * harness as test-stranger-only-sql.mjs). Admin-only offers, the creator's consent (full / strangers / decline), and the exposure
 * rule on every surface: the feed (Spotlight posts lead it, with a category label) and the profile badge; rotation, expiry, withdrawal.
 * The flag (off for everyone but the owner), allow-listed testers, the strict adult check (no birthdate / teen / under-13 are never adult),
 * sanctions, the 18th-birthday boundary, what the app reads at launch (my_features), and that nothing leaks another person's age or flag state.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-money-sql.mjs
 * (the harness below is shared with the STRANGER-ONLY test: STRANGER-ONLY distribution (supabase/migration-stranger-only.sql, with migration-known-connections.sql), run for real on a scratch
 * PostgreSQL: Supabase's auth / vault / cron mocked, the app's schema and the migrations it builds on (engine, friends, known
 * connections, hide ended ...), then stranger-only twice. Multi-account scenarios: A and B contacts (phone and email, both
 * directions), A and B friends, A on B's hide list, strangers: proving the exclusion on the feed (every tier), Explore, creator
 * search and suggestions, sharing, and that the profile stays open; plus the trial rules (cap, no 'incomplete', failed posts
 * deleted, survived never). Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-stranger-only-sql.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, chownSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (name, a, b, tol = 1e-3) => { const g = Number(a); const o = Math.abs(g - b) <= tol; if (!o) failed++; console.log(`${o ? "PASS" : "FAIL"}  ${name}${o ? "" : `  got ${g} want ${b}`}`); };

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/14/bin", "/usr/local/bin", "/usr/bin"].find((d) => existsSync(join(d, "initdb")));
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const run = (cmd, args, opts = {}) => spawnSync(asRoot && opts.asPostgres ? "runuser" : cmd, asRoot && opts.asPostgres ? ["-u", "postgres", "--", cmd, ...args] : args, { encoding: "utf8" });
const sqlDir = new URL("../supabase/", import.meta.url).pathname;


if (!BIN) {
  console.log("SKIP  PostgreSQL not installed on this machine: the database checks were not run");
} else {
  const dir = mkdtempSync(join(tmpdir(), "pgt-"));
  if (asRoot) chownSync(dir, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
  const data = join(dir, "data");
  const port = String(54800 + Math.floor(Math.random() * 500));
  const initdb = run(join(BIN, "initdb"), ["-D", data, "-A", "trust"], { asPostgres: true });
  const start = run(join(BIN, "pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir}`, "-l", join(dir, "log"), "-w", "start"], { asPostgres: true });
  const psql = (db, sql, extra = []) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-d", db, ...extra, "-c", sql], { encoding: "utf8" });
  const psqlFile = (db, file) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-d", db, "-f", file], { encoding: "utf8" });
  const q = (sql) => psql("t", sql).stdout.trim();
  const Q = (sql) => { const r = psql("t", sql, ["-v", "ON_ERROR_STOP=1"]); if (r.status !== 0) console.log("SQL ERR:", r.stderr.split("\n").find((l) => /ERROR/.test(l)), "\n   in:", sql.slice(0, 200)); return r.stdout.trim(); };
  try {
    if (initdb.status !== 0 || start.status !== 0) {
      console.log("SKIP  could not start a scratch PostgreSQL: the database checks were not run");
    } else {
      psql("postgres", "create database t");
      psql("t", `
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema auth;
        create table auth.users (id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb, created_at timestamptz default now());
        create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
        grant usage on schema auth to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;
        create schema extensions;
        create schema vault;
        create table vault.secrets (name text, secret text);
        create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
        insert into vault.secrets values ('trial_contact_pepper', 'test-pepper-0123456789-abcdefghijklmnop');
        create schema cron;
        create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
        create function cron.schedule(n text, s text, c text) returns bigint language sql as $f$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $f$;
        create function cron.unschedule(id bigint) returns boolean language sql as $f$ delete from cron.job where jobid = id returning true $f$;
        create function cron.unschedule(id integer) returns boolean language sql as $f$ delete from cron.job where jobid = id returning true $f$;`);
      const schemaPath = join(sqlDir, "schema.sql");
      psqlFile("t", schemaPath); psqlFile("t", schemaPath);
      // notifications is created in the dashboard (not in the repo's SQL): a minimal copy with the type check
      psql("t", `create table if not exists public.notifications (
          id uuid primary key default gen_random_uuid(), recipient_id uuid not null, actor_id uuid, type text not null, post_id uuid,
          read boolean default false, created_at timestamptz default now(),
          constraint notifications_type_check check (type in ('like','reaction','follow','follow_request','follow_accept','verdict_survived','verdict_archived','followed_post_survived')));
        create unique index if not exists notif_followed_once on public.notifications (recipient_id, post_id) where type = 'followed_post_survived';`);
      // the lifecycle migrations, oldest first (the pg_cron extension line is mocked above)
      for (const f of ["migration-survival-checkpoint", "migration-qualified-views", "migration-raw-views", "migration-moderation", "migration-age-gating", "migration-media-deletion", "migration-lifecycle", "migration-reaction-count"]) {
        const src = readFileSync(join(sqlDir, f + ".sql"), "utf8").replace(/^\s*create extension[^;]*;/gim, "");
        const p = join(dir, f + ".sql"); writeFileSync(p, src); if (asRoot) chownSync(p, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
        psqlFile("t", p);
      }
      ok("(base) the real legacy run_survival_checkpoint and trial_config exist", q("select to_regprocedure('public.run_survival_checkpoint()') is not null and to_regclass('public.trial_config') is not null") === "t");

      const migPath = join(sqlDir, "migration-trial-engine.sql");
      const m1 = psqlFile("t", migPath); const m2 = psqlFile("t", migPath);
      if (/ERROR/.test(m1.stderr + m2.stderr)) console.log((m1.stderr + m2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 5).join("\n"));
      eq("the migration applies cleanly, and again (idempotent)", [/ERROR/.test(m1.stderr), /ERROR/.test(m2.stderr)], [false, false]);
      eq("exactly one survival-checkpoint cron job, and one affinity job", [q("select count(*) from cron.job where jobname='survival-checkpoint'"), q("select count(*) from cron.job where jobname='trial-affinity'")], ["1", "1"]);

      const kc = join(sqlDir, "migration-known-connections.sql");
      const k1 = psqlFile("t", kc), k2 = psqlFile("t", kc);
      if (/ERROR/.test(k1.stderr + k2.stderr)) console.log((k1.stderr + k2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 5).join("\n"));
      eq("the known-connections migration applies cleanly, and again (idempotent)", [/ERROR/.test(k1.stderr), /ERROR/.test(k2.stderr)], [false, false]);
      const sp = join(sqlDir, "migration-survived-profile.sql");
      const s1 = psqlFile("t", sp), s2 = psqlFile("t", sp);
      if (/ERROR/.test(s1.stderr + s2.stderr)) console.log((s1.stderr + s2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 5).join("\n"));
      eq("the survived-profile migration applies cleanly, and again (idempotent)", [/ERROR/.test(s1.stderr), /ERROR/.test(s2.stderr)], [false, false]);
      const he = join(sqlDir, "migration-hide-ended.sql");
      const h1 = psqlFile("t", he), h2 = psqlFile("t", he);
      if (/ERROR/.test(h1.stderr + h2.stderr)) console.log((h1.stderr + h2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 5).join("\n"));
      eq("the hide-ended migration applies cleanly, and again (idempotent)", [/ERROR/.test(h1.stderr), /ERROR/.test(h2.stderr)], [false, false]);
      // ── the friends migration ──
      Q(`insert into vault.secrets values ('tryal_invite_secret', 'test-invite-secret-0123456789-abcdefghijklmnopqrstuvwxyz')`);
      const fm = join(sqlDir, "migration-friends-messages.sql");
      const f1 = psqlFile("t", fm), f2 = psqlFile("t", fm);
      if (/ERROR/.test(f1.stderr + f2.stderr)) console.log((f1.stderr + f2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 6).join("\n"));
      eq("the friends migration applies cleanly, and again (idempotent)", [/ERROR/.test(f1.stderr), /ERROR/.test(f2.stderr)], [false, false]);
      Q(`alter table auth.users add column if not exists email text`);
      // as in MIGRATIONS_ORDER.txt, known-connections runs right after (it adds the friends branch to the view)
      const kcPath = join(sqlDir, "migration-known-connections.sql");
      const kc1 = psqlFile("t", kcPath), kc2 = psqlFile("t", kcPath);
      eq("known-connections after friends applies cleanly, and again", [/ERROR/.test(kc1.stderr), /ERROR/.test(kc2.stderr)], [false, false]);


      // ── fixtures ──
      const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const P = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const asUser = (uid, sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
      const as = (uid, sql) => { const r = asUser(uid, sql); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const emailOf = (n) => `user${n}@example.test`;
      const mkUser = (n, birth = "1990-01-01") => Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(n)}','{"username":"u${n}"}','${emailOf(n)}') on conflict do nothing; update public.profiles set birthdate='${birth}', display_name='Name${n}', created_at = now() - interval '100 hours' where id='${U(n)}'`);
      Q(`create or replace function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$`);
      Q(`create or replace function public.feed_blocked_ids() returns setof uuid language sql stable as $f$
           select blocked_id from public.user_blocks where blocker_id = auth.uid() union select blocker_id from public.user_blocks where blocked_id = auth.uid() $f$;`);

      // an OLD incomplete post and an OLD archived one exist before the migration: they must be left alone
      for (let i = 1; i <= 12; i++) mkUser(i);
      mkUser(13, "2012-06-01");                                    // a minor
      Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(90)}','${U(1)}','u','video'), ('${P(91)}','${U(1)}','u','video');
         update public.posts set status='incomplete' where id='${P(90)}'; update public.posts set status='archived' where id='${P(91)}'`);
      Q(`insert into public.trial_post_state (post_id, decision, decided_at, posterior_mean) values ('${P(90)}','incomplete', now(), 0.2) on conflict (post_id) do update set decision='incomplete'`);

      // ── the stranger-only migration ──
      const so = join(sqlDir, "migration-stranger-only.sql");
      const o1 = psqlFile("t", so), o2 = psqlFile("t", so);
      if (/ERROR/.test(o1.stderr + o2.stderr)) console.log((o1.stderr + o2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the stranger-only migration applies cleanly, and again (idempotent)", [/ERROR/.test(o1.stderr), /ERROR/.test(o2.stderr)], [false, false]);
      eq("old incomplete / archived rows are left alone (new rule applies to new posts only)", q(`select string_agg(status, ',' order by status) from public.posts where id in ('${P(90)}','${P(91)}')`), "archived,incomplete");
      eq("the per-friend exception is gone", [q("select to_regclass('public.friend_test_optin') is null"), q("select to_regprocedure('public.set_friend_can_test(uuid,boolean)') is null")], ["t", "t"]);
      ok("the silence switch cannot be turned off any more (stranger-only is not a setting)", psql("t", "update public.trial_engine_config set build_in_silence = false").status !== 0);
      eq("the cap is a config value, 72 h by default", q("select max_test_hours from public.trial_engine_config"), "72");

      const NUM = (n) => `+1415555${String(1000 + n)}`;
      const wipe = () => Q(`delete from public.message_post_opens; delete from public.chat_messages; delete from public.chat_reads; delete from public.chat_conversations; delete from public.friend_requests; delete from public.friendships;
        delete from public.user_blocks; delete from public.hide_from_list; delete from public.contact_hashes; delete from public.contact_email_hashes; delete from public.user_phone_hash;
        delete from public.trial_assignments; delete from public.trial_post_state; delete from public.viewer_creator_affinity; delete from public.post_raw_views; delete from public.post_view_stats; delete from public.post_qualified_views;
        delete from public.likes; delete from public.notifications; delete from public.trial_media_delete_queue; delete from public.trial_bar_samples; delete from public.posts where id not in ('${P(90)}','${P(91)}')`);
      const feed = (uid, limit = 100) => as(uid, `select coalesce(string_agg(post_id::text, ',' order by "position"), '') from public.get_feed_engine(${limit}, 0) where post_id is not null`).out.split(",").filter(Boolean);
      const activate = () => {
        Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(80)}','${U(12)}','u','video') on conflict do nothing; update public.posts set status='expired' where id='${P(80)}'`);
        for (let i = 1; i <= 13; i++) Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(80)}','${U(i)}') on conflict do nothing`);
        Q("select public.trial_refresh_active()");
        Q(`update public.trial_engine_config set small_pool_everyone = 50, min_active = 0, min_active_fraction = 0, max_active_trials = 1000`);
      };
      const mkTrial = (n, creator) => Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(n)}','${U(creator)}','https://x.supabase.co/storage/v1/object/public/drops/p${n}.mp4','video')`);
      const mkSurvived = (n, creator, hoursAgo = 1) => Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(n)}','${U(creator)}','https://x.supabase.co/storage/v1/object/public/drops/p${n}.mp4','video');
        update public.posts set status='survived', survived_at = now() - interval '${hoursAgo} hours', distribution_started_at = now() - interval '${hoursAgo} hours', distribution_expires_at = null where id='${P(n)}'`);
      const setup = () => {
        wipe();
        // A=1 is the creator. B=2: A has B's phone. H=8: H has A's phone. E=5: A has E's email. C=3: friends with A. D=4: on A's hide list.
        // F=6, G=7, I=9, J=10, K=11, L=12: strangers.
        as(U(2), `select public.set_my_phone('${NUM(2)}')`); as(U(1), `select public.sync_my_contacts(array['${NUM(2)}'])`);
        as(U(1), `select public.set_my_phone('${NUM(1)}')`); as(U(8), `select public.sync_my_contacts(array['${NUM(1)}'])`);
        as(U(1), `select public.sync_my_contact_emails(array['${emailOf(5)}', 'Someone.Else@Example.Test'])`);
        Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(3)}')`);
        Q(`insert into public.hide_from_list (owner_id, hidden_user_id) values ('${U(1)}','${U(4)}')`);
        activate();
      };
      const KNOWN = { B_phone: 2, C_friend: 3, D_hidden: 4, E_email: 5, H_reverse_phone: 8 };
      const STRANGERS = [6, 7, 9, 10, 11];


      // ── the spotlight migration, twice ──
      const sl = join(sqlDir, "migration-spotlight.sql");
      const l1 = psqlFile("t", sl), l2 = psqlFile("t", sl);
      if (/ERROR/.test(l1.stderr + l2.stderr)) console.log((l1.stderr + l2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the spotlight migration applies cleanly, and again (idempotent)", [/ERROR/.test(l1.stderr), /ERROR/.test(l2.stderr)], [false, false]);
      eq("the owner is an admin from the start; nothing else is", q("select count(*) from public.spotlight_admins"), "1");
      mkUser(14);
      Q(`insert into public.spotlight_admins (user_id) values ('${U(14)}')`);            // ADMIN = 14
      const ADMIN = U(14);
      const CAT = "creator_of_the_day";
      const ha = join(sqlDir, "migration-harassment.sql");
      const a1 = psqlFile("t", ha), a2 = psqlFile("t", ha);
      if (/ERROR/.test(a1.stderr + a2.stderr)) console.log((a1.stderr + a2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the harassment migration applies cleanly, and again (idempotent)", [/ERROR/.test(a1.stderr), /ERROR/.test(a2.stderr)], [false, false]);

      const pushMig = join(sqlDir, "migration-push.sql");
      const pu1 = psqlFile("t", pushMig), pu2 = psqlFile("t", pushMig);
      eq("the push migration applies (the owner alert's push goes through its claim function)", [/ERROR/.test(pu1.stderr), /ERROR/.test(pu2.stderr)], [false, false]);
      const rv = join(sqlDir, "migration-recovery.sql");
      const v1 = psqlFile("t", rv), v2 = psqlFile("t", rv);
      if (/ERROR/.test(v1.stderr + v2.stderr)) console.log((v1.stderr + v2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the recovery migration applies cleanly, and again (idempotent)", [/ERROR/.test(v1.stderr), /ERROR/.test(v2.stderr)], [false, false]);

      {
      const sn = join(sqlDir, "migration-sanctions.sql");
      const n1 = psqlFile("t", sn), n2 = psqlFile("t", sn);
      if (/ERROR/.test(n1.stderr + n2.stderr)) console.log((n1.stderr + n2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the sanctions migration applies cleanly, and again (idempotent)", [/ERROR/.test(n1.stderr), /ERROR/.test(n2.stderr)], [false, false]);
      eq("a suspension job is scheduled once", q("select count(*) from cron.job where jobname='sanctions-expire'"), "1");

      const mo = join(sqlDir, "migration-money.sql");
      const t1 = psqlFile("t", mo), t2 = psqlFile("t", mo);
      if (/ERROR/.test(t1.stderr + t2.stderr)) console.log((t1.stderr + t2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the money migration (step 1) applies cleanly, and again (idempotent)", [/ERROR/.test(t1.stderr), /ERROR/.test(t2.stderr)], [false, false]);

      // Tryal friends + open messages sit between sanctions and Money in the real order (MIGRATIONS_ORDER.txt)
      const tfm = join(sqlDir, "migration-tryal-friends.sql");
      const tf1 = psqlFile("t", tfm), tf2 = psqlFile("t", tfm);
      eq("the Tryal-friends migration (open messages) applies, as in the real order", [/ERROR/.test(tf1.stderr), /ERROR/.test(tf2.stderr)], [false, false]);
      // The dashboard-made get_feed (supabase/get_feed.sql, not in any migration) exists in the live database, with execute revoked from apps
      // by migration-stranger-only.sql. Its dashboard helpers are stubbed here.
      Q(`create or replace function public.feed_settings() returns table(testing_ratio numeric, reaction_weight numeric, like_weight numeric, smoothing numeric, decay_hours numeric) language sql as $f$ select 0.2::numeric, 2::numeric, 1::numeric, 5::numeric, 24::numeric $f$;
         create or replace function public.trial_required_views() returns integer language sql as $f$ select 10 $f$;
         create or replace function public.feed_seen_ids(p_ids uuid[]) returns setof uuid language sql as $f$ select null::uuid where false $f$`);
      const getFeedSql = readFileSync(join(sqlDir, "get_feed.sql"), "utf8");
      const loadGetFeed = (text) => { const f = join(dir, "get_feed_variant.sql"); writeFileSync(f, text); if (asRoot) chownSync(f, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1); const r = psqlFile("t", f); return !/ERROR/.test(r.stderr); };
      eq("(G1) the dashboard get_feed (supabase/get_feed.sql) is loaded and, as live, nobody signed in can run it", [loadGetFeed(getFeedSql), (Q(`revoke all on function public.get_feed(integer, integer) from public, anon, authenticated`), true), q(`select has_function_privilege('authenticated', 'public.get_feed(integer, integer)', 'execute')`)], [true, true, "f"]);
      const rows = (file) => q(readFileSync(join(sqlDir, file), "utf8").replace(/^--.*$/gm, "")).split("\n").filter(Boolean).map((l) => l.split("|"));
      const status = () => rows("check-migrations-applied.sql").map(([step, , , st]) => `${step}:${st.split(" ")[0] === "NOT" ? "NOT" : st.split(" ")[0]}`);
      eq("(S) check-migrations-applied.sql before Money's board file: steps 1-10 applied, 11 NOT applied, 12 reports the lock-down state", status().slice(0, 11), ["1:applied", "2:applied", "3:applied", "4:applied", "5:applied", "6:applied", "7:applied", "8:applied", "9:applied", "10:applied", "11:NOT"]);
      eq("(S) it is a single read-only SELECT (no insert / update / delete / drop / alter / create / grant / truncate)", /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(readFileSync(join(sqlDir, "check-migrations-applied.sql"), "utf8").replace(/^--.*$/gm, "")), false);
      const pl = join(sqlDir, "migration-post-links.sql");
      const pl1 = psqlFile("t", pl), pl2 = psqlFile("t", pl);
      eq("the post-links migration applies (it ships before Money)", [/ERROR/.test(pl1.stderr), /ERROR/.test(pl2.stderr)], [false, false]);
      const mb = join(sqlDir, "migration-money-board.sql");
      // a minimal copy of Supabase's storage schema, so the private bucket and its policies can be tested
      Q(`create schema if not exists storage;
         create table if not exists storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
         create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now());
         alter table storage.objects enable row level security;
         grant usage on schema storage to anon, authenticated, service_role;
         grant select, insert, update, delete on storage.objects to authenticated;`);
      Q(`update public.trial_engine_config set engine_mode = 'live'`);
      const b1 = psqlFile("t", mb), b2 = psqlFile("t", mb);
      if (/ERROR/.test(b1.stderr + b2.stderr)) console.log((b1.stderr + b2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the money-board migration applies cleanly, and again (idempotent)", [/ERROR/.test(b1.stderr), /ERROR/.test(b2.stderr)], [false, false]);

      eq("(S) after the board file every one of the 11 steps reads 'applied', and the lock-down is reported as not applied", [status().slice(0, 11).every((s) => s.endsWith(":applied")), rows("check-migrations-applied.sql")[11][3].startsWith("lock-down NOT applied")], [true, true]);
      const feedDef = () => q(`select prosrc from pg_proc where proname = 'get_feed' and pronamespace = 'public'::regnamespace`);
      const yearsAgo = (y, extraDays = 0) => q(`select (current_date - interval '${y} years' - interval '${extraDays} days')::date`);
      const su = (uid, sql) => { const r = psql("t", `set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const feat = (n) => JSON.parse(as(U(n), `select public.my_features()`).out);
      const sql1 = (e) => q(`select ${e}`);
      const MONEY = [...Array(40).keys()].map((i) => 60 + i);
      const RULES = { creator: ["pay_on_time", "terms_freeze", "auto_approval_48h", "not_part_of_payment", "own_footage_rights", "campaign_messaging"], clipper: ["only_real_views", "submit_through_tryal", "upload_proof_on_time", "footage_use", "not_part_of_payment", "campaign_messaging"] };
      RULES.both = [...new Set([...RULES.creator, ...RULES.clipper])];
      const arr = (a) => `array[${a.map((x) => `'${x}'`).join(",")}]`;
      const onboard = (n, role) => as(U(n), `select public.money_complete_onboarding('${role}', ${arr(RULES[role])})`);
      const mk = (n, role, birth = "1990-01-01") => { mkUser(n, birth); if (role) { const r = onboard(n, role); if (!r.ok) console.log("onboard failed", n, role, r.err.split("\n")[0]); } };
      Q(`update public.app_flags set enabled = true where key = 'money'`);

      const C = 60, A = 61, B = 62, BOTH = 63, TEEN = 64, NOBD = 65, NOTOB = 66, BANNED = 67, STR = 68, ADM = 14;
      mk(C, "creator"); mk(A, "clipper"); mk(B, "clipper"); mk(BOTH, "both");
      mkUser(TEEN, yearsAgo(16)); mkUser(NOBD); Q(`update public.profiles set birthdate = null where id='${U(NOBD)}'`); mkUser(NOTOB);
      mk(BANNED, "clipper"); mk(STR, "clipper");
      Q(`insert into public.spotlight_admins (user_id) values ('${U(ADM)}') on conflict do nothing`);

      // the footage migration, twice
      const mf = join(sqlDir, "migration-money-footage.sql");
      const g1 = psqlFile("t", mf), g2 = psqlFile("t", mf);
      if (/ERROR/.test(g1.stderr + g2.stderr)) console.log((g1.stderr + g2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the footage migration applies cleanly, and again (idempotent)", [/ERROR/.test(g1.stderr), /ERROR/.test(g2.stderr)], [false, false]);
      // the segments migration (long videos in 1-minute parts), applied right after, as in the real order: every older footage test below must still pass with it
      const sg = join(sqlDir, "migration-money-segments.sql");
      const sg1 = psqlFile("t", sg), sg2 = psqlFile("t", sg);
      if (/ERROR/.test(sg1.stderr + sg2.stderr)) console.log((sg1.stderr + sg2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the segments migration applies cleanly, and again (idempotent)", [/ERROR/.test(sg1.stderr), /ERROR/.test(sg2.stderr)], [false, false]);
      eq("(F) the agreement version went up (everybody ticks the new rules), the limits are 60 / 30 minutes, 2 GB, 14 / 7 days", q(`select (agreement_version >= 2) || ':' || max_footage_seconds_total || ':' || max_footage_seconds_each || ':' || max_footage_bytes || ':' || footage_delete_days || ':' || orphan_footage_days from public.money_config`), "true:3600:1800:2147483648:14:7");
      eq("(F) one purge job is scheduled, and the bucket is private with a 2 GB limit and no other file types", [q(`select count(*) from cron.job where jobname = 'money-footage-purge'`), q(`select public::text || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'campaign-footage'`)], ["1", "false:2147483648:video/mp4,video/quicktime,image/jpeg"]);
      // everybody re-onboards for the new version
      Q(`update public.money_config set agreement_version = (select agreement_version from public.money_config)`);
      for (const n of [C, A, B, BOTH, STR]) onboard(n, n === BOTH ? "both" : n === C ? "creator" : "clipper");
      const SEC = (m) => m * 60;
      const reg = (uid, dur = 600, w = 1920, h = 1080, size = 1000) => as(uid, `select id || '|' || storage_path || '|' || thumb_path from public.money_footage_register(${dur}, ${w}, ${h}, ${size})`);
      const putFile = (path, size, owner) => Q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${path}', '${owner}', '{"size": ${size}}')`);

      // F1. registering: who, and how much
      Q(`alter table storage.objects add column if not exists metadata jsonb`);
      const r1 = reg(U(C), SEC(10));
      ok("(F1) a creator registers a video and gets its id and the two paths (<creator>/<id>.mp4 and .jpg)", r1.ok && r1.out.split("|")[1] === `${U(C)}/${r1.out.split("|")[0]}.mp4` && r1.out.split("|")[2] === `${U(C)}/${r1.out.split("|")[0]}.jpg`);
      eq("(F1) a clipper, a teen and a person who is not signed in cannot register", [reg(U(A)).ok, reg(U(TEEN)).ok, psql("t", `select * from public.money_footage_register(60, 1920, 1080, 1000)`).status === 0], [false, false, false]);
      eq("(F1) a 'both' account can", reg(U(BOTH), 60).ok, true);
      eq("(F1) one video is at most 30 minutes (and 30 exactly is fine)", [reg(U(BOTH), SEC(31)).ok, reg(U(BOTH), SEC(30)).ok], [false, true]);
      eq("(F1) a file over 2 GB is refused, and a zero length or size is too", [reg(U(BOTH), 60, 1920, 1080, 2147483649).ok, reg(U(BOTH), 0).ok, reg(U(BOTH), 60, 1920, 1080, 0).ok], [false, false, false]);
      Q(`delete from public.campaign_footage where creator_id = '${U(BOTH)}'`);

      // F2. the 60-minute total, per creator's batch
      Q(`delete from public.campaign_footage where creator_id = '${U(C)}'`);
      const ids = [];
      for (const m of [30, 20]) { const r = reg(U(C), SEC(m)); ids.push(r.out.split("|")[0]); }
      eq("(F2) 30 + 20 minutes fit; 10 more is exactly 60 and fits; one more second does not", [reg(U(C), SEC(10)).ok, reg(U(C), 1).ok], [true, false]);
      eq("(F2) the 4th register above would be over 60 minutes: the batch holds 60 minutes", q(`select sum(duration_seconds)::int from public.campaign_footage where creator_id = '${U(C)}' and status = 'uploading'`), "3600");
      Q(`delete from public.campaign_footage where creator_id = '${U(C)}' and duration_seconds = 600`);
      eq("(F2) removing a video frees its minutes", reg(U(C), SEC(10)).ok, true);
      // a failed upload frees its slot too
      const bad = reg(U(C), SEC(5)).ok ? q(`select id from public.campaign_footage where creator_id = '${U(C)}' order by created_at desc limit 1`) : null;
      eq("(F2) over 60 right now, so a 5 minute video is refused until a failed one is marked failed", [reg(U(C), SEC(5)).ok], [false]);
      ok("(F2) the 50 minute video is failed -> its minutes are free again, and its files are queued for deletion", (() => { as(U(C), `select public.money_footage_fail('${ids[1]}')`); return reg(U(C), SEC(5)).ok && q(`select count(*) from public.trial_media_delete_queue where bucket = 'campaign-footage' and path like '%${ids[1]}%'`) === "2"; })());
      eq("(F2) too many drafts at once is refused", (() => { Q(`delete from public.campaign_footage where creator_id = '${U(BOTH)}'`); Q(`update public.money_config set max_draft_footage = 3`); const out = [1, 2, 3, 4].map(() => reg(U(BOTH), 10).ok); Q(`update public.money_config set max_draft_footage = 30`); Q(`delete from public.campaign_footage where creator_id = '${U(BOTH)}'`); return out; })(), [true, true, true, false]);
      eq("(F2) apps cannot write the table directly (no insert / update / delete)", [as(U(C), `insert into public.campaign_footage (creator_id, storage_path, thumb_path, duration_seconds, width, height, size_bytes) values ('${U(C)}', 'x', 'y', 5, 5, 5, 5)`).ok, as(U(C), `update public.campaign_footage set status = 'ready' where creator_id = '${U(C)}'`).ok, as(U(C), `delete from public.campaign_footage where creator_id = '${U(C)}'`).ok], [false, false, false]);

      // F3. complete: only when the file is really there at the registered size
      Q(`delete from public.campaign_footage where creator_id = '${U(C)}'`); Q(`delete from storage.objects`);
      const f1 = reg(U(C), SEC(10), 1920, 1080, 5000).out.split("|");
      eq("(F3) completing before the file is in Storage is refused", as(U(C), `select public.money_footage_complete('${f1[0]}')`).ok, false);
      putFile(f1[1], 4999, U(C));
      eq("(F3) ...and so is a file of the wrong size", as(U(C), `select public.money_footage_complete('${f1[0]}')`).ok, false);
      Q(`delete from storage.objects where name = '${f1[1]}'`); putFile(f1[1], 5000, U(C));
      eq("(F3) the right size completes it: status ready, ready_at set, no thumbnail yet", [as(U(C), `select public.money_footage_complete('${f1[0]}')`).ok, q(`select status || ':' || thumb_ok || ':' || (ready_at is not null) from public.campaign_footage where id = '${f1[0]}'`)], [true, "ready:false:true"]);
      eq("(F3) completing again is harmless; someone else's video is unknown", [as(U(C), `select public.money_footage_complete('${f1[0]}')`).ok, as(U(BOTH), `select public.money_footage_complete('${f1[0]}')`).ok], [true, false]);
      const f2 = reg(U(C), SEC(5), 1080, 1920, 3000).out.split("|"); putFile(f2[1], 3000, U(C)); putFile(f2[2], 20, U(C));
      eq("(F3) with a thumbnail uploaded, thumb_ok is true", [as(U(C), `select public.money_footage_complete('${f2[0]}')`).ok, q(`select thumb_ok from public.campaign_footage where id = '${f2[0]}'`)], [true, "t"]);

      // F4. Storage policies: who may put a file in the bucket
      const putAs = (uid, path) => as(uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${path}', '${uid}', '{"size": 1}')`);
      const f3 = reg(U(C), SEC(2), 1280, 720, 100).out.split("|");
      eq("(F4) the creator can upload the registered video and thumbnail paths", [putAs(U(C), f3[1]).ok, putAs(U(C), f3[2]).ok], [true, true]);
      eq("(F4) nobody can upload an unregistered path, another person's path, or into a 'ready' video's file", [putAs(U(C), `${U(C)}/not-registered.mp4`).ok, putAs(U(A), f3[1]).ok, putAs(U(A), `${U(A)}/x.mp4`).ok, putAs(U(C), f1[1] + "x").ok], [false, false, false, false]);
      eq("(F4) a ready video (finished) accepts no more uploads", putAs(U(C), f1[1]).ok, false);
      eq("(F4) a signed-out caller and a teen cannot upload at all", [psql("t", `set role anon; insert into storage.objects (bucket_id, name) values ('campaign-footage', '${f3[1]}x')`).status === 0, putAs(U(TEEN), f3[1]).ok], [false, false]);
      eq("(F4) other buckets are not touched by these policies (an insert into another bucket by a creator is refused: no policy)", (() => { Q(`insert into storage.buckets (id, name, public) values ('other', 'other', false) on conflict do nothing`); return as(U(C), `insert into storage.objects (bucket_id, name) values ('other', 'x')`).ok; })(), false);
      eq("(F4) apps can not update or delete a file in the bucket", [as(U(C), `update storage.objects set name = name || 'z' where bucket_id = 'campaign-footage'`).out, as(U(C), `delete from storage.objects where bucket_id = 'campaign-footage'`).out, q(`select count(*) from storage.objects where bucket_id = 'campaign-footage'`) >= "3"], ["", "", true]);

      // F5. creating the campaign with footage
      const CARGS = (o = {}) => { const d = { title: "Podcast clips", desc: "Funny moments", full: null, rate: 2, cap: 50, budget: 250, guar: 3, platforms: ["tiktok", "instagram"], window: 7, min: 1000, method: "paypal", handle: "@creator", deadline: "now() + interval '30 days'", maxc: 5, agree: true, footage: [f1[0], f2[0]], ...o };
        const arrS = (a) => `array[${a.map((x) => `'${x}'`).join(",")}]`; return `'${d.title}', '${d.desc}', ${d.full === null ? "null" : `'${d.full}'`}, ${d.rate}, ${d.cap}, ${d.budget}, ${d.guar}, ${arrS(d.platforms)}, ${d.window}, ${d.min}, '${d.method}', '${d.handle}', ${d.deadline}, ${d.maxc}, ${d.agree}, ${d.footage ? `array[${d.footage.map((x) => `'${x}'::uuid`).join(",")}]` : "null"}`; };
      const create = (uid, o) => as(uid, `select public.money_create_campaign_with_footage(${CARGS(o)})`);
      eq("(F5) without agreeing, with no footage, with unfinished footage or with someone else's footage the campaign is refused", [create(U(C), { agree: false }).ok, create(U(C), { footage: [] }).ok, create(U(C), { footage: null }).ok, create(U(C), { footage: [f3[0]] }).ok, create(U(BOTH), { footage: [f1[0]] }).ok, create(U(A)).ok, q(`select count(*) from public.campaigns`)], [false, false, false, false, false, false, "0"]);
      const cc = create(U(C));
      ok("(F5) a creator posts a campaign with two ready videos", cc.ok);
      const CID = cc.out;
      eq("(F5) both videos belong to the campaign now, in the order given, and cannot be used twice", [q(`select string_agg(sort_order::text, ',' order by sort_order) from public.campaign_footage where campaign_id = '${CID}'`), create(U(C), { footage: [f1[0]] }).ok], ["1,2", false]);
      eq("(F5) the campaign has no footage link and a null footage_url; an optional Full video link is checked (YouTube ok, a look-alike or a random site is not)", [q(`select footage_url is null from public.campaigns where id = '${CID}'`), (() => { const f = reg(U(C), SEC(1), 640, 360, 10).out.split("|"); putFile(f[1], 10, U(C)); as(U(C), `select public.money_footage_complete('${f[0]}')`); return [create(U(C), { full: "https://www.youtube.com/watch?v=abc", footage: [f[0]] }).ok, create(U(C), { full: "https://youtube.com.evil.test/x", footage: [f[0]] }).ok, create(U(C), { full: "http://youtube.com/x", footage: [f[0]] }).ok]; })()], ["t", [true, false, false]]);
      eq("(F5) the old create function (a Drive link) refuses now that footage is uploaded", as(U(C), `select public.money_create_campaign('t', 'd', 'https://drive.google.com/x', 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true)`).ok, false);
      eq("(F5) the campaign carries the new agreement version", q(`select agreement_version = (select agreement_version from public.money_config) from public.campaigns where id = '${CID}'`), "t");

      // F6. who reads what
      const seeRows = (uid) => as(uid, `select count(*) from public.campaign_footage where campaign_id = '${CID}'`).out;
      const readOk = (uid, path) => as(uid, `select count(*) from storage.objects where bucket_id = 'campaign-footage' and name = '${path}'`).out;
      eq("(F6) the creator reads both rows and files; a stranger clipper sees nothing before joining", [seeRows(U(C)), readOk(U(C), f1[1]), seeRows(U(A)), readOk(U(A), f1[1])], ["2", "1", "0", "0"]);
      const j = as(U(A), `select public.money_join_campaign('${CID}', true)`);
      if (!j.ok) console.log("join failed:", j.err.split("\n")[0]);
      eq("(F6) a clipper who joined reads the rows, the videos and the thumbnail", [seeRows(U(A)), readOk(U(A), f1[1]), readOk(U(A), f2[2])], ["2", "1", "1"]);
      eq("(F6) ...but a clipper who did not join still cannot, nor can the teen, nor someone signed out", [seeRows(U(B)), readOk(U(B), f1[1]), seeRows(U(TEEN)), psql("t", `set role anon; select count(*) from storage.objects`).status === 0], ["0", "0", "0", false]);
      eq("(F6) a blocked clipper (blocked by the creator) loses the footage, and gets it back when unblocked", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(C)}', '${U(A)}')`); const o = [seeRows(U(A)), readOk(U(A), f1[1])]; Q(`delete from public.user_blocks where blocker_id = '${U(C)}'`); o.push(seeRows(U(A)), readOk(U(A), f1[1])); return o; })(), ["0", "0", "2", "1"]);
      eq("(F6) a banned member cannot read it (not ready)", (() => { Q(`update public.profiles set money_banned = true where id = '${U(A)}'`); const o = [seeRows(U(A)), readOk(U(A), f1[1])]; Q(`update public.profiles set money_banned = false where id = '${U(A)}'`); return o; })(), ["0", "0"]);
      eq("(F6) the owner (admin) reads it for moderation", [seeRows(U(ADM)), readOk(U(ADM), f1[1])], ["2", "1"]);
      eq("(F6) the files of a video that is still uploading are the creator's only, and a clipper never sees the draft", [q(`select count(*) from public.campaign_footage where campaign_id is null`) >= "1", seeRows(U(B))], [true, "0"]);

      // F7. frozen with the terms
      eq("(F7) once a clipper has joined, footage cannot be added to, changed in or removed from the campaign by anyone signed in", [as(U(C), `select public.money_footage_remove('${f1[0]}')`).ok, as(U(C), `update public.campaign_footage set sort_order = 9 where id = '${f1[0]}'`).ok, q(`select count(*) from public.campaign_footage where campaign_id = '${CID}' and status = 'ready'`)], [false, false, "2"]);

      // F8. removing a draft video
      const d1 = reg(U(C), SEC(1), 640, 360, 10).out.split("|");
      eq("(F8) a creator removes their own unused video: marked deleted, both files queued; others cannot", [as(U(BOTH), `select public.money_footage_remove('${d1[0]}')`).ok, as(U(C), `select public.money_footage_remove('${d1[0]}')`).ok, q(`select status from public.campaign_footage where id = '${d1[0]}'`), q(`select count(*) from public.trial_media_delete_queue where bucket = 'campaign-footage' and path like '${U(C)}/${d1[0]}%'`)], [false, true, "deleted", "2"]);
      eq("(F8) a deleted video is no longer readable, even by the creator", as(U(C), `select count(*) from public.campaign_footage where id = '${d1[0]}'`).out, "0");

      // F9. purge: 30 days after close (or the deadline), 7 days for unused uploads
      const cl = (sql) => Q(sql);
      const purged = () => q(`select public.money_footage_purge()`);
      const stillThere = () => q(`select count(*) from public.campaign_footage where campaign_id = '${CID}' and status <> 'deleted'`);
      eq("(F9) an open campaign's footage is kept", [purged(), stillThere()], ["0", "2"]);
      cl(`update public.campaigns set status = 'closed' where id = '${CID}'`);
      ok("(F9) closing sets closed_at (trigger)", q(`select closed_at is not null from public.campaigns where id = '${CID}'`) === "t");
      eq("(F9) 13 days after closing it is still kept", (() => { cl(`update public.campaigns set closed_at = now() - interval '13 days' where id = '${CID}'`); return [purged(), stillThere()]; })(), ["0", "2"]);
      eq("(F9) 15 days after closing it is deleted: rows marked, both files per video queued for the delete-media function", (() => { cl(`update public.campaigns set closed_at = now() - interval '15 days' where id = '${CID}'`); const n = purged(); return [n, stillThere(), q(`select count(*) from public.trial_media_delete_queue where bucket = 'campaign-footage' and (path like '${U(C)}/${f1[0]}%' or path like '${U(C)}/${f2[0]}%')`)]; })(), ["2", "0", "4"]);
      eq("(F9) running it again changes nothing", purged(), "0");
      eq("(F9) after deletion the clipper cannot read the files any more", [readOk(U(A), f1[1]), seeRows(U(A))], ["0", "0"]);
      eq("(F9) an unused upload is deleted after 7 days, not before", (() => { const o = reg(U(C), SEC(1), 640, 360, 10).out.split("|")[0]; cl(`update public.campaign_footage set created_at = now() - interval '6 days' where id = '${o}'`); const a = purged(); cl(`update public.campaign_footage set created_at = now() - interval '8 days' where id = '${o}'`); return [a, purged()]; })(), ["0", "1"]);
      eq("(F9) a campaign whose deadline passed 15 days ago is purged even if it never closed", (() => { const f = reg(U(C), SEC(1), 640, 360, 10).out.split("|"); putFile(f[1], 10, U(C)); as(U(C), `select public.money_footage_complete('${f[0]}')`); const c2 = create(U(C), { footage: [f[0]] }).out; cl(`update public.campaigns set deadline = now() - interval '15 days', status = 'open' where id = '${c2}'`); return purged(); })(), "1");
      eq("(F9) the purge and the guards are not callable by apps", ["public.money_footage_purge()", "public.money_footage_guard()", "public.money_footage_change_guard()"].map((f) => q(`select has_function_privilege('authenticated', '${f}', 'execute')`)), ["f", "f", "f"]);
      eq("(F9) the functions the app calls are callable by signed-in users only (not anon)", ["public.money_footage_register(numeric,integer,integer,bigint)", "public.money_footage_complete(uuid)", "public.money_footage_fail(uuid)", "public.money_footage_remove(uuid)"].map((f) => [q(`select has_function_privilege('authenticated', '${f}', 'execute')`), q(`select has_function_privilege('anon', '${f}', 'execute')`)].join("")), Array(4).fill("tf"));
      eq("(F9) a sanctioned creator cannot register or create", (() => { Q(`insert into public.account_sanctions (user_id, kind, until, created_by) values ('${U(C)}', 'suspend', now() + interval '2 days', '${U(ADM)}')`); const o = reg(U(C)).ok; Q(`update public.account_sanctions set lifted_at = now() where user_id = '${U(C)}'`); return o; })(), false);
      eq("(F9) the unused footage left over from the tests above counts toward nothing after purge (the minutes are free again)", reg(U(C), SEC(30)).ok, true);
      // W. the one-paste file for the SQL editor (supabase/apply-money-preview.sql), run on this database that already has everything (the live situation)
      {
        const gen = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(sqlDir, "..", "scripts", "gen-apply-money-preview.mjs"), "--check"], { encoding: "utf8" });
        eq("(W) apply-money-preview.sql is up to date with the five migration files", gen.status, 0);
        const text = readFileSync(join(sqlDir, "apply-money-preview.sql"), "utf8");
        const body = text.replace(/^\s*--.*$/gm, "");
        eq("(W) it has no psql-only commands, no transaction control, no extension install and never calls the birthdate lock-down", [/^\s*\\[a-z]/m.test(body), /^\s*(begin|commit|rollback)\s*;/im.test(body), /create extension/i.test(body), /select\s+public\.money_apply_birthdate_lockdown\s*\(/i.test(body)], [false, false, false, false]);
        eq("(W) it holds the five files in the right order", ["migration-post-links.sql", "migration-money.sql", "migration-money-board.sql", "migration-money-footage.sql", "migration-money-segments.sql"].map((f) => text.indexOf(`-- PART: ${f}`)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), true);
        const before = q(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('my_features', 'money_allowed', 'money_ready', 'money_join_campaign', 'money_create_campaign', 'money_footage_register')`);
        const paste = join(dir, "paste.sql"); writeFileSync(paste, text); if (asRoot) chownSync(paste, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
        const w1 = spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", "t", "-f", paste], { encoding: "utf8" });
        const w2 = spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", "t", "-f", paste], { encoding: "utf8" });
        if (w1.status !== 0) console.log(w1.stderr.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 4).join("\n"));
        eq("(W) pasted into a database that already has everything, it runs cleanly, twice", [w1.status, w2.status], [0, 0]);
        const rowsW = w2.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("|")).filter((r) => r[0] === "footage" || r[0] === "functions");
        eq("(W) its result is the check table, and every row is ok or info (except the birthdate lock-down note)", [rowsW.length > 12, rowsW.filter((r) => !["ok", "info"].includes(r[2]) && r[1] !== "birthdate can be saved in the app").map((r) => r.slice(0, 3).join(": "))], [true, []]);
        eq("(W) the newer functions are back after the older money file ran inside the paste (same source as before the paste)", q(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('my_features', 'money_allowed', 'money_ready', 'money_join_campaign', 'money_create_campaign', 'money_footage_register')`), before);
        eq("(W) and the feature still works for a ready creator afterwards", as(U(C), `select public.my_features()`).ok, true);
      }
      // X. additions: Drive / Dropbox link, Report on footage, admin totals, account deletion
      {
        Q(`delete from public.reports; delete from public.trial_media_delete_queue`);
        const mkReady = (uid, secs = 60) => { const f = reg(U(uid), secs, 1280, 720, 100).out.split("|"); putFile(f[1], 100, U(uid)); as(U(uid), `select public.money_footage_complete('${f[0]}')`); return f[0]; };
        // X1. the optional link
        const L = create(U(C), { footage: [], full: null });
        eq("(X1) a campaign needs a video or a footage link: neither is refused", [L.ok, as(U(C), `select public.money_create_campaign_with_footage('t', 'd', null, 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true, null)`).ok], [false, false]);
        const withLink = (url, ids = []) => as(U(C), `select public.money_create_campaign_with_footage('t', 'd', null, 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true, ${ids.length ? `array['${ids.join("','")}']::uuid[]` : "'{}'::uuid[]"}, ${url === null ? "null" : `'${url}'`})`);
        eq("(X1) a Google Drive or Dropbox link alone is enough; the host rule is the database's (look-alikes, http, YouTube refused)", [withLink("https://drive.google.com/drive/folders/abc").ok, withLink("https://www.dropbox.com/sh/x/y?dl=0").ok, withLink("https://drive.google.com.evil.com/x").ok, withLink("http://drive.google.com/x").ok, withLink("https://www.youtube.com/watch?v=1").ok], [true, true, false, false, false]);
        const both = withLink("https://drive.google.com/x", [mkReady(C)]);
        ok("(X1) videos and a link together work", both.ok);
        const lc = both.out;
        eq("(X1) the link is not a readable column any more; the creator and a joined clipper get it through campaign_footage_link, nobody else", [as(U(A), `select footage_url from public.campaigns where id = '${lc}'`).ok, as(U(C), `select public.campaign_footage_link('${lc}')`).out, as(U(A), `select coalesce(public.campaign_footage_link('${lc}'), 'none')`).out, (as(U(A), `select public.money_join_campaign('${lc}', true)`), as(U(A), `select public.campaign_footage_link('${lc}')`).out), as(U(B), `select coalesce(public.campaign_footage_link('${lc}'), 'none')`).out], [false, "https://drive.google.com/x", "none", "https://drive.google.com/x", "none"]);
        // X2. Report on footage
        const fid = q(`select id from public.campaign_footage where campaign_id = '${lc}' limit 1`);
        const rep = (uid, reason = "spam") => as(U(uid), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(uid)}', 'footage', '${fid}', '${reason}')`);
        eq("(X2) only a clipper who joined can report a video: not the creator, not a stranger, not a teen, not someone signed out", [rep(C).ok, rep(B).ok, rep(TEEN).ok, psql("t", `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(B)}', 'footage', '${fid}', 'spam')`).status === 0], [false, false, false, false]);
        eq("(X2) a joined clipper can, with the same reasons as everything else, and cannot report twice", [rep(A, "nudity").ok, rep(A, "nudity").ok, rep(A, "nonsense").ok], [true, false, false]);
        eq("(X2) a report of a video that does not exist, or is still uploading, is refused", [as(U(A), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(A)}', 'footage', gen_random_uuid(), 'spam')`).ok], [false]);
        eq("(X2) one report does not hide it (the clipper still reads it)", [q(`select status from public.campaign_footage where id = '${fid}'`), readOk(U(A), q(`select storage_path from public.campaign_footage where id = '${fid}'`))], ["ready", "1"]);
        // two more reporters: B and BOTH join, then 3 pending reports hide it
        Q(`insert into public.campaign_members (campaign_id, clipper_id, agreed_terms) values ('${lc}', '${U(B)}', '{}'), ('${lc}', '${U(BOTH)}', '{}') on conflict do nothing`);
        rep(B); rep(BOTH);
        const sp = q(`select storage_path from public.campaign_footage where id = '${fid}'`);
        eq("(X2) at 3 pending reports (the same threshold as posts) the video is hidden from the clippers, its creator still sees the row (status hidden) but nobody reads the file, and its minutes still count", [q(`select status from public.campaign_footage where id = '${fid}'`), readOk(U(A), sp), as(U(A), `select count(*) from public.campaign_footage where id = '${fid}'`).out, as(U(C), `select count(*) from public.campaign_footage where id = '${fid}'`).out, readOk(U(C), sp)], ["hidden", "0", "0", "1", "0"]);
        // admin queue
        const queue = as(U(ADM), `select report_id || '|' || target_type || '|' || coalesce(reported_username, '') || '|' || coalesce(preview, '') || '|' || report_count from public.admin_reports_queue('pending', 50) where target_id = '${fid}' order by created_at limit 1`);
        eq("(X2) the owner's queue lists it with the campaign, the length, who made it and the count; a non-admin cannot read the queue", [/footage\|u60\|Footage in "[^"]+" \(1 min, hidden\)\|3$/.test(queue.out.slice(queue.out.indexOf("|") + 1)), as(U(A), `select * from public.admin_reports_queue('pending', 5)`).ok], [true, false]);
        const rid = queue.out.split("|")[0];
        eq("(X2) 'dismiss' puts an auto-hidden video back and closes every report on it", [as(U(ADM), `select public.admin_report_resolve('${rid}', 'dismiss')`).ok, q(`select status from public.campaign_footage where id = '${fid}'`), q(`select string_agg(distinct status, ',') from public.reports where target_id = '${fid}'`)], [true, "ready", "dismissed"]);
        eq("(X2) 'hide' keeps it hidden, 'remove' deletes it and queues both files; only the owner can resolve", [(() => { Q(`update public.campaign_footage set status = 'ready' where id = '${fid}'; update public.reports set status = 'pending' where target_type = 'footage' and target_id = '${fid}'`); const r2 = q(`select id from public.reports where target_id = '${fid}' and status = 'pending' limit 1`); return [as(U(A), `select public.admin_report_resolve('${r2}', 'remove')`).ok, as(U(ADM), `select public.admin_report_resolve('${r2}', 'hide')`).ok, q(`select status from public.campaign_footage where id = '${fid}'`), as(U(ADM), `select public.admin_report_resolve('${r2}', 'remove')`).ok, q(`select status from public.campaign_footage where id = '${fid}'`), q(`select count(*) from public.trial_media_delete_queue where path like '${U(C)}/${fid}%'`)]; })()], [[false, true, "hidden", true, "deleted", "2"]]);
        // X3. admin totals
        const tot = as(U(ADM), `select files || '|' || total_bytes || '|' || (oldest_at is not null) || '|' || hidden_files from public.admin_footage_storage()`);
        const expect = q(`select count(*) || '|' || coalesce(sum(size_bytes), 0) from public.campaign_footage where status in ('uploading', 'ready', 'hidden')`);
        eq("(X3) the owner sees total files, bytes, the oldest file and hidden files (matching the table); nobody else can", [tot.out.startsWith(expect), /\|true\|\d+$/.test(tot.out), as(U(A), `select * from public.admin_footage_storage()`).ok, as(U(C), `select * from public.admin_footage_storage()`).ok], [true, true, false, false]);
        // X4. account deletion
        Q(`delete from public.trial_media_delete_queue`);
        const SX = 98; mkUser(SX); onboard(SX, "creator");
        const gone = mkReady(SX); const gone2 = reg(U(SX), 30).out.split("|");
        const files = [`${U(SX)}/${gone}.mp4`, `${U(SX)}/${gone}.jpg`, `${U(SX)}/${gone2[0]}.mp4`, `${U(SX)}/${gone2[0]}.jpg`];
        Q(`insert into storage.objects (bucket_id, name, owner) values ('campaign-footage', '${U(SX)}/exports/section-1.mp4', '${U(SX)}'), ('campaign-footage', '${U(C)}/keep.mp4', '${U(C)}')`);
        Q(`insert into storage.buckets (id, name, public) values ('clip-exports', 'clip-exports', false) on conflict do nothing; insert into storage.objects (bucket_id, name, owner) values ('clip-exports', '${U(SX)}/clip.mp4', '${U(SX)}')`);
        eq("(X4) delete_my_footage queues every video, thumbnail (even for an upload in progress) and export of the caller, and nobody else's", [as(U(SX), `select public.delete_my_footage()`).ok, q(`select string_agg(bucket || ':' || path, ',' order by path) from public.trial_media_delete_queue where path like '${U(SX)}/%'`).split(",").length, q(`select count(*) from public.trial_media_delete_queue where path like '${U(C)}/%'`), q(`select string_agg(distinct status, ',') from public.campaign_footage where creator_id = '${U(SX)}'`)], [true, 6, "0", "deleted"]);
        eq("(X4) ...including the export bucket, and running it again changes nothing; a signed-out call is refused", [q(`select count(*) from public.trial_media_delete_queue where bucket = 'clip-exports'`), as(U(SX), `select public.delete_my_footage()`).ok, q(`select count(*) from public.trial_media_delete_queue where path like '${U(SX)}/%'`), psql("t", `select public.delete_my_footage()`).status === 0], ["1", true, "6", false]);
        // the profile row going away (what the delete-user function does) does it too, with no app involved
        const GONE = 99; mkUser(GONE); onboard(GONE, "creator");
        const g = reg(U(GONE), 30).out.split("|"); putFile(g[1], 100, U(GONE)); as(U(GONE), `select public.money_footage_complete('${g[0]}')`);
        Q(`delete from public.trial_media_delete_queue`);
        const del = psql("t", `delete from public.profiles where id = '${U(GONE)}'`, ["-v", "ON_ERROR_STOP=1"]);
        if (del.status !== 0) console.log("profile delete failed:", del.stderr.split("\n")[0]);
        eq("(X4) deleting the profile (the account deletion path, with cascades) queues that person's files by itself, and removes their footage rows", [del.status, q(`select string_agg(path, ',' order by path) from public.trial_media_delete_queue`), q(`select count(*) from public.campaign_footage where creator_id = '${U(GONE)}'`)], [0, `${U(GONE)}/${g[0]}.jpg,${U(GONE)}/${g[0]}.mp4`, "0"]);
        eq("(X4) the new functions are closed to anon, and the internals to apps", [q(`select has_function_privilege('anon', 'public.delete_my_footage()', 'execute')`), q(`select has_function_privilege('authenticated', 'public.money_footage_queue_user_files(uuid)', 'execute')`), q(`select has_function_privilege('authenticated', 'public.delete_my_footage()', 'execute')`)], ["f", "f", "t"]);
      }
      // Y. segmented footage: long videos in 1-minute parts, posted early, streamed, stalled
      {
        Q(`delete from public.reports; delete from public.trial_media_delete_queue; delete from public.campaign_footage where creator_id = '${U(C)}' and campaign_id is null`);
        const regSeg = (uid, dur = 150, w = 1280, h = 720) => as(U(uid), `select string_agg(id || '|' || thumb_path || '|' || segment_seconds || '|' || idx || '|' || start_s || '|' || end_s || '|' || path, '#' order by idx) from public.money_footage_register_segmented(${dur}, ${w}, ${h})`);
        const plan = (r) => r.out.split("#").map((l) => l.split("|"));
        const r1 = regSeg(C);
        const P1 = plan(r1);
        const vid = P1[0][0];
        eq("(Y1) registering a 150 s video gives the plan: 3 one-minute segments [0,60] [60,120] [120,150] with their paths, and the thumbnail path", [r1.ok, P1.map((x) => `${x[3]}:${x[4]}-${x[5]}`), P1[0][2], P1[0][6] === `${U(C)}/${vid}/seg-000.mp4`, P1[2][6] === `${U(C)}/${vid}/seg-002.mp4`, P1[0][1] === `${U(C)}/${vid}.jpg`], [true, ["0:0.00-60.00", "1:60.00-120.00", "2:120.00-150.00"], "60", true, true, true]);
        eq("(Y1) a video of exactly 120 s is 2 segments, 61 s is 2, 60 s is 1; 0 s, over 30 minutes, a clipper and a teen are refused", [plan(regSeg(C, 120)).length, plan(regSeg(C, 61)).length, plan(regSeg(C, 60)).length, regSeg(C, 0).ok, regSeg(C, 1801).ok, regSeg(A).ok, regSeg(TEEN).ok], [2, 2, 1, false, false, false, false]);
        Q(`delete from public.campaign_footage where creator_id = '${U(C)}' and campaign_id is null and id <> '${vid}'`);
        eq("(Y1) minutes are reserved when it is registered (the 60 minute ceiling counts videos that are only partly uploaded)", [regSeg(C, 3600).ok, regSeg(C, 1800).ok].join(), "false,true");   // 150 s + 3600 s > 60 min; 150 s + 1800 s fits
        Q(`delete from public.campaign_footage where creator_id = '${U(C)}' and campaign_id is null and id <> '${vid}'`);
        eq("(Y2) a video with no segment uploaded yet cannot be used for a campaign; it says why", [as(U(C), `select public.money_create_campaign_with_footage('t', 'd', null, 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true, array['${vid}']::uuid[])`).err.includes("have not started uploading")], [true]);
        // uploading a segment: storage policy
        const seg = (i) => `${U(C)}/${vid}/seg-${String(i).padStart(3, "0")}.mp4`;
        const putAsSeg = (uid, path) => as(uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${path}', '${uid}', '{"size": 1000}')`);
        eq("(Y3) the creator can upload each planned segment path and the thumbnail; nobody else can, and nothing outside the plan", [putAsSeg(U(C), seg(0)).ok, putAsSeg(U(C), seg(1)).ok, putAsSeg(U(A), seg(2)).ok, putAsSeg(U(C), seg(9)).ok, putAsSeg(U(C), `${U(C)}/${vid}/extra.mp4`).ok, putAsSeg(U(C), `${U(C)}/${vid}.jpg`).ok], [true, true, false, false, false, true]);
        eq("(Y3) completing a segment checks the file: wrong size and missing file are refused, an unknown segment or someone else's video too", [as(U(C), `select public.money_segment_complete('${vid}', 0, 999)`).ok, as(U(C), `select public.money_segment_complete('${vid}', 2, 1000)`).ok, as(U(C), `select public.money_segment_complete('${vid}', 7, 1000)`).ok, as(U(BOTH), `select public.money_segment_complete('${vid}', 0, 1000)`).ok, as(U(C), `select public.money_segment_complete('${vid}', 0, 0)`).ok], [false, false, false, false, false]);
        const c0 = as(U(C), `select public.money_segment_complete('${vid}', 0, 1000)`);
        eq("(Y3) the first segment makes the video 'partial' (1 of 3 ready, size recorded, thumbnail seen); completing it again is harmless", [c0.out, q(`select status || ':' || segments_ready || '/' || segment_count || ':' || size_bytes || ':' || thumb_ok from public.campaign_footage where id = '${vid}'`), as(U(C), `select public.money_segment_complete('${vid}', 0, 1000)`).out], ["partial", "partial:1/3:1000:true", "partial"]);
        eq("(Y3) an uploaded (ready) segment accepts no more uploads", putAsSeg(U(C), seg(0)).ok, false);
        // posting early
        const cc2 = as(U(C), `select public.money_create_campaign_with_footage('Early', 'd', null, 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true, array['${vid}']::uuid[])`);
        ok("(Y4) a campaign can be posted as soon as the video has its first segment", cc2.ok);
        const cid2 = cc2.out;
        // clippers see it
        const sees = (uid) => as(uid, `select (select count(*) from public.campaign_footage where id = '${vid}') || '/' || (select count(*) from public.campaign_footage_segments where footage_id = '${vid}')`).out;
        const readSeg = (uid, i) => as(uid, `select count(*) from storage.objects where bucket_id = 'campaign-footage' and name = '${seg(i)}'`).out;
        eq("(Y4) before joining, a clipper sees nothing and can read no segment", [sees(U(A)), readSeg(U(A), 0), sees(U(B))], ["0/0", "0", "0/0"]);
        as(U(A), `select public.money_join_campaign('${cid2}', true)`);
        eq("(Y4) after joining, a clipper sees the partial video and ALL its segment rows (to show what is still uploading), reads the READY segment's file but not the one still uploading; the creator reads both", [sees(U(A)), readSeg(U(A), 0), readSeg(U(A), 1), readSeg(U(C), 1), as(U(A), `select string_agg(idx || ':' || status, ',' order by idx) from public.campaign_footage_segments where footage_id = '${vid}'`).out], ["1/3", "1", "0", "1", "0:ready,1:uploading,2:uploading"]);
        eq("(Y4) a clipper cannot touch segments or register, even after joining", [as(U(A), `select public.money_segment_complete('${vid}', 1, 1000)`).ok, as(U(A), `update public.campaign_footage_segments set status = 'ready' where footage_id = '${vid}'`).ok, as(U(A), `delete from public.campaign_footage_segments where footage_id = '${vid}'`).ok], [false, false, false]);
        // the rest keeps arriving after the terms froze
        eq("(Y5) the terms are frozen now (a clipper joined) but the registered video's remaining segments still complete, in any order", [q(`select terms_frozen_at is not null from public.campaigns where id = '${cid2}'`), as(U(C), `select public.money_segment_complete('${vid}', 1, 1000)`).out], ["t", "partial"]);
        putAsSeg(U(C), seg(2)); Q(`update storage.objects set metadata = '{"size": 500}' where name = '${seg(2)}'`);
        eq("(Y5) the last segment makes it 'ready' (3 of 3), with the total size, and the clipper now reads every segment", [as(U(C), `select public.money_segment_complete('${vid}', 2, 500)`).out, q(`select status || ':' || segments_ready || ':' || size_bytes || ':' || (ready_at is not null) from public.campaign_footage where id = '${vid}'`), readSeg(U(A), 2)], ["ready", "ready:3:2500:true", "1"]);
        eq("(Y5) but no NEW video can be added to a frozen campaign, and the old rule still blocks removing it", [as(U(C), `select public.money_footage_remove('${vid}')`).ok, q(`select status from public.campaign_footage where id = '${vid}'`)], [false, "ready"]);
        // reports and hiding on a partial video
        const v2 = plan(regSeg(BOTH, 120))[0][0];
        Q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${U(BOTH)}/${v2}/seg-000.mp4', '${U(BOTH)}', '{"size": 10}')`);
        as(U(BOTH), `select public.money_segment_complete('${v2}', 0, 10)`);
        const cid3 = as(U(BOTH), `select public.money_create_campaign_with_footage('Part', 'd', null, 2, 50, 250, 3, array['tiktok'], 7, 1000, 'paypal', '@c', now() + interval '30 days', 5, true, array['${v2}']::uuid[])`).out;
        Q(`insert into public.campaign_members (campaign_id, clipper_id, agreed_terms) values ('${cid3}', '${U(A)}', '{}'), ('${cid3}', '${U(B)}', '{}'), ('${cid3}', '${U(STR)}', '{}') on conflict do nothing`);
        for (const u of [A, B, STR]) as(U(u), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(u)}', 'footage', '${v2}', 'spam')`);
        eq("(Y6) three reports hide a PARTIAL video too; a clipper then sees no rows and reads no files", [q(`select status from public.campaign_footage where id = '${v2}'`), as(U(A), `select count(*) from public.campaign_footage_segments where footage_id = '${v2}'`).out, as(U(A), `select count(*) from storage.objects where name = '${U(BOTH)}/${v2}/seg-000.mp4'`).out], ["hidden", "0", "0"]);
        const rq = q(`select id from public.reports where target_id = '${v2}' limit 1`);
        eq("(Y6) the owner dismissing the reports puts it back as 'partial' (not 'ready')", [as(U(ADM), `select public.admin_report_resolve('${rq}', 'dismiss')`).ok, q(`select status from public.campaign_footage where id = '${v2}'`)], [true, "partial"]);
        // a late segment on a hidden video keeps it hidden
        Q(`update public.campaign_footage set status = 'hidden' where id = '${v2}'; insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${U(BOTH)}/${v2}/seg-001.mp4', '${U(BOTH)}', '{"size": 10}')`);
        eq("(Y6) a segment that arrives for a hidden video does not un-hide it", [as(U(BOTH), `select public.money_segment_complete('${v2}', 1, 10)`).out, q(`select status from public.campaign_footage where id = '${v2}'`)], ["hidden", "hidden"]);
        // stalled uploads
        const v3 = plan(regSeg(BOTH, 180))[0][0];
        Q(`update public.campaign_footage set last_progress_at = now() - interval '2 days' where id = '${v3}'`);
        const n0 = q(`select public.money_footage_stall_check()`);
        eq("(Y7) a video with no progress for 2 days is not stalled yet", [n0, q(`select stalled_at is null from public.campaign_footage where id = '${v3}'`)], ["0", "t"]);
        Q(`update public.campaign_footage set last_progress_at = now() - interval '4 days' where id = '${v3}'; delete from public.notifications where recipient_id = '${U(BOTH)}'`);
        eq("(Y7) after 3 days it is flagged stalled once, and its creator gets an in-app notification 'footage_stalled'", [q(`select public.money_footage_stall_check()`), q(`select stalled_at is not null from public.campaign_footage where id = '${v3}'`), q(`select count(*) from public.notifications where recipient_id = '${U(BOTH)}' and type = 'footage_stalled'`), q(`select public.money_footage_stall_check()`)], ["1", "t", "1", "0"]);
        Q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${U(BOTH)}/${v3}/seg-000.mp4', '${U(BOTH)}', '{"size": 10}')`);
        eq("(Y7) the next segment clears the flag", [as(U(BOTH), `select public.money_segment_complete('${v3}', 0, 10)`).ok, q(`select stalled_at is null from public.campaign_footage where id = '${v3}'`)], [true, "t"]);
        eq("(Y7) the notification type was added without losing the others, and the check job is scheduled once", [q(`select pg_get_constraintdef(oid) like '%footage_stalled%' and pg_get_constraintdef(oid) like '%report_alert%' and pg_get_constraintdef(oid) like '%verdict_survived%' from pg_constraint where conname = 'notifications_type_check'`), q(`select count(*) from cron.job where jobname = 'money-footage-stall'`)], ["t", "1"]);
        eq("(Y7) the stall check is not callable by apps", q(`select has_function_privilege('authenticated', 'public.money_footage_stall_check()', 'execute')`), "f");
        // deletion covers every segment file
        Q(`delete from public.trial_media_delete_queue`);
        const v4 = plan(regSeg(SX_C(), 130))[0][0];
        function SX_C() { return BOTH; }
        eq("(Y8) removing a video queues EVERY segment file (and the thumbnail), however far the upload got", [as(U(BOTH), `select public.money_footage_remove('${v4}')`).ok, q(`select count(*) from public.trial_media_delete_queue where path like '${U(BOTH)}/${v4}/seg-%'`)], [true, "3"]);
        Q(`delete from public.trial_media_delete_queue`);
        const gone = q(`select id from public.campaign_footage where id = '${v3}'`);
        Q(`update public.campaign_footage set status = 'deleted', deleted_at = now() where id = '${v3}'`);
        eq("(Y8) the purge / owner / report paths (status deleted) queue the segments through the trigger", q(`select count(*) from public.trial_media_delete_queue where path like '${U(BOTH)}/${v3}/seg-%'`), "3");
        Q(`delete from public.trial_media_delete_queue`);
        // account deletion
        const GONE2 = 97; mkUser(GONE2); onboard(GONE2, "creator");
        const v5 = plan(regSeg(GONE2, 130))[0][0];
        Q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('campaign-footage', '${U(GONE2)}/${v5}/seg-000.mp4', '${U(GONE2)}', '{"size": 10}')`);
        const d2 = psql("t", `delete from public.profiles where id = '${U(GONE2)}'`, ["-v", "ON_ERROR_STOP=1"]);
        eq("(Y9) deleting an account queues every segment file, uploaded or only planned", [d2.status, q(`select count(*) from public.trial_media_delete_queue where path like '${U(GONE2)}/${v5}/seg-%'`)], [0, "3"]);
        // owner totals include partial
        const tot2 = as(U(ADM), `select files from public.admin_footage_storage()`);
        eq("(Y9) the owner's totals count partial videos", [tot2.ok, Number(tot2.out) >= 2], [true, true]);
        eq("(Y9) the new functions are callable by signed-in users only", ["public.money_footage_register_segmented(numeric,integer,integer)", "public.money_segment_complete(uuid,integer,bigint)"].map((f) => [q(`select has_function_privilege('authenticated', '${f}', 'execute')`), q(`select has_function_privilege('anon', '${f}', 'execute')`)].join("")), ["tf", "tf"]);
      }
      // V. the read-only check the owner runs after applying
      {
        const chk = psql("t", readFileSync(join(sqlDir, "check-money-footage.sql"), "utf8").replace(/^--.*$/gm, ""), ["-v", "ON_ERROR_STOP=1", "-F", "|"]);
        const rowsV = chk.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("|"));
        eq("(V) check-money-footage.sql runs without error and every row is 'ok' or 'info' after the migration", [chk.status, rowsV.filter((r) => !["ok", "info"].includes(r[1])).map((r) => r[0] + ": " + r[1])], [0, []]);
        eq("(V) it is a single read-only SELECT", /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(readFileSync(join(sqlDir, "check-money-footage.sql"), "utf8").replace(/^--.*$/gm, "")), false);
        const st2 = psql("t", readFileSync(join(sqlDir, "check-money-step2-functions.sql"), "utf8").replace(/^--.*$/gm, ""), ["-v", "ON_ERROR_STOP=1", "-F", "|"]);
        eq("(V) check-money-step2-functions.sql: with the footage file applied every row is 'ok' (except the birthdate lock-down note)", st2.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("|")).filter((r) => r[0] !== "birthdate can be saved in the app" && !r[2].startsWith("ok")), []);
        Q(`update storage.buckets set public = true where id = 'campaign-footage'`);
        const bad = psql("t", readFileSync(join(sqlDir, "check-money-footage.sql"), "utf8").replace(/^--.*$/gm, ""), ["-F", "|"]).stdout;
        eq("(V) a public bucket is reported loudly", /NOT PRIVATE/.test(bad), true);
        Q(`update storage.buckets set public = false where id = 'campaign-footage'`);
      }
      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
