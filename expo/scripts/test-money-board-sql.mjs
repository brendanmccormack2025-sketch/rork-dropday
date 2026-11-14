#!/usr/bin/env node
/**
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

      const yearsAgo = (y, extraDays = 0) => q(`select (current_date - interval '${y} years' - interval '${extraDays} days')::date`);
      const su = (uid, sql) => { const r = psql("t", `set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const feat = (n) => JSON.parse(as(U(n), `select public.my_features()`).out);
      const sql1 = (e) => q(`select ${e}`);
      const MONEY = [...Array(40).keys()].map((i) => 60 + i);
      const RULES = { creator: ["pay_on_time", "terms_freeze", "auto_approval_48h", "not_part_of_payment", "own_footage_rights"], clipper: ["only_real_views", "submit_through_tryal", "upload_proof_on_time", "not_part_of_payment"] };
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

      // ── A. every money table is closed to apps for writing, and RLS is on ──
      const TABLES = ["campaigns", "campaign_members", "campaign_submissions", "submission_links", "submission_disputes", "payment_cases", "money_reviews", "money_strikes"];
      eq("(A) row level security is on for every money table", TABLES.concat(["money_profiles", "money_config"]).map((t) => q(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)), Array(10).fill("t"));
      eq("(A) apps have no insert / update / delete on any money table", TABLES.concat(["money_profiles", "money_config"]).map((t) => ["authenticated", "anon"].some((r) => ["insert", "update", "delete"].some((p) => q(`select has_table_privilege('${r}', 'public.${t}', '${p}')`) === "t"))), Array(10).fill(false));
      eq("(A) the walkthrough table and the config are not even readable", [as(U(C), `select count(*) from public.money_profiles`).ok, as(U(C), `select count(*) from public.money_config`).ok], [false, false]);
      eq("(A) a direct insert into a money table is refused", [as(U(C), `insert into public.campaigns (creator_id, title, description, footage_url, rate_per_1k, cap_per_clip, total_budget, platforms, payment_method, payment_handle, deadline, agreement_version) values ('${U(C)}','t','d','https://drive.google.com/x',1,5,100,array['tiktok'],'paypal','a@b.co', now() + interval '5 days', 1)`).ok, as(U(A), `insert into public.money_strikes (user_id, kind) values ('${U(C)}', 'late_payment')`).ok], [false, false]);

      // ── B. who is allowed: 18+, not banned, finished the walkthrough ──
      eq("(B) an onboarded adult is ready", [feat(C).ready, feat(C).allowed, feat(C).needs_onboarding], [true, true, false]);
      eq("(B) an adult who has not done the walkthrough: allowed but not ready, and asked to onboard", [feat(NOTOB).allowed, feat(NOTOB).ready, feat(NOTOB).needs_onboarding], [true, false, true]);
      eq("(B) a teen and a person without a birthdate are neither allowed nor ready", [feat(TEEN).ready, feat(TEEN).allowed, feat(NOBD).ready, feat(NOBD).allowed], [false, false, false, false]);
      eq("(B) a teen cannot even start the walkthrough", as(U(TEEN), `select public.money_complete_onboarding('clipper', ${arr(RULES.clipper)})`).ok, false);
      eq("(B) the walkthrough needs every rule ticked for the role (server-side)", [as(U(NOTOB), `select public.money_complete_onboarding('creator', ${arr(RULES.creator.slice(1))})`).ok, as(U(NOTOB), `select public.money_complete_onboarding('both', ${arr(RULES.clipper)})`).ok, as(U(NOTOB), `select public.money_complete_onboarding('nope', ${arr(RULES.clipper)})`).ok, as(U(NOTOB), `select public.money_complete_onboarding('clipper', null)`).ok], [false, false, false, false]);
      eq("(B) 'both' needs the union of the creator and clipper rules", [onboard(NOTOB, "both").ok, JSON.parse(as(U(NOTOB), `select public.my_money_profile()`).out).role], [true, "both"]);
      Q(`delete from public.money_profiles where user_id = '${U(NOTOB)}'`);
      eq("(B) the agreement is stored with the version, in the closed table", [q(`select money_agreement_version || ':' || money_role || ':' || (money_onboarded_at is not null) from public.money_profiles where user_id = '${U(A)}'`)], ["1:clipper:true"]);
      Q(`update public.money_config set agreement_version = 2`);
      eq("(B) a new agreement version makes everybody read and tick it again", [feat(C).ready, feat(C).needs_onboarding, JSON.parse(as(U(C), `select public.my_money_profile()`).out).current_agreement_version], [false, true, 2]);
      eq("(B) ...and ticking again makes them ready", [onboard(C, "creator").ok, feat(C).ready], [true, true]);
      for (const n of [A, B, BOTH, BANNED, STR]) onboard(n, n === BOTH ? "both" : "clipper");
      eq("(B) everyone re-onboarded", [A, B, BOTH, BANNED, STR].map((n) => feat(n).ready), Array(5).fill(true));

      // money_banned: only an admin or the SQL editor can change it
      eq("(B) a user cannot set money_banned (and writing the same value is a no-op)", [as(U(A), `update public.profiles set money_banned = false where id='${U(A)}'`).ok, as(U(A), `update public.profiles set money_banned = true where id='${U(A)}'`).ok, q(`select money_banned::text from public.profiles where id='${U(A)}'`)], [true, false, "false"]);
      eq("(B) a banned user cannot lift their own ban either", (() => { Q(`update public.profiles set money_banned = true where id='${U(BANNED)}'`); const r = [as(U(BANNED), `update public.profiles set money_banned = false where id='${U(BANNED)}'`).ok, q(`select money_banned::text from public.profiles where id='${U(BANNED)}'`)]; Q(`update public.profiles set money_banned = false where id='${U(BANNED)}'`); return r; })(), [false, "true"]);
      Q(`update public.profiles set money_banned = true where id='${U(BANNED)}'`);
      eq("(B) a banned account is not allowed, not ready, and the tab is hidden", (() => { const f = feat(BANNED); return [f.allowed, f.ready, f.money]; })(), [false, false, false]);
      eq("(B) an admin bans and unbans through admin_money_set_banned (logged); nobody else can call it", (() => { const a = as(U(ADM), `select public.admin_money_set_banned('${U(BANNED)}', true, 'test')`).ok; const b = q(`select money_banned::text from public.profiles where id='${U(BANNED)}'`); const c = as(U(ADM), `select public.admin_money_set_banned('${U(BANNED)}', false)`).ok; const d = q(`select money_banned::text from public.profiles where id='${U(BANNED)}'`); return [a, b, c, d, as(U(A), `select public.admin_money_set_banned('${U(BANNED)}', true)`).ok, q(`select count(*) from public.moderation_log where action in ('money_ban','money_unban') and target_user = '${U(BANNED)}'`)]; })(), [true, "true", true, "false", false, "2"]);
      eq("(B) a sanctioned (suspended) account is not ready", (() => { Q(`insert into public.account_sanctions (user_id, kind, until, created_by) values ('${U(STR)}', 'suspend', now() + interval '2 days', '${U(ADM)}')`); const r = feat(STR).ready; Q(`update public.account_sanctions set lifted_at = now() where user_id = '${U(STR)}'`); return [r, feat(STR).ready]; })(), [false, true]);

      // ── C. campaign validation (create RPC) ──
      const deadline = "now() + interval '10 days'";
      const ARGS = (o = {}) => { const d = { title: "Clip my podcast", description: "Funny moments, no spoilers", url: "https://drive.google.com/drive/folders/abc", rate: 1.5, cap: 20, budget: 200, guar: 3, plats: ["tiktok", "instagram"], win: 7, minv: 1000, method: "paypal", handle: "pay@example.com", dl: deadline, maxc: 2, agree: "true", ...o };
        return `'${d.title.replace(/'/g, "''")}', '${d.description.replace(/'/g, "''")}', '${d.url}', ${d.rate}, ${d.cap}, ${d.budget}, ${d.guar}, ${arr(d.plats)}, ${d.win}, ${d.minv}, '${d.method}', '${d.handle}', ${d.dl}, ${d.maxc}, ${d.agree}`; };
      const create = (uid, o) => as(uid, `select public.money_create_campaign(${ARGS(o)})`);
      const bad = (label, o) => eq(`(C) refused: ${label}`, create(U(C), o).ok, false);
      const good = (label, o) => eq(`(C) accepted: ${label}`, create(U(C), o).ok, true);
      good("a normal campaign", {});
      bad("title over 60 characters", { title: "x".repeat(61) });
      bad("an empty title", { title: "" });
      bad("a description over 1000 characters", { description: "y".repeat(1001) });
      bad("footage on another host", { url: "https://evil.com/drive.google.com" });
      bad("footage with a look-alike host", { url: "https://drive.google.com.evil.com/x" });
      bad("footage with a user@host trick", { url: "https://drive.google.com@evil.com/x" });
      bad("footage over plain http", { url: "http://drive.google.com/x" });
      bad("footage that is a YouTube link", { url: "https://www.youtube.com/watch?v=1" });
      good("a Dropbox share link", { url: "https://www.dropbox.com/sh/abc/xyz?dl=0" });
      good("a bare dropbox.com link", { url: "https://dropbox.com/s/abc/file" });
      bad("a host that only ends like dropbox.com", { url: "https://notdropbox.com/x" });
      bad("rate 0", { rate: 0 }); bad("negative cap", { cap: -1 }); bad("budget 0", { budget: 0 });
      bad("a budget smaller than one clip's maximum (guarantee + cap)", { budget: 22, cap: 20, guar: 3 });
      bad("a negative guarantee", { guar: -1 });
      good("no guarantee", { guar: 0 });
      bad("no platforms", { plats: [] }); bad("an unknown platform", { plats: ["myspace"] });
      good("all four platforms, mixed case", { plats: ["TikTok", "instagram", "YouTube", "x"] });
      bad("a view window of 2 days", { win: 2 }); bad("a view window of 15 days", { win: 15 });
      good("a view window of 3 and of 14 days", { win: 3 }); good("14", { win: 14 });
      bad("negative min views", { minv: -1 });
      bad("an unknown payment method", { method: "zelle" });
      for (const h of ["https://paypal.me/someone", "venmo://paycharge?txn=pay", "paypal.me", "cash.app/$name", "my handle", "http://x.co", "a", "www.pay.com", "$$"]) bad(`a payment handle that is a link or not plain text (${h})`, { handle: h });
      for (const [m, h] of [["venmo", "@some-user_1"], ["cashapp", "$cashtag"], ["paypal", "name.surname+tips@mail.example.com"]]) good(`a plain ${m} handle (${h})`, { method: m, handle: h });
      bad("a deadline in the past", { dl: "now() - interval '1 day'" }); bad("a deadline within the hour", { dl: "now() + interval '10 minutes'" }); bad("a deadline over a year away", { dl: "now() + interval '400 days'" });
      bad("max clips 0", { maxc: 0 }); bad("max clips 51", { maxc: 51 });
      bad("the agreement not accepted", { agree: "false" }); bad("the agreement left out", { agree: "null" });
      bad("a title with a blocked word", { title: "please kill yourself" });
      bad("a description with a blocked word", { description: "go die" });
      eq("(C) a clipper-only account cannot create campaigns; a teen, a not-onboarded account and a banned account cannot either", [create(U(A), {}).ok, create(U(TEEN), {}).ok, create(U(NOTOB), {}).ok, (() => { Q(`update public.profiles set money_banned = true where id='${U(BANNED)}'`); const r = create(U(BANNED), {}).ok; Q(`update public.profiles set money_banned = false where id='${U(BANNED)}'`); return r; })()], [false, false, false, false]);
      eq("(C) a creator with an overdue-payment pause cannot create a campaign until it is resolved", (() => { const id = q(`select id from public.campaigns where creator_id = '${U(C)}' limit 1`); Q(`update public.campaigns set status = 'paused', paused_reason = 'overdue_payment' where id = '${id}'`); const r = create(U(C), {}).ok; Q(`update public.campaigns set status = 'open', paused_reason = null where id = '${id}'`); return [r, create(U(C), {}).ok]; })(), [false, true]);
      eq("(C) the client cannot choose the owner: the campaign belongs to the caller, with the agreement version recorded", q(`select count(*) filter (where creator_id = '${U(C)}')::text || ':' || bool_and(agreement_version = 2)::text from public.campaigns`), q(`select count(*)::text || ':true' from public.campaigns`));
      Q(`delete from public.campaigns`);

      // one campaign for the rest
      const newCamp = (o = {}, uid = U(C)) => { const r = create(uid, o); return r.out; };
      const camp = newCamp({ maxc: 2, budget: 100, cap: 20, guar: 3 });
      ok("(C) the campaign for the next checks exists", /^[0-9a-f-]{36}$/.test(camp));

      // ── D. what each person can see ──
      eq("(D) a ready adult sees the open campaign in Browse; the creator sees it too", [as(U(A), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(C), `select count(*) from public.campaigns where id='${camp}'`).out], ["1", "1"]);
      eq("(D) under-18, no-birthdate, not-onboarded and banned accounts see no campaigns at all", [TEEN, NOBD, NOTOB].map((n) => as(U(n), `select count(*) from public.campaigns`).out).concat([(() => { Q(`update public.profiles set money_banned = true where id='${U(BANNED)}'`); const r = as(U(BANNED), `select count(*) from public.campaigns`).out; Q(`update public.profiles set money_banned = false where id='${U(BANNED)}'`); return r; })()]), ["0", "0", "0", "0"]);
      eq("(D) a signed-out visitor reads nothing (no grant)", TABLES.map((t) => psql("t", `set role anon; select count(*) from public.${t}`, ["-v", "ON_ERROR_STOP=1"]).status !== 0), Array(8).fill(true));
      eq("(D) the payment handle is not a column apps can read, not even for the creator or with select *", [as(U(A), `select payment_handle from public.campaigns`).ok, as(U(C), `select payment_handle from public.campaigns`).ok, as(U(A), `select * from public.campaigns`).ok], [false, false, false]);
      eq("(D) the card columns are readable (payment method text, rate, cap, budget left)", as(U(A), `select title, payment_method, rate_per_1k, cap_per_clip, guaranteed_per_clip, total_budget, budget_committed, platforms, deadline, status from public.campaigns where id='${camp}'`).ok, true);
      eq("(D) only the creator and members get the payment handle, as plain text", [as(U(A), `select public.campaign_payment_info('${camp}')`).ok, as(U(C), `select public.campaign_payment_info('${camp}')->>'payment_handle'`).out], [false, "pay@example.com"]);

      // blocks
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(C)}','${U(STR)}')`);
      eq("(D) a creator who blocked someone: the blocked person no longer sees their campaigns and cannot join", [as(U(STR), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(STR), `select public.money_join_campaign('${camp}', true)`).ok], ["0", false]);
      Q(`delete from public.user_blocks`);
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(STR)}','${U(C)}')`);
      eq("(D) a clipper who blocked the creator no longer sees their campaigns and cannot join", [as(U(STR), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(STR), `select public.money_join_campaign('${camp}', true)`).ok], ["0", false]);
      eq("(D) ...and the DB refuses even a direct membership insert between blocked people", su(U(STR), `insert into public.campaign_members (campaign_id, clipper_id, agreed_terms) values ('${camp}','${U(STR)}','{}')`).ok, false);
      Q(`delete from public.user_blocks`);

      // ── E. joining, and the freeze ──
      eq("(E) the creator cannot join their own campaign; a creator-only account cannot join; not-onboarded cannot", [as(U(C), `select public.money_join_campaign('${camp}', true)`).ok, as(U(NOTOB), `select public.money_join_campaign('${camp}', true)`).ok, as(U(TEEN), `select public.money_join_campaign('${camp}', true)`).ok], [false, false, false]);
      eq("(E) joining needs the Clipper Agreement", as(U(A), `select public.money_join_campaign('${camp}', false)`).ok, false);
      eq("(E) before anyone joins the terms are not frozen", q(`select (terms_frozen_at is null)::text from public.campaigns where id='${camp}'`), "true");
      eq("(E) before the freeze the creator can edit through money_update_campaign", [as(U(C), `select public.money_update_campaign('${camp}', '{"rate_per_1k": 2.00, "title": "Clip my podcast v2"}'::jsonb)`).ok, q(`select rate_per_1k::text from public.campaigns where id='${camp}'`)], [true, "2.00"]);
      eq("(E) ...but only the listed fields, and invalid values are still refused", [as(U(C), `select public.money_update_campaign('${camp}', '{"creator_id": "${U(A)}"}'::jsonb)`).ok, as(U(C), `select public.money_update_campaign('${camp}', '{"footage_url": "https://evil.com/x"}'::jsonb)`).ok, as(U(C), `select public.money_update_campaign('${camp}', '{"payment_handle": "https://paypal.me/x"}'::jsonb)`).ok, as(U(A), `select public.money_update_campaign('${camp}', '{"title": "mine now"}'::jsonb)`).ok], [false, false, false, false]);
      eq("(E) a clipper joins; the membership stores the terms they saw", [as(U(A), `select public.money_join_campaign('${camp}', true)`).ok, q(`select (agreed_terms->>'rate_per_1k') || ':' || (agreed_terms->>'clipper_agreement_version') from public.campaign_members where clipper_id='${U(A)}'`)], [true, "2.00:2"]);
      eq("(E) the first join froze the terms", q(`select (terms_frozen_at is not null)::text from public.campaigns where id='${camp}'`), "true");
      const frozenAt = q(`select terms_frozen_at from public.campaigns where id='${camp}'`);
      as(U(B), `select public.money_join_campaign('${camp}', true)`);
      eq("(E) a second join does not move the freeze time", q(`select terms_frozen_at from public.campaigns where id='${camp}'`), frozenAt);
      eq("(E) joining twice is harmless", [as(U(A), `select public.money_join_campaign('${camp}', true)`).ok, q(`select count(*) from public.campaign_members where clipper_id='${U(A)}'`)], [true, "1"]);
      const FROZEN = { title: "'new'", description: "'new'", footage_url: "'https://drive.google.com/new'", rate_per_1k: "9", cap_per_clip: "30", total_budget: "500", guaranteed_per_clip: "1", platforms: "array['x']", view_window_days: "10", min_views: "5", payment_method: "'venmo'", payment_handle: "'@new'", deadline: "now() + interval '20 days'", max_clips_per_clipper: "9" };
      for (const [col, val] of Object.entries(FROZEN)) eq(`(E) frozen: the creator cannot change ${col} (database trigger, even around the RPC)`, su(U(C), `update public.campaigns set ${col} = ${val} where id='${camp}'`).ok, false);
      eq("(E) frozen: money_update_campaign refuses too; terms_frozen_at cannot be cleared", [as(U(C), `select public.money_update_campaign('${camp}', '{"rate_per_1k": 3}'::jsonb)`).ok, su(U(C), `update public.campaigns set terms_frozen_at = null where id='${camp}'`).ok, su(U(C), `update public.campaigns set creator_id = '${U(A)}' where id='${camp}'`).ok], [false, false, false]);
      eq("(E) frozen: the system's columns (status, budget) still move, and the owner can fix a typo in the SQL editor", [su(U(C), `update public.campaigns set budget_committed = budget_committed where id='${camp}'`).ok, q(`select rate_per_1k::text from public.campaigns where id='${camp}'`), (() => { Q(`update public.campaigns set description = 'fixed by owner' where id='${camp}'`); return q(`select description from public.campaigns where id='${camp}'`); })()], [true, "2.00", "fixed by owner"]);

      // who sees what in members / submissions
      eq("(E) a clipper sees only their own membership; the creator sees both", [as(U(A), `select count(*) from public.campaign_members`).out, as(U(C), `select count(*) from public.campaign_members`).out, as(U(STR), `select count(*) from public.campaign_members`).out], ["1", "2", "0"]);
      eq("(E) members keep seeing the campaign after it is paused or closed; strangers do not", (() => { Q(`update public.campaigns set status = 'paused', paused_reason = 'creator' where id='${camp}'`); const r = [as(U(A), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(STR), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(C), `select count(*) from public.campaigns where id='${camp}'`).out]; Q(`update public.campaigns set status = 'open', paused_reason = null where id='${camp}'`); return r; })(), ["1", "0", "1"]);
      eq("(E) a campaign past its deadline leaves Browse for strangers and refuses new members", (() => { Q(`update public.campaigns set deadline = now() - interval '1 hour' where id='${camp}'`); const r = [as(U(STR), `select count(*) from public.campaigns where id='${camp}'`).out, as(U(STR), `select public.money_join_campaign('${camp}', true)`).ok]; Q(`update public.campaigns set deadline = now() + interval '10 days' where id='${camp}'`); return r; })(), ["0", false]);
      eq("(E) a banned creator's campaigns disappear from Browse", (() => { Q(`update public.profiles set money_banned = true where id='${U(C)}'`); const r = as(U(STR), `select count(*) from public.campaigns where id='${camp}'`).out; Q(`update public.profiles set money_banned = false where id='${U(C)}'`); return r; })(), "0");

      // ── F. a clip posted for the campaign becomes a submission ──
      const postClip = (uid, o = {}) => { const id = o.id ?? q("select gen_random_uuid()"); const r = as(uid, `insert into public.posts (id, user_id, media_url, media_type, campaign_id, clipped_for_user_id, edited_in_tryal${o.status ? ", status" : ""}) values ('${id}', '${uid}', 'https://x.supabase.co/storage/v1/object/public/drops/c.mp4', 'video', ${o.camp === null ? "null" : `'${o.camp ?? camp}'`}, ${o.fake ? `'${o.fake}'` : "null"}, ${o.edited ? "true" : "false"}${o.status ? `, '${o.status}'` : ""})`); return { ...r, id }; };
      const subs = (n) => q(`select count(*) from public.campaign_submissions where clipper_id = '${U(n)}' and campaign_id = '${camp}'`);
      Q(`delete from public.trial_assignments; update public.trial_engine_config set max_active_trials = 2`);
      const p1 = postClip(U(A), { fake: U(STR), edited: true });
      eq("(F) posting with a campaign creates the submission (status 'posted', outcome testing)", [p1.ok, q(`select status || ':' || post_outcome from public.campaign_submissions where post_id = '${p1.id}'`)], [true, "posted:testing"]);
      eq("(F) the server sets clipped_for_user_id to the creator whatever the client sent, and edited_in_tryal is false (no editor proof yet)", q(`select (clipped_for_user_id = '${U(C)}')::text || ':' || edited_in_tryal::text from public.posts where id = '${p1.id}'`), "true:false");
      eq("(F) a non-member cannot post for the campaign, and no post row is left behind", (() => { const r = postClip(U(STR)); return [r.ok, q(`select count(*) from public.posts where id = '${r.id}'`)]; })(), [false, "0"]);
      eq("(F) a campaign post cannot be a reaction", (() => { const id = q("select gen_random_uuid()"); return as(U(A), `insert into public.posts (id, user_id, media_url, media_type, parent_post_id, campaign_id) values ('${id}','${U(A)}','u','video','${p1.id}','${camp}')`).ok; })(), false);
      eq("(F) the creator cannot post a clip for their own campaign, and a post for an unknown campaign fails", [postClip(U(C)).ok, postClip(U(A), { camp: "00000000-0000-0000-0000-00000000dead" }).ok], [false, false]);
      eq("(F) an ordinary post is untouched (no campaign, no forced fields beyond clearing them)", (() => { const r = postClip(U(A), { camp: null, fake: U(C), edited: true }); return [r.ok, q(`select (clipped_for_user_id is null)::text || ':' || edited_in_tryal || ':' || (select count(*) from public.campaign_submissions where post_id = '${r.id}') from public.posts where id = '${r.id}'`)]; })(), [true, "true:false:0"]);

      // the queue: the clipper already has 2 posts on trial (p1 + the ordinary one), so the next post is queued but still counts at once
      const p2 = postClip(U(A));
      eq("(F) a third post goes into the creator's queue (status 'queued') and the submission exists at once with outcome 'queued'", [q(`select status from public.posts where id = '${p2.id}'`), q(`select status || ':' || post_outcome from public.campaign_submissions where post_id = '${p2.id}'`)], ["queued", "posted:queued"]);
      eq("(F) it counts toward max_clips_per_clipper immediately: the limit of 2 is reached, the next post is refused and leaves nothing behind", (() => { const r = postClip(U(A)); return [subs(A), r.ok, q(`select count(*) from public.posts where id = '${r.id}'`), subs(A)]; })(), ["2", false, "0", "2"]);
      eq("(F) a direct submission insert past the limit is refused as well (no other path in)", su(U(A), `insert into public.campaign_submissions (campaign_id, clipper_id) values ('${camp}','${U(A)}')`).ok, false);
      eq("(F) another member has their own allowance", [postClip(U(B)).ok, subs(B)], [true, "1"]);

      // the post's life moves the submission's outcome
      Q(`update public.posts set status = 'survived', survived_at = now(), distribution_started_at = now(), distribution_expires_at = now() + interval '24 hours' where id = '${p1.id}'`);
      eq("(F) survived post: outcome 'survived'", q(`select post_outcome from public.campaign_submissions where post_id = '${p1.id}'`), "survived");
      Q(`select public.trial_start_next_queued('${U(A)}')`);
      eq("(F) the queued post starts its trial when a slot frees up: outcome 'testing' (the submission did not change otherwise)", [q(`select status from public.posts where id = '${p2.id}'`), q(`select status || ':' || post_outcome from public.campaign_submissions where post_id = '${p2.id}'`)], ["trial", "posted:testing"]);
      Q(`update public.posts set status = 'unjudged' where id = '${p2.id}'`);
      eq("(F) unjudged post: outcome 'unjudged'", q(`select post_outcome from public.campaign_submissions where post_id = '${p2.id}'`), "unjudged");
      // a failed post is deleted by the engine: the submission stays, counts, and says 'failed'
      const pf = postClip(U(B));
      Q(`insert into public.trial_post_state (post_id, decision, decided_at, posterior_mean) values ('${pf.id}','failed', now(), 0.1) on conflict (post_id) do update set decision = 'failed'`);
      Q(`select public.trial_delete_failed_post('${pf.id}')`);
      eq("(F) a post that FAILED and is deleted: the submission remains with outcome 'failed' and no post, and still counts", [q(`select count(*) from public.posts where id = '${pf.id}'`), q(`select post_outcome || ':' || (post_id is null) from public.campaign_submissions where campaign_id = '${camp}' and clipper_id = '${U(B)}' order by created_at desc limit 1`), subs(B)], ["0", "failed:true", "2"]);
      eq("(F) the clipper deleting their own post: outcome 'removed', still counted", (() => { const r = postClip(U(BOTH)); return r.ok; })(), false);
      eq("(F) (a clipper-role-less account cannot submit: 'both' has not joined)", q(`select count(*) from public.campaign_submissions where clipper_id = '${U(BOTH)}'`), "0");
      as(U(BOTH), `select public.money_join_campaign('${camp}', true)`);
      const pr = postClip(U(BOTH));
      eq("(F) deleting your own campaign post: outcome 'removed', the submission stays", [as(U(BOTH), `delete from public.posts where id = '${pr.id}'`).ok, q(`select post_outcome || ':' || (post_id is null) from public.campaign_submissions where clipper_id = '${U(BOTH)}'`), subs(BOTH)], [true, "removed:true", "1"]);
      eq("(F) the submission is visible to its clipper and to the creator, not to another member or a stranger", (() => { const id = q(`select id from public.campaign_submissions where post_id = '${p1.id}'`); return [as(U(A), `select count(*) from public.campaign_submissions where id='${id}'`).out, as(U(C), `select count(*) from public.campaign_submissions where id='${id}'`).out, as(U(B), `select count(*) from public.campaign_submissions where id='${id}'`).out, as(U(STR), `select count(*) from public.campaign_submissions where id='${id}'`).out]; })(), ["1", "1", "0", "0"]);
      eq("(F) a clip for a closed campaign, or one past its deadline, is refused", (() => { Q(`update public.campaigns set status = 'closed' where id='${camp}'`); const a = postClip(U(B)).ok; Q(`update public.campaigns set status = 'open', deadline = now() - interval '1 minute' where id='${camp}'`); const b = postClip(U(B)).ok; Q(`update public.campaigns set deadline = now() + interval '10 days' where id='${camp}'`); return [a, b]; })(), [false, false]);
      eq("(F) after being blocked, the creator no longer sees that clipper's submissions, but the clipper still sees their own (they may be owed money)", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(C)}','${U(A)}')`); const r = [as(U(C), `select count(*) from public.campaign_submissions where clipper_id = '${U(A)}'`).out, as(U(A), `select count(*) from public.campaign_submissions where clipper_id = '${U(A)}'`).out]; Q(`delete from public.user_blocks`); return r; })(), ["0", "2"]);

      // ── G. the amount owed ──
      const owedCamp = newCamp({ rate: 1.5, cap: 20, guar: 3, budget: 1000, minv: 1000, maxc: 50, title: "Owed math" });
      as(U(A), `select public.money_join_campaign('${owedCamp}', true)`);
      Q(`insert into public.campaign_submissions (campaign_id, clipper_id) values ('${owedCamp}', '${U(A)}')`);
      const sid = q(`select id from public.campaign_submissions where campaign_id = '${owedCamp}'`);
      const owed = (views, waived = false) => { Q(`update public.campaign_submissions set views_claimed = ${views === null ? "null" : views}, proof_waived = ${waived} where id = '${sid}'`); return q(`select coalesce(amount_owed::text, 'null') from public.campaign_submissions where id = '${sid}'`); };
      eq("(G) no views yet: nothing owed", owed(null), "null");
      eq("(G) below min_views (999): only the guarantee", owed(999), "3.00");
      eq("(G) exactly min_views (1000): guarantee + 1000/1000 x 1.50", owed(1000), "4.50");
      eq("(G) the spec's example: 10,000 views x 1.50 = 15 (+3)", owed(10000), "18.00");
      eq("(G) the cap applies to the per-view part (100,000 views would be 150, capped at 20, plus the guarantee)", owed(100000), "23.00");
      eq("(G) rounded to cents: 1,234 views -> 1.851 -> 1.85; 1,250 views -> 1.875 -> 1.88", [owed(1234), owed(1250)], ["4.85", "4.88"]);
      eq("(G) zero views: guarantee only", owed(0), "3.00");
      eq("(G) proof waived (late proof): the guaranteed amount only, whatever the views", owed(50000, true), "3.00");
      eq("(G) a client cannot write amount_owed: whatever is written is replaced", (() => { Q(`update public.campaign_submissions set proof_waived = false, views_claimed = 2000 where id='${sid}'`); su(U(A), `update public.campaign_submissions set amount_owed = 999 where id='${sid}'`); su(U(C), `update public.campaign_submissions set amount_owed = 999 where id='${sid}'`); return q(`select amount_owed::text from public.campaign_submissions where id='${sid}'`); })(), "6.00");
      eq("(G) apps cannot update a submission at all (no write grant)", [as(U(A), `update public.campaign_submissions set views_claimed = 1000000 where id='${sid}'`).ok, as(U(C), `update public.campaign_submissions set status = 'approved' where id='${sid}'`).ok], [false, false]);
      eq("(G) the admin 'adjust views' correction recomputes the amount", (() => { Q(`update public.campaign_submissions set views_claimed = 3000 where id='${sid}'`); return q(`select amount_owed::text from public.campaign_submissions where id='${sid}'`); })(), "7.50");

      // ── H. budget_committed and auto-close ──
      eq("(H) pending clips do not count toward the budget", q(`select budget_committed::text from public.campaigns where id='${owedCamp}'`), "0.00");
      Q(`update public.campaign_submissions set status = 'approved', approved_at = now(), approval_source = 'creator' where id = '${sid}'`);
      eq("(H) an approved clip commits its owed amount", q(`select budget_committed::text from public.campaigns where id='${owedCamp}'`), "7.50");
      Q(`update public.campaign_submissions set views_claimed = 5000 where id = '${sid}'`);
      eq("(H) ... and follows later corrections", q(`select budget_committed::text from public.campaigns where id='${owedCamp}'`), "10.50");
      Q(`update public.campaign_submissions set status = 'rejected' where id = '${sid}'`);
      eq("(H) a rejected clip commits nothing", q(`select budget_committed::text from public.campaigns where id='${owedCamp}'`), "0.00");
      const smallCamp = newCamp({ rate: 1, cap: 5, guar: 0, budget: 10, minv: 0, maxc: 10, title: "Small budget" });
      as(U(B), `select public.money_join_campaign('${smallCamp}', true)`);
      Q(`insert into public.campaign_submissions (campaign_id, clipper_id, views_claimed, status) values ('${smallCamp}','${U(B)}', 4000, 'approved'), ('${smallCamp}','${U(B)}', 9000, 'approved')`);
      eq("(H) committed reaches the total budget: the campaign closes itself (reason 'budget')", q(`select budget_committed::text || ':' || status || ':' || coalesce(closed_reason, '-') from public.campaigns where id='${smallCamp}'`), "9.00:open:-");
      Q(`insert into public.campaign_submissions (campaign_id, clipper_id, views_claimed, status) values ('${smallCamp}','${U(B)}', 1000, 'approved')`);
      eq("(H) 4 + 5 + 1 = 10 >= 10: closed for budget, and a new clip is refused", [q(`select budget_committed::text || ':' || status || ':' || closed_reason from public.campaigns where id='${smallCamp}'`), su(U(B), `insert into public.campaign_submissions (campaign_id, clipper_id) values ('${smallCamp}','${U(B)}')`).ok], ["10.00:closed:budget", false]);

      // ── I. strikes and bans ──
      mk(70, "creator"); mk(71, "creator"); mk(72, "creator");
      const c70 = newCamp({ title: "Strike 70" }, U(70));
      Q(`insert into public.money_strikes (user_id, kind) values ('${U(70)}', 'late_payment')`);
      eq("(I) one late payment is a strike, not a ban", [q(`select money_banned::text from public.profiles where id='${U(70)}'`), feat(70).allowed], ["false", true]);
      Q(`insert into public.money_strikes (user_id, kind) values ('${U(70)}', 'late_payment')`);
      eq("(I) two late payments: money_banned, no Money access, and their open campaigns pause", [q(`select money_banned::text from public.profiles where id='${U(70)}'`), feat(70).allowed, q(`select status || ':' || paused_reason from public.campaigns where id='${c70}'`)], ["true", false, "paused:creator_banned"]);
      Q(`insert into public.money_strikes (user_id, kind) values ('${U(71)}', 'non_payment')`);
      eq("(I) one confirmed non-payment bans at once", q(`select money_banned::text from public.profiles where id='${U(71)}'`), "true");
      Q(`insert into public.money_strikes (user_id, kind) values ('${U(72)}', 'fake_views')`);
      eq("(I) confirmed fake views ban the clipper the same way", q(`select money_banned::text from public.profiles where id='${U(72)}'`), "true");
      eq("(I) an admin can lift a ban; their paused campaigns stay paused until they act", (() => { Q(`update public.profiles set money_banned = false where id='${U(70)}'`); return [feat(70).allowed, q(`select status from public.campaigns where id='${c70}'`)]; })(), [true, "paused"]);
      eq("(I) a user sees their own strikes and nobody else's; apps cannot write them", [as(U(70), `select count(*) from public.money_strikes`).out, as(U(C), `select count(*) from public.money_strikes`).out, as(U(70), `insert into public.money_strikes (user_id, kind) values ('${U(70)}','late_payment')`).ok], ["2", "0", false]);

      // a banned creator or member reads nothing of their own either (the policy itself is gated on "ready", not only the browse rule)
      eq("(I) a banned creator can no longer read even their own campaigns; neither can a banned member", (() => {
        const mem = q(`select campaign_id from public.campaign_members where clipper_id = '${U(A)}' limit 1`);
        Q(`update public.profiles set money_banned = true where id in ('${U(C)}', '${U(A)}')`);
        const r = [as(U(C), `select count(*) from public.campaigns where creator_id = '${U(C)}'`).out, as(U(A), `select count(*) from public.campaigns where id = '${mem}'`).out, as(U(A), `select count(*) from public.campaign_members`).out, as(U(A), `select count(*) from public.campaign_submissions`).out, as(U(C), `select count(*) from public.campaign_submissions`).out];
        Q(`update public.profiles set money_banned = false where id in ('${U(C)}', '${U(A)}')`);
        return r;
      })(), ["0", "0", "0", "0", "0"]);

      // ── J. reviews: blind, immutable, unlock rules ──
      const rsub = q(`select id from public.campaign_submissions where campaign_id = '${owedCamp}'`);
      Q(`update public.campaign_submissions set status = 'approved', views_claimed = 2000 where id = '${rsub}'`);
      const review = (role, stars = 5, extra = "") => Q(`insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars ${extra ? ", comment" : ""}) values ('${rsub}', '${role === "creator" ? U(C) : U(A)}', '${role === "creator" ? U(A) : U(C)}', '${role}', ${stars} ${extra ? `, '${extra}'` : ""})`);
      const tryRev = (role, stars, extra) => psql("t", `insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars ${extra ? ", comment" : ""}) values ('${rsub}', '${role === "creator" ? U(C) : U(A)}', '${role === "creator" ? U(A) : U(C)}', '${role}', ${stars} ${extra ? `, '${extra.replace(/'/g, "''")}'` : ""})`, ["-v", "ON_ERROR_STOP=1"]).status === 0;
      eq("(J) reviews are locked until the clip is paid or an admin settled it", tryRev("clipper", 5), false);
      Q(`update public.campaign_submissions set status = 'paid', received_at = now() where id = '${rsub}'`);
      eq("(J) bad reviews: 0 stars, 6 stars, a comment over 280 characters, a blocked word, and the wrong person", [tryRev("clipper", 0), tryRev("clipper", 6), tryRev("clipper", 5, "x".repeat(281)), tryRev("clipper", 5, "kill yourself"), psql("t", `insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars) values ('${rsub}','${U(B)}','${U(C)}','clipper',5)`, ["-v", "ON_ERROR_STOP=1"]).status === 0], [false, false, false, false, false]);
      eq("(J) a good review is stored unpublished", [tryRev("clipper", 5, "Clear brief, paid fast"), q(`select (published_at is null)::text from public.money_reviews where role = 'clipper'`)], [true, "true"]);
      eq("(J) one review per side per deal", tryRev("clipper", 4), false);
      eq("(J) a review is always unpublished when written, whatever the writer sends", (() => { Q(`delete from public.money_reviews`); Q(`insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars, published_at) values ('${rsub}','${U(A)}','${U(C)}','clipper',5, now())`); const r = q(`select (published_at is null)::text from public.money_reviews`); Q(`delete from public.money_reviews`); Q(`insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars, comment) values ('${rsub}','${U(A)}','${U(C)}','clipper',5,'Clear brief, paid fast')`); return r; })(), "true");
      eq("(J) blind: the creator cannot read the clipper's review; the clipper can; apps cannot write reviews", [as(U(C), `select count(*) from public.money_reviews`).out, as(U(A), `select count(*) from public.money_reviews`).out, as(U(A), `insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars) values ('${rsub}','${U(C)}','${U(A)}','creator',5)`).ok], ["0", "1", false]);
      review("creator", 4);
      eq("(J) both are in, still hidden until the publishing job runs; the stats count published reviews only", [as(U(C), `select count(*) from public.money_reviews`).out, as(U(B), `select public.money_profile_stats('${U(C)}')->>'rating_count'`).out], ["1", "0"]);
      Q(`update public.money_reviews set published_at = now()`);
      eq("(J) published: both parties see both, any ready adult sees them, the rating is the average of published stars", [as(U(C), `select count(*) from public.money_reviews`).out, as(U(B), `select count(*) from public.money_reviews`).out, as(U(B), `select public.money_profile_stats('${U(C)}')->>'rating_avg'`).out, as(U(B), `select public.money_profile_stats('${U(C)}')->>'rating_count'`).out], ["2", "2", "5.0", "1"]);
      eq("(J) a published review cannot be edited by anyone with an account", [su(U(A), `update public.money_reviews set stars = 1`).ok, su(U(A), `update public.money_reviews set comment = 'edited'`).ok, su(U(A), `update public.money_reviews set published_at = null`).ok], [false, false, false]);
      eq("(J) a blocked pair does not see each other's published reviews; a teen sees none", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(B)}','${U(C)}')`); const r = [as(U(B), `select count(*) from public.money_reviews`).out, as(U(TEEN), `select count(*) from public.money_reviews`).out]; Q(`delete from public.user_blocks`); return r; })(), ["0", "0"]);
      eq("(J) an admin-settled non-payment unlocks reviews too", (() => { const id = q(`select id from public.campaign_submissions where campaign_id = '${smallCamp}' limit 1`); Q(`update public.campaign_submissions set status = 'unpaid' where id = '${id}'`); const before = psql("t", `insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars) values ('${id}','${U(B)}','${U(C)}','clipper',1)`, ["-v", "ON_ERROR_STOP=1"]).status === 0; Q(`update public.campaign_submissions set admin_resolved_at = now() where id = '${id}'`); const after = psql("t", `insert into public.money_reviews (submission_id, reviewer_id, reviewee_id, role, stars) values ('${id}','${U(B)}','${U(C)}','clipper',1)`, ["-v", "ON_ERROR_STOP=1"]).status === 0; return [before, after]; })(), [false, true]);

      // ── K. the payment record ──
      eq("(K) the payment record counts approved and paid deals and late strikes; under-18 accounts are not exposed", (() => { const s = JSON.parse(as(U(B), `select public.money_profile_stats('${U(C)}')`).out); return [s.approved_count >= 1, s.paid_count, s.late_count, as(U(B), `select public.money_profile_stats('${U(TEEN)}')`).out]; })(), [true, 1, 0, ""]);
      eq("(K) not-ready accounts cannot ask", as(U(NOTOB), `select public.money_profile_stats('${U(C)}')`).ok, false);

      // ── L. reports reuse the existing table, 18+ only ──
      eq("(L) a ready adult can report a campaign, a submission they are part of, a published review and a person", [
        as(U(B), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(B)}', 'campaign', '${camp}', 'spam')`).ok,
        as(U(A), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(A)}', 'submission', '${rsub}', 'other')`).ok,
        as(U(B), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(B)}', 'money_review', '${q(`select id from public.money_reviews limit 1`)}', 'harassment')`).ok,
        as(U(B), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(B)}', 'money_user', '${U(C)}', 'spam')`).ok], [true, true, true, true]);
      eq("(L) the existing report types still work", as(U(B), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(B)}', 'post', '${p1.id}', 'spam')`).ok, true);
      eq("(L) a teen, a not-onboarded account or a stranger to the submission cannot file Money reports; nor can you report your own campaign", [
        as(U(TEEN), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(TEEN)}', 'campaign', '${camp}', 'spam')`).ok,
        as(U(NOTOB), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(NOTOB)}', 'money_user', '${U(C)}', 'spam')`).ok,
        as(U(STR), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(STR)}', 'submission', '${rsub}', 'spam')`).ok,
        as(U(C), `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(C)}', 'campaign', '${camp}', 'spam')`).ok], [false, false, false, false]);
      eq("(L) every Money report alerts the admins (the existing owner alert)", q(`select count(*) > 0 from public.notifications where type = 'report_alert'`), "t");

      // ── M. the private bucket: proof and receipts ──
      eq("(M) the bucket is private, images only, small", q(`select (not public)::text || ':' || file_size_limit || ':' || cardinality(allowed_mime_types) from storage.buckets where id = 'money-proof'`), "true:8388608:4");
      const ins = (uid, path, bucket = "money-proof") => as(uid, `insert into storage.objects (bucket_id, name) values ('${bucket}', '${path}')`).ok;
      eq("(M) the clipper uploads proof to their submission's folder; the creator uploads a receipt; nobody swaps roles", [ins(U(A), `${rsub}/proof/1.jpg`), ins(U(C), `${rsub}/receipt/1.jpg`), ins(U(C), `${rsub}/proof/2.jpg`), ins(U(A), `${rsub}/receipt/2.jpg`)], [true, true, false, false]);
      eq("(M) a stranger, a not-onboarded account and a teen cannot upload into someone else's submission; a made-up folder fails", [ins(U(STR), `${rsub}/proof/3.jpg`), ins(U(TEEN), `${rsub}/proof/3.jpg`), ins(U(A), `not-a-uuid/proof/1.jpg`), ins(U(A), `${rsub}/proof/4.jpg`, "drops")], [false, false, false, false]);
      const seen = (uid) => as(uid, `select count(*) from storage.objects where bucket_id = 'money-proof'`).out;
      eq("(M) readable by the clipper, the creator and admins only", [seen(U(A)), seen(U(C)), seen(U(ADM)), seen(U(STR)), seen(U(B)), seen(U(TEEN))], ["2", "2", "2", "0", "0", "0"]);
      eq("(M) apps cannot change or delete evidence (the statements touch no row)", (() => { as(U(A), `update storage.objects set name = '${rsub}/proof/x.jpg' where name = '${rsub}/proof/1.jpg'`); as(U(A), `delete from storage.objects where name = '${rsub}/proof/1.jpg'`); as(U(C), `delete from storage.objects where bucket_id = 'money-proof'`); return q(`select count(*) from storage.objects where name = '${rsub}/proof/1.jpg'`); })(), "1");
      eq("(M) the proof stays after the update/delete attempts", seen(U(A)), "2");
      eq("(M) a blocking creator cannot read the blocked clipper's proof", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(C)}','${U(A)}')`); const r = seen(U(C)); Q(`delete from public.user_blocks`); return r; })(), "0");
      eq("(M) an under-18 account (even with the right id) never reads it; neither does a banned one", (() => { Q(`update public.profiles set money_banned = true where id='${U(A)}'`); const r = seen(U(A)); Q(`update public.profiles set money_banned = false where id='${U(A)}'`); return r; })(), "0");

      // ── N. the other tables for the parties, closed to everyone else ──
      Q(`insert into public.submission_links (submission_id, platform, url) values ('${rsub}', 'tiktok', 'https://www.tiktok.com/@a/video/1')`);
      Q(`insert into public.submission_disputes (submission_id, raised_by, reason, note) values ('${rsub}', '${U(C)}', 'proof_mismatch', 'numbers look off')`);
      Q(`insert into public.payment_cases (submission_id, opened_by, clipper_note) values ('${rsub}', '${U(A)}', 'not paid yet')`);
      for (const t of ["submission_links", "submission_disputes", "payment_cases"]) eq(`(N) ${t}: the clipper and the creator see it, another member, a stranger and a teen do not`, [A, C, B, STR, TEEN].map((n) => as(U(n), `select count(*) from public.${t}`).out), ["1", "1", "0", "0", "0"]);
      eq("(N) the same for admins", ["submission_links", "submission_disputes", "payment_cases"].map((t) => as(U(ADM), `select count(*) from public.${t}`).out), ["1", "1", "1"]);
      eq("(N) a dispute note and a payment-case note go through the word filter", [psql("t", `insert into public.submission_disputes (submission_id, raised_by, reason, note) values ('${rsub}','${U(C)}','other','kill yourself')`, ["-v", "ON_ERROR_STOP=1"]).status === 0, psql("t", `insert into public.payment_cases (submission_id, opened_by, clipper_note) values ('${rsub}','${U(A)}','go die')`, ["-v", "ON_ERROR_STOP=1"]).status === 0], [false, false]);
      eq("(N) at most 3 proof images and 3 receipts per row", [psql("t", `update public.campaign_submissions set proof_paths = array['a','b','c','d'] where id = '${rsub}'`, ["-v", "ON_ERROR_STOP=1"]).status === 0, psql("t", `update public.campaign_submissions set proof_paths = array['a','b','c'] where id = '${rsub}'`, ["-v", "ON_ERROR_STOP=1"]).status === 0], [false, true]);

      // ── O. nothing else changed ──
      eq("(O) the feed still works and an ordinary post is not queued by Money", as(U(A), `select count(*) >= 0 from public.get_feed_engine(10, 0)`).ok, true);
      eq("(O) step 1-2 behaviour holds: the flag is on for the owner while off for everyone else, and the adult check is strict", (() => { Q(`update public.app_flags set enabled = false where key = 'money'`); const r = [feat(A).money, feat(A).allowed]; Q(`update public.app_flags set enabled = true where key = 'money'`); return r; })(), [false, false]);
      eq("(O) apps cannot call the internal functions (they would reveal other people's age, ban state or flag)", ["public.money_allowed('X')", "public.money_ready('X')", "public.money_role_of('X')", "public.money_compute_owed('Y', 1, false)", "public.money_check_can_submit('Y','X')"].map((f) => as(U(A), `select ${f.replace(/'X'/g, `'${U(C)}'`).replace(/'Y'/g, `'${camp}'`)}`).ok), Array(5).fill(false));
      eq("(O) the helper functions the policies use only answer about the caller", [as(U(A), `select public.money_ready_me()`).out, as(U(TEEN), `select public.money_ready_me()`).out], ["t", "f"]);
      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
