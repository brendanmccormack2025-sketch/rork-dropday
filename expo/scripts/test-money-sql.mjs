#!/usr/bin/env node
/**
 * MONEY, steps 1-2 (supabase/migration-money.sql: the feature flag, the strict adult check, birthdate collection and lock-down) on top of everything before it, run for real on a scratch PostgreSQL (same
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

      const OWNER = "aee21757-1ded-41a7-9392-bddbf0d657df";
      const yearsAgo = (y, extraDays = 0) => q(`select (current_date - interval '${y} years' - interval '${extraDays} days')::date`);
      const setBirth = (n, d) => Q(`update public.profiles set birthdate = ${d === null ? "null" : `'${d}'`} where id='${U(n)}'`);
      const feat = (n) => JSON.parse(as(U(n), `select public.my_features()`).out);
      const sql1 = (expr) => q(`select ${expr}`);

      // ── 1. the flag is OFF for everyone but the owner ──
      mkUser(20); mkUser(21); mkUser(22); mkUser(23);
      Q(`update public.app_flags set enabled = false where key = 'money'`);
      eq("the 'money' flag exists, is off, and only the owner is allow-listed", [q(`select enabled::text || ':' || cardinality(allow_user_ids) || ':' || (allow_user_ids[1] = '${OWNER}')::text from public.app_flags where key = 'money'`)], ["false:1:true"]);
      for (const n of [1, 2, 3, 6, 20]) setBirth(n, "1990-01-01");
      eq("flag off: an adult is NOT allowed, and does not even see the tab", [1, 6, 20].map((n) => { const f = feat(n); return [f.money, f.allowed, f.needs_birthdate].join("/"); }), Array(3).fill("false/false/false"));
      eq("flag_on / money_is_adult / money_allowed answer false for everyone while off", [sql1(`public.flag_on('money', '${U(20)}')`), sql1(`public.money_allowed('${U(20)}')`), sql1(`public.flag_on('money', null)`), sql1(`public.flag_on('nope', '${U(20)}')`)], ["f", "f", "f", "f"]);

      // ── 2. allow-listed testers (the owner) see it while the flag is off ──
      Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${OWNER}','{"username":"owner"}','owner@example.test') on conflict do nothing`);
      Q(`update public.profiles set birthdate = '1985-05-05' where id = '${OWNER}'`);
      const featOwner = JSON.parse(as(OWNER, `select public.my_features()`).out);
      eq("the owner (allow-listed) is allowed while the flag is off", [featOwner.money, featOwner.allowed], [true, true]);
      Q(`update public.app_flags set allow_user_ids = allow_user_ids || array['${U(21)}']::uuid[] where key = 'money'`);
      setBirth(21, "1990-01-01");
      eq("another tester added to the allow-list is on, everybody else still off", [feat(21).allowed, feat(20).allowed], [true, false]);

      // ── 3. the strict adult check (flag turned on for everyone) ──
      Q(`update public.app_flags set enabled = true where key = 'money'`);
      eq("adult with a birthdate: allowed", [feat(20).money, feat(20).allowed, feat(20).needs_birthdate], [true, true, false]);
      setBirth(22, null);
      eq("NO birthdate: not allowed (unknown is not adult), but the tab shows and asks for it (needs_birthdate)", [feat(22).money, feat(22).allowed, feat(22).needs_birthdate], [true, false, true]);
      eq("...and money_is_adult is false for a missing birthdate", sql1(`public.money_is_adult('${U(22)}')`), "f");
      setBirth(23, yearsAgo(16));
      eq("a teen (16): not allowed and the tab is hidden entirely", [feat(23).money, feat(23).allowed, feat(23).needs_birthdate], [false, false, false]);
      setBirth(23, yearsAgo(11));
      eq("under 13: the same", [feat(23).money, feat(23).allowed], [false, false]);

      // ── 4. the 18th birthday, to the day ──
      eq("turns 18 today: adult", (() => { setBirth(23, yearsAgo(18)); return [feat(23).allowed, sql1(`public.money_is_adult('${U(23)}')`)]; })(), [true, "t"]);
      eq("turns 18 TOMORROW (17 years, 364 days): not adult", (() => { setBirth(23, q(`select (current_date - interval '18 years' + interval '1 day')::date`)); return [feat(23).allowed, feat(23).money]; })(), [false, false]);
      eq("turned 18 yesterday: adult", (() => { setBirth(23, yearsAgo(18, 1)); return feat(23).allowed; })(), true);

      // ── 5. suspended or banned accounts are not allowed ──
      Q(`insert into public.account_sanctions (user_id, kind, until, created_by) values ('${U(20)}', 'suspend', now() + interval '3 days', '${U(14)}')`);
      eq("a suspended adult: not allowed, tab hidden", [feat(20).allowed, feat(20).money], [false, false]);
      Q(`update public.account_sanctions set lifted_at = now() where user_id = '${U(20)}'`);
      eq("sanction lifted: allowed again", feat(20).allowed, true);

      // ── 6. nobody can read another person's age or flag state ──
      eq("not signed in: everything false", (() => { const r = psql("t", "set role anon; select public.my_features()", ["-v", "ON_ERROR_STOP=1"]); return r.status !== 0; })(), true);
      eq("signed in with no profile row: all false, no error", (() => { Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(40)}','{"username":"ghost"}','g@example.test') on conflict do nothing; delete from public.profiles where id='${U(40)}'`); const f = JSON.parse(as(U(40), `select public.my_features()`).out); return [f.money, f.allowed, f.needs_birthdate]; })(), [false, false, false]);
      eq("apps cannot call the internal functions (they would reveal other people's age and tester status)", [as(U(21), `select public.money_is_adult('${U(20)}')`).ok, as(U(21), `select public.money_allowed('${U(20)}')`).ok, as(U(21), `select public.flag_on('money', '${U(20)}')`).ok], [false, false, false]);
      eq("apps cannot read or change the flag table", [as(U(21), `select count(*) from public.app_flags`).ok, as(U(21), `update public.app_flags set enabled = true`).ok], [false, false]);
      eq("my_features reveals only my own state", (() => { const a = feat(20), b = feat(22); return [a.allowed, b.allowed]; })(), [true, false]);

      // ── 7. re-running the migration never resets what you changed ──
      eq("re-applying keeps enabled = true and a tester added by hand", (() => { const r = psqlFile("t", mo); return [/ERROR/.test(r.stderr), q(`select enabled::text from public.app_flags where key='money'`), q(`select ('${U(21)}' = any (allow_user_ids))::text from public.app_flags where key='money'`), q(`select cardinality(allow_user_ids) from public.app_flags where key='money'`)]; })(), [false, "true", "true", "2"]);
      eq("...and the owner is added back if somebody removed them", (() => { Q(`update public.app_flags set allow_user_ids = '{}' where key='money'`); psqlFile("t", mo); return q(`select (allow_user_ids = array['${OWNER}']::uuid[])::text from public.app_flags where key='money'`); })(), "true");
      eq("flag back to off for the rest of the checks", (() => { Q(`update public.app_flags set enabled = false where key='money'`); return feat(20).allowed; })(), false);

      // ══ STEP 2: birthdate collection and lock-down ══
      Q(`update public.app_flags set enabled = true where key = 'money'`);
      const bdOf = (n) => q(`select coalesce(birthdate::text, 'null') from public.profiles where id='${U(n)}'`);
      const mkMeta = (n, meta) => Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(n)}','${JSON.stringify({ username: "m" + n, ...meta })}','m${n}@example.test') on conflict do nothing`);
      const lockOn = () => q(`select enabled::text from public.app_flags where key='birthdate_lockdown'`);
      eq("(2) the lock-down flag exists and starts OFF", lockOn(), "false");

      // before the lock-down: nothing is stored
      mkUser(30, "1990-01-01"); setBirth(30, null);
      eq("(2) before the lock-down set_my_birthdate refuses (the date would be publicly readable)", as(U(30), `select public.set_my_birthdate('1990-01-01')`).ok, false);
      mkMeta(31, { birthdate: "1992-03-04" });
      eq("(2) before the lock-down a sign-up birthdate in the metadata is IGNORED", bdOf(31), "null");
      eq("(2) ...and the profile still got its username (same sign-up inserts as before)", q(`select username from public.profiles where id='${U(31)}'`), "m31");

      // a direct write is refused whether or not the lock-down is on
      eq("(2) a direct profile update of birthdate by the user is refused", as(U(30), `update public.profiles set birthdate = '1990-01-01' where id='${U(30)}'`).ok, false);
      eq("(2) ...and a direct insert of a profile carrying a birthdate is refused", (() => { Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(32)}','{"username":"m32"}','m32@example.test') on conflict do nothing; delete from public.profiles where id='${U(32)}'`); return as(U(32), `insert into public.profiles (id, username, birthdate) values ('${U(32)}','m32','1990-01-01')`).ok; })(), false);
      eq("(2) ...but an ordinary profile edit (bio) still works, as do inserts without a birthdate (ensureProfile)", [as(U(30), `update public.profiles set bio = 'hi' where id='${U(30)}'`).ok, as(U(32), `insert into public.profiles (id, username) values ('${U(32)}','m32')`).ok, as(U(30), `update public.profiles set bio = 'hi2', birthdate = null where id='${U(30)}'`).ok], [true, true, true]);
      eq("(2) the upsert the app uses for profile edits still works (no birthdate in it)", as(U(30), `insert into public.profiles (id, username, bio) values ('${U(30)}','u30','up') on conflict (id) do update set bio = excluded.bio`).ok, true);

      // metadata set by an existing account is picked up by the lock-down, bad values never break it
      mkMeta(33, { birthdate: "1992-03-04" }); mkMeta(34, { birthdate: "1992-13-45" }); mkMeta(35, { birthdate: "2999-01-01" }); mkMeta(36, { birthdate: "garbage" }); mkMeta(37, { birthdate: "2012-02-02" });
      eq("(2) none of them stored before the lock-down", [33, 34, 35, 36, 37].map(bdOf), Array(5).fill("null"));
      eq("(2) a signed-in user cannot run the lock-down or refresh the grants", [as(U(30), `select public.money_apply_birthdate_lockdown()`).ok, as(U(30), `select public.money_refresh_profile_grants()`).ok, as(ADMIN, `select public.money_apply_birthdate_lockdown()`).ok], [false, false, false]);

      // old builds keep working until the owner applies it: they select birthdate, and a profile read still returns it
      eq("(2) before the lock-down an old build can still read profiles including birthdate", as(U(30), `select count(birthdate) from public.profiles`).ok, true);

      const lk = psql("t", `select public.money_apply_birthdate_lockdown()`, ["-v", "ON_ERROR_STOP=1"]);
      eq("(2) the owner's lock-down runs (SQL editor) and reports what it copied", [lk.status, /lockdown applied; 3 birthdates copied/.test(lk.stdout)], [0, true]);
      eq("(2) the flag is on, valid metadata copied (even for a minor), bad values skipped", [lockOn(), bdOf(33), bdOf(34), bdOf(35), bdOf(36), bdOf(37)], ["true", "1992-03-04", "null", "null", "null", "2012-02-02"]);
      eq("(2) running the lock-down again is harmless", [psql("t", `select public.money_apply_birthdate_lockdown()`, ["-v", "ON_ERROR_STOP=1"]).status, lockOn()], [0, "true"]);

      // after: nobody can read the column, everything else is readable as before
      eq("(2) signed-in users can no longer read birthdate, directly or with select *", [as(U(30), `select birthdate from public.profiles`).ok, as(U(30), `select * from public.profiles`).ok, as(U(30), `select p.* from public.profiles p`).ok, as(U(30), `select birthdate_set_at from public.profiles`).ok], [false, false, false, false]);
      eq("(2) anon cannot either", [psql("t", `set role anon; select birthdate from public.profiles`, ["-v", "ON_ERROR_STOP=1"]).status !== 0, psql("t", `set role anon; select username, avatar_url, bio from public.profiles limit 1`, ["-v", "ON_ERROR_STOP=1"]).status === 0], [true, true]);
      eq("(2) every other column is still readable, and filtering by id still works", [as(U(30), `select username, display_name, avatar_url, bio, website, instagram_handle, tiktok_handle, created_at from public.profiles where id='${U(30)}'`).ok, as(U(30), `select count(*) from public.profiles where id = '${U(31)}'`).out], [true, "1"]);
      eq("(2) profile edits (update and upsert) still work after the lock-down", [as(U(30), `update public.profiles set bio = 'after' where id='${U(30)}'`).ok, as(U(30), `insert into public.profiles (id, username, bio) values ('${U(30)}','u30','up2') on conflict (id) do update set bio = excluded.bio`).ok], [true, true]);
      eq("(2) functions that read birthdate on the server (age_tier checks, the feed) still work", [as(U(30), `select count(*) from public.get_feed_engine(10, 0)`).ok, as(U(30), `select public.my_features()`).ok], [true, true]);

      // set_my_birthdate
      eq("(2) set_my_birthdate refuses a future date, a date before 1900 and null", [as(U(30), `select public.set_my_birthdate(current_date + 1)`).ok, as(U(30), `select public.set_my_birthdate('1899-12-31')`).ok, as(U(30), `select public.set_my_birthdate(null)`).ok], [false, false, false]);
      eq("(2) ...and not signed in", psql("t", `set role anon; select public.set_my_birthdate('1990-01-01')`, ["-v", "ON_ERROR_STOP=1"]).status !== 0, true);
      eq("(2) existing user with no birthdate: asked first (needs_birthdate), not allowed yet", (() => { const f = feat(30); return [f.money, f.needs_birthdate, f.allowed]; })(), [true, true, false]);
      eq("(2) an adult sets it: returns 'adult', stored, set time recorded", [as(U(30), `select public.set_my_birthdate('1990-01-01')`).out, bdOf(30), q(`select (birthdate_set_at is not null)::text from public.profiles where id='${U(30)}'`)], ["adult", "1990-01-01", "true"]);
      eq("(2) ...and now Money is allowed and nothing is asked again", (() => { const f = feat(30); return [f.money, f.needs_birthdate, f.allowed]; })(), [true, false, true]);
      eq("(2) my_birthdate returns my own date, only mine", [as(U(30), `select public.my_birthdate()`).out, as(U(20), `select public.my_birthdate()`).out], ["1990-01-01", "1990-01-01"]);
      eq("(2) a second set_my_birthdate is refused, as is a direct change (a teen cannot become an adult)", [as(U(30), `select public.set_my_birthdate('1980-01-01')`).ok, as(U(30), `update public.profiles set birthdate = '1980-01-01' where id='${U(30)}'`).ok, bdOf(30)], [false, false, "1990-01-01"]);
      eq("(2) the set time cannot be edited by the user either (the write is ignored)", (() => { const before = q(`select birthdate_set_at from public.profiles where id='${U(30)}'`); as(U(30), `update public.profiles set birthdate_set_at = now() + interval '5 days' where id='${U(30)}'`); return q(`select birthdate_set_at from public.profiles where id='${U(30)}'`) === before; })(), true);

      // a teen and an under-13
      mkUser(38, "1990-01-01"); setBirth(38, null); mkUser(39, "1990-01-01"); setBirth(39, null);
      eq("(2) a 16-year-old: tier 'teen', stored, tab hidden, never allowed", [as(U(38), `select public.set_my_birthdate('${yearsAgo(16)}')`).out, (() => { const f = feat(38); return [f.money, f.allowed, f.needs_birthdate]; })()], ["teen", [false, false, false]]);
      eq("(2) an 11-year-old: tier 'under_13', stored, never allowed", [as(U(39), `select public.set_my_birthdate('${yearsAgo(11)}')`).out, feat(39).allowed], ["under_13", false]);
      eq("(2) turning 18 exactly today is adult; one day short is a teen", (() => { mkUser(41, "1990-01-01"); setBirth(41, null); mkUser(42, "1990-01-01"); setBirth(42, null); return [as(U(41), `select public.set_my_birthdate('${yearsAgo(18)}')`).out, as(U(42), `select public.set_my_birthdate('${q(`select (current_date - interval '18 years' + interval '1 day')::date`)}')`).out]; })(), ["adult", "teen"]);

      // sign-up after the lock-down
      mkMeta(43, { birthdate: "1995-07-07" }); mkMeta(44, { birthdate: "2999-01-01" }); mkMeta(45, { birthdate: "not-a-date" }); mkMeta(46, {}); mkMeta(47, { birthdate: "" });
      eq("(2) a new sign-up's birthdate is stored when valid, ignored when not, null when absent (asked on first Money visit)", [43, 44, 45, 46, 47].map(bdOf), ["1995-07-07", "null", "null", "null", "null"]);
      eq("(2) a new adult is allowed straight away; a new sign-up without a date is asked", [feat(43).allowed, feat(46).needs_birthdate], [true, true]);
      eq("(2) the sign-up date cannot be changed afterwards by the user", as(U(43), `update public.profiles set birthdate = '1980-01-01' where id='${U(43)}'`).ok, false);

      // admin correction, and the service role
      eq("(2) only the SQL editor / service role can correct a date (an admin's app write changes nothing: RLS)", [as(ADMIN, `update public.profiles set birthdate = '1991-01-01' where id='${U(30)}'`).ok, bdOf(30), (() => { Q(`update public.profiles set birthdate = '1992-02-02' where id='${U(30)}'`); return bdOf(30); })()], [true, "1990-01-01", "1992-02-02"]);
      eq("(2) a non-admin cannot correct someone else's date (RLS) or their own", [as(U(20), `update public.profiles set birthdate = '1980-01-01' where id='${U(30)}'`).ok, bdOf(30)], [true, "1992-02-02"]);

      // new profile columns: not granted until the refresh
      Q(`alter table public.profiles add column if not exists test_new_col text`);
      eq("(2) a column added later is NOT readable until money_refresh_profile_grants() runs", as(U(30), `select test_new_col from public.profiles limit 1`).ok, false);
      Q(`select public.money_refresh_profile_grants()`);
      eq("(2) ...and is after it, with birthdate still locked", [as(U(30), `select test_new_col from public.profiles limit 1`).ok, as(U(30), `select birthdate from public.profiles limit 1`).ok], [true, false]);
      eq("(2) re-applying the migration keeps the lock-down on and the column locked", [/ERROR/.test(psqlFile("t", mo).stderr), lockOn(), as(U(30), `select birthdate from public.profiles limit 1`).ok], [false, "true", false]);
      eq("(2) apps cannot call the internal birthdate functions", [as(U(30), `select public.birthdate_is_valid('1990-01-01')`).ok, as(U(30), `select public.birthdate_parse('1990-01-01')`).ok, as(U(30), `select public.money_refresh_profile_grants()`).ok], [false, false, false]);
      Q(`update public.app_flags set enabled = false where key = 'money'`);
      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
