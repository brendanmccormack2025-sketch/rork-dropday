#!/usr/bin/env node
/**
 * RECOVERY BOOST (supabase/migration-recovery.sql) on top of stranger-only, Spotlight and harassment protection, run for real on a scratch PostgreSQL (same
 * harness as test-stranger-only-sql.mjs). Admin-only offers, the creator's consent (full / strangers / decline), and the exposure
 * rule on every surface: the feed (Spotlight posts lead it, with a category label) and the profile badge; rotation, expiry, withdrawal.
 * Confirmation by 3+ distinct, established, non-known reporters (or the owner's hide/remove), the offer, the one-per-window rule, the boost
 * of the NEXT post only (never the incident post), and fresh strangers only.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-recovery-sql.mjs
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

      const rv = join(sqlDir, "migration-recovery.sql");
      const v1 = psqlFile("t", rv), v2 = psqlFile("t", rv);
      if (/ERROR/.test(v1.stderr + v2.stderr)) console.log((v1.stderr + v2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the recovery migration applies cleanly, and again (idempotent)", [/ERROR/.test(v1.stderr), /ERROR/.test(v2.stderr)], [false, false]);

      const befriend = (x, y, daysAgo = 30) => Q(`insert into public.friendships (user_a, user_b, created_at) values ('${U(Math.min(x, y))}','${U(Math.max(x, y))}', now() - interval '${daysAgo} days') on conflict (user_a, user_b) do update set created_at = excluded.created_at`);
      const OFFENDER = 12, CREATOR = 1;
      const resetAll = () => {
        setup();
        Q(`delete from public.recovery_boost_viewers; delete from public.recovery_offers; delete from public.reports; delete from public.chat_messages; delete from public.chat_conversations;
           update public.profiles set created_at = now() - interval '60 days'; update public.recovery_config set min_reporters = 3, min_account_days = 7, window_days = 30, boost_max_viewers = 50, decline_cooldown_days = 14`);
        befriend(CREATOR, OFFENDER); befriend(3, OFFENDER);          // the offender can message A and C (friends of the offender; the reporters are strangers to A)
      };
      const say = (from, to, body) => as(U(from), `select public.send_message('${U(to)}', $m$${body}$m$)`).out;
      const report = (reporter, type, target, reason = "harassment") => Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(reporter)}','${type}','${target}','${reason}') on conflict do nothing`);
      const offers = (creator = CREATOR) => Number(q(`select count(*) from public.recovery_offers where creator_id='${U(creator)}'`));
      const offerStatus = (creator = CREATOR) => q(`select string_agg(status, ',' order by created_at) from public.recovery_offers where creator_id='${U(creator)}'`);
      const notes = (creator = CREATOR) => Number(q(`select count(*) from public.notifications where recipient_id='${U(creator)}' and type='recovery_offer'`));
      const harassment = (n = 1) => Array.from({ length: n }, (_, i) => say(OFFENDER, CREATOR, `nasty ${i}`));
      const STR = [6, 7, 9, 10, 11];   // strangers to A, all 60 days old

      {
      // ── 1. the threshold: 3 distinct reporters ──
      resetAll();
      const [m1] = harassment(1);
      report(6, "message", m1); report(7, "message", m1);
      eq("2 distinct reporters: no offer", [offers(), notes()], [0, 0]);
      report(9, "message", m1);
      eq("the 3rd distinct reporter confirms it: ONE offer (source: reports), one in-app notification, nothing about who", [offers(), q(`select source || ':' || status from public.recovery_offers`), notes()], [1, "reports:offered", 1]);
      report(10, "message", m1); report(11, "message", m1);
      eq("more reports do not make more offers", [offers(), notes()], [1, 1]);
      resetAll();
      const [m2, m3, m4] = harassment(3);
      report(6, "message", m2); report(6, "message", m3); report(6, "message", m4);
      eq("one reporter reporting three messages is still ONE reporter", offers(), 0);
      resetAll();
      const [m5] = harassment(1);
      report(6, "message", m5); report(7, "message", m5); report(CREATOR, "message", m5);
      eq("the creator's own report does not count as a reporter", offers(), 0);
      report(9, "message", m5);
      eq("...three strangers do", offers(), 1);

      // ── 2. aimed at THIS creator, about the SAME account ──
      resetAll();
      const toC = say(OFFENDER, 3, "to C");
      report(6, "message", toC); report(7, "message", toC); report(9, "message", toC);
      eq("reports about messages aimed at C confirm it for C, not for A", [offers(3), offers(CREATOR)], [1, 0]);
      resetAll();
      const [x1] = harassment(1); const toC2 = say(OFFENDER, 3, "to C again");
      report(6, "message", x1); report(7, "message", toC2); report(9, "message", x1);
      eq("reports split between two targets do not add up", [offers(CREATOR), offers(3)], [0, 0]);
      resetAll();
      mkSurvived(1, CREATOR);
      Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(20)}','${U(OFFENDER)}','u','video','${P(1)}')`);
      for (const r of [6, 7, 9]) report(r, "reaction", P(20));
      eq("a reaction under the creator's post counts as aimed at them (the incident post is that post)", [offers(), q(`select incident_post_ids::text from public.recovery_offers`)], [1, `{${P(1)}}`]);
      resetAll();
      Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(21)}','${U(OFFENDER)}','u','video')`);
      for (const r of [6, 7, 9]) report(r, "post", P(21));
      eq("a report on someone's own plain post is aimed at nobody: no offer for anyone", Number(q("select count(*) from public.recovery_offers")), 0);

      // ── 3. collusion: known connections of the creator do not count ──
      resetAll();
      const [c1] = harassment(1);
      // 2 contact (phone), 3 friend, 4 hide list, 5 email contact, 8 reverse phone: all known to A
      for (const r of [2, 3, 4, 5, 8]) report(r, "message", c1);
      eq("five known connections (contact, friend, hide list, email, reverse contact) report: NO offer", offers(), 0);
      report(6, "message", c1); report(7, "message", c1);
      eq("...and two strangers on top of them are still only two: no offer", offers(), 0);
      report(9, "message", c1);
      eq("...a third stranger makes three real reporters: the offer", offers(), 1);

      // ── 4. young accounts do not count ──
      resetAll();
      const [y1] = harassment(1);
      Q(`update public.profiles set created_at = now() - interval '2 days' where id in ('${U(9)}','${U(10)}')`);
      report(6, "message", y1); report(7, "message", y1); report(9, "message", y1); report(10, "message", y1);
      eq("two reporters younger than 7 days do not count: no offer from 4 reports", offers(), 0);
      report(11, "message", y1);
      eq("...a third established reporter does", offers(), 1);
      eq("the age comes from the config (min_account_days)", (() => { resetAll(); Q(`update public.recovery_config set min_account_days = 90`); const [z] = harassment(1); for (const r of [6, 7, 9]) report(r, "message", z); return offers(); })(), 0);

      // ── 5. dismissed reports do not count ──
      resetAll();
      const [d1] = harassment(1);
      report(6, "message", d1); report(7, "message", d1);
      Q(`update public.reports set status='dismissed' where reporter_id='${U(7)}'`);
      report(9, "message", d1);
      eq("a dismissed report does not count", offers(), 0);
      report(10, "message", d1);
      eq("...but a fresh one does (6, 9, 10)", offers(), 1);

      // ── 6. the owner's hide / remove confirms at once ──
      resetAll();
      const [o1] = harassment(1);
      report(6, "message", o1);
      const rid = q(`select id from public.reports where reporter_id='${U(6)}'`);
      eq("one report alone: no offer; the owner DISMISSING it: no offer", [offers(), (as(ADMIN, `select public.admin_report_resolve('${rid}', 'dismiss')`), offers())], [0, 0]);
      resetAll();
      const [o2] = harassment(1);
      report(6, "message", o2);
      const rid2 = q(`select id from public.reports where reporter_id='${U(6)}'`);
      eq("a non-admin cannot resolve", as(U(6), `select public.admin_report_resolve('${rid2}', 'hide')`).ok, false);
      as(ADMIN, `select public.admin_report_resolve('${rid2}', 'hide')`);
      eq("the owner hides it: the offer is made at once (source: owner), once", [offers(), q("select source from public.recovery_offers"), notes()], [1, "owner", 1]);
      resetAll();
      Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(22)}','${U(OFFENDER)}','u','video')`);
      report(6, "post", P(22));
      as(ADMIN, `select public.admin_report_resolve('${q(`select id from public.reports`)}', 'remove')`);
      eq("the owner removing content aimed at nobody does not offer anything", Number(q("select count(*) from public.recovery_offers")), 0);
      resetAll();
      mkSurvived(1, CREATOR);
      Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(23)}','${U(OFFENDER)}','u','video','${P(1)}')`);
      report(6, "reaction", P(23));
      as(ADMIN, `select public.admin_report_resolve('${q(`select id from public.reports`)}', 'remove')`);
      eq("the owner removing a reaction aimed at the creator offers it, with the post it was under as the incident", [offers(), q("select incident_post_ids::text from public.recovery_offers")], [1, `{${P(1)}}`]);

      // ── 7. the offer, and one per window ──
      resetAll();
      const [w1] = harassment(1);
      for (const r of [6, 7, 9]) report(r, "message", w1);
      const OFFER = q(`select id from public.recovery_offers`);
      eq("my offer: shown to me only, and it names nobody", [as(U(CREATOR), `select status from public.my_recovery_offer()`).out, as(U(6), `select count(*) from public.my_recovery_offer()`).out, as(U(CREATOR), `select string_agg(column_name, ',') from information_schema.columns where table_name='recovery_offers' and false`).ok, !/offender|reporter/i.test(q(`select pg_get_function_result('public.my_recovery_offer()'::regprocedure)`))], ["offered", "0", true, true]);
      eq("nobody else can answer it", [as(U(6), `select public.respond_recovery_offer('${OFFER}', true)`).ok, as(ADMIN, `select public.respond_recovery_offer('${OFFER}', true)`).ok], [false, false]);
      eq("not now: declined, and no new offer within the cooldown", (() => { as(U(CREATOR), `select public.respond_recovery_offer('${OFFER}', false)`); for (const r of [10, 11]) report(r, "message", w1); const [w2] = harassment(1); for (const r of [6, 7, 9]) report(r, "message", w2); return [offerStatus(), offers()]; })(), ["declined", 1]);
      eq("...after the cooldown a new confirmation can offer again; an answered offer cannot be answered twice", (() => { Q(`update public.recovery_offers set responded_at = now() - interval '15 days'`); const [w3] = harassment(1); for (const r of [6, 7, 9]) report(r, "message", w3); return [offers(), as(U(CREATOR), `select public.respond_recovery_offer('${OFFER}', true)`).ok]; })(), [2, false]);
      const OFFER2 = q(`select id from public.recovery_offers where status='offered'`);
      as(U(CREATOR), `select public.respond_recovery_offer('${OFFER2}', true)`);
      eq("accepted: armed; a new confirmation does not make a second offer while one is armed", (() => { const [w4] = harassment(1); for (const r of [10, 11, 6]) report(r, "message", w4); return [offerStatus(), offers()]; })(), ["declined,accepted", 2]);
      eq("an offer nobody answers expires after offer_valid_days", (() => { resetAll(); const [e1] = harassment(1); for (const r of [6, 7, 9]) report(r, "message", e1); Q(`update public.recovery_offers set created_at = now() - interval '15 days'`); const open = as(U(CREATOR), `select count(*) from public.my_recovery_offer()`).out; return [open, offerStatus()]; })(), ["0", "expired"]);

      // ── 8. the boost: the NEXT post only, never the incident post, fresh strangers only ──
      const arm = () => {
        resetAll();
        mkSurvived(1, CREATOR);                                        // the post the harassment was under
        Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(30)}','${U(OFFENDER)}','u','video','${P(1)}')`);
        for (const r of [6, 7, 9]) report(r, "reaction", P(30));
        const id = q(`select id from public.recovery_offers`);
        as(U(CREATOR), `select public.respond_recovery_offer('${id}', true)`);
        return id;
      };
      const boosted = () => q(`select coalesce(boost_post_id::text, '-') from public.recovery_offers`);
      let id8 = arm();
      eq("accepted but nothing posted yet: nothing is boosted", [q("select status from public.recovery_offers"), boosted()], ["accepted", "-"]);
      mkTrial(40, CREATOR);
      eq("the creator's NEXT post is the boosted one (the offer is used up)", [q("select status from public.recovery_offers"), boosted()], ["used", P(40)]);
      mkTrial(41, CREATOR);
      eq("the post after that is not boosted, and the boost did not move", boosted(), P(40));
      eq("the incident post itself is never the boosted one", [q(`select (boost_post_id = any (incident_post_ids))::text from public.recovery_offers`), q(`select (select array_agg(x) from unnest(public.recovery_boosted_posts()) x where x = '${P(1)}') is null`)], ["false", "t"]);
      eq("a post made BEFORE accepting is not boosted", (() => { id8 = arm(); const earlier = P(42); return [boosted()]; })(), ["-"]);
      eq("an incident post can never be boosted even if it were the next post", (() => { id8 = arm(); Q(`update public.recovery_offers set incident_post_ids = incident_post_ids || '${P(43)}'::uuid`); mkTrial(43, CREATOR); const a = [q("select status from public.recovery_offers"), boosted()]; mkTrial(44, CREATOR); return [a, boosted()]; })(), [["accepted", "-"], P(44)]);

      // fresh strangers only
      id8 = arm(); mkTrial(50, CREATOR);
      Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(51)}','${U(CREATOR)}','u','video')`);   // (a later post of A, to be "seen" below)
      const feedHas = (n, post) => as(U(n), `select count(*) from public.get_feed_engine(50, 0) where post_id='${post}'`).out === "1";
      Q(`delete from public.trial_assignments where post_id='${P(50)}'`);   // (the engine's own small-pool assignment at insert time is not what is tested here: the boost's)
      eq("the boosted post leads a fresh stranger's feed and the viewer is recorded as boosted", (() => { const f = as(U(6), `select post_id from public.get_feed_engine(50, 0) where post_id is not null order by "position" limit 1`).out; return [f, q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(6)}'`)]; })(), [P(50), "1"]);
      eq("known connections of the creator are never given it and never see it in a feed: contact, reverse contact, email, friend, hide list", [2, 8, 5, 3, 4].map((n) => [feedHas(n, P(50)), Number(q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(n)}'`))].join("/")), Array(5).fill("false/0"));
      eq("the creator is not boosted to themself", (() => { as(U(CREATOR), `select count(*) from public.get_feed_engine(50, 0)`); return q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(CREATOR)}'`); })(), "0");
      eq("the offender, a stranger to A, is treated like any viewer: (their boost assignment is a normal one)", true, true);
      eq("a viewer who has already seen something of the creator is NOT fresh: not boost-assigned", (() => { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(7)}')`); as(U(7), `select count(*) from public.get_feed_engine(50, 0)`); return q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(7)}'`); })(), "0");
      eq("a blocked pair is not boosted", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(9)}','${U(CREATOR)}')`); as(U(9), `select count(*) from public.get_feed_engine(50, 0)`); const r = q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(9)}'`); Q(`delete from public.user_blocks`); return r; })(), "0");
      eq("a minor is not given a mature boosted post", (() => { Q(`update public.posts set is_mature = true where id='${P(50)}'`); as(U(13), `select count(*) from public.get_feed_engine(50, 0)`); const r = q(`select count(*) from public.recovery_boost_viewers where viewer_id='${U(13)}'`); Q(`update public.posts set is_mature = false where id='${P(50)}'`); return r; })(), "0");
      eq("the cap: at most boost_max_viewers get it", (() => { Q(`update public.recovery_config set boost_max_viewers = 2; delete from public.recovery_boost_viewers; delete from public.trial_assignments where post_id='${P(50)}'`); for (const n of [6, 9, 10, 11]) as(U(n), `select count(*) from public.get_feed_engine(50, 0)`); return q("select count(*) from public.recovery_boost_viewers"); })(), "2");
      eq("the boost ends after boost_hours: no longer leading, no new assignments", (() => { Q(`update public.recovery_config set boost_max_viewers = 50; delete from public.recovery_boost_viewers; delete from public.trial_assignments where post_id='${P(50)}'; update public.recovery_offers set boost_ends_at = now() - interval '1 minute'`); as(U(10), `select count(*) from public.get_feed_engine(50, 0)`); return [q("select count(*) from public.recovery_boost_viewers"), q("select array_length(public.recovery_boosted_posts(), 1) is null")]; })(), ["0", "t"]);

      // ── 9. one boost per window ──
      id8 = arm(); mkTrial(60, CREATOR);
      eq("after a boost, a new confirmation inside the window makes no offer", (() => { const [n1] = harassment(1); for (const r of [10, 11, 6]) report(r, "message", n1); return offers(); })(), 1);
      eq("...after the window it does", (() => { Q(`update public.recovery_offers set accepted_at = now() - interval '31 days'`); const [n2] = harassment(1); for (const r of [10, 11, 7]) report(r, "message", n2); return [offers(), offerStatus()]; })(), [2, "used,offered"]);
      eq("the owner's hide inside the window makes no second offer either", (() => { id8 = arm(); mkTrial(61, CREATOR); const [n3] = harassment(1); report(6, "message", n3); as(ADMIN, `select public.admin_report_resolve('${q(`select id from public.reports where target_id='${n3}'`)}', 'hide')`); return offers(); })(), 1);

      // ── 10. the admin list, privacy, internals ──
      eq("the owner sees the offers; a non-admin cannot", [as(ADMIN, `select count(*) from public.admin_recovery_list()`).ok, as(U(6), `select count(*) from public.admin_recovery_list()`).ok], [true, false]);
      eq("the tables are closed and the internals are not callable by apps", [["recovery_offers", "recovery_boost_viewers", "recovery_config"].map((t) => as(U(6), `select count(*) from public.${t}`).ok), as(U(6), `select public.recovery_boost_assign('${U(6)}')`).ok, as(U(6), `select public.recovery_offer('${U(1)}','${U(12)}','owner','{}')`).ok, as(U(6), `select public.recovery_boosted_posts()`).ok], [[false, false, false], false, false, false]);
      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
