#!/usr/bin/env node
/**
 * ACCOUNT SANCTIONS and OWNER ALERTS (supabase/migration-sanctions.sql) on top of everything before it, run for real on a scratch PostgreSQL (same
 * harness as test-stranger-only-sql.mjs). Admin-only offers, the creator's consent (full / strangers / decline), and the exposure
 * rule on every surface: the feed (Spotlight posts lead it, with a category label) and the profile badge; rotation, expiry, withdrawal.
 * Suspend (N days) / ban, unsuspend / unban, the log of every action, enforcement on posts, reactions, likes and messages (so every build
 * obeys), hiding of the account's posts, expiry, and the owner's alert for each new report (in-app and the push claim).
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-sanctions-sql.mjs
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

      const befriend = (x, y, daysAgo = 30) => Q(`insert into public.friendships (user_a, user_b, created_at) values ('${U(Math.min(x, y))}','${U(Math.max(x, y))}', now() - interval '${daysAgo} days') on conflict (user_a, user_b) do update set created_at = excluded.created_at`);
      const TARGET = 6;      // the account that gets sanctioned
      const resetAll = () => {
        setup();
        Q(`delete from public.moderation_log; delete from public.sanction_hidden_posts; delete from public.account_sanctions; delete from public.reports; delete from public.chat_messages; delete from public.chat_conversations; delete from public.push_tokens;
           update public.posts set moderation_status = 'active' where moderation_status = 'hidden' and id not in ('${P(90)}','${P(91)}')`);
        befriend(TARGET, 11); befriend(7, 11);
        mkSurvived(1, TARGET);                                                                 // a post of the target
        mkSurvived(2, 12);                                                                     // someone else's post
        Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(3)}','${U(TARGET)}','u','video','${P(2)}')`);   // a reaction of the target
      };
      const sanction = (who, user, kind, days = null, reason = "test") => as(U(who), `select public.admin_sanction_user('${U(user)}','${kind}',${days === null ? "null" : days},'${reason}')`);
      const lift = (who, user) => as(U(who), `select public.admin_lift_sanction('${U(user)}')`);
      const mine = (u) => as(U(u), `select coalesce(string_agg(kind || '|' || coalesce(until::text, ''), ','), '') from public.my_sanction()`).out;
      const logActions = () => q("select coalesce(string_agg(action, ',' order by created_at, id), '') from public.moderation_log");
      const readable = (viewer, post) => as(U(viewer), `select count(*) from public.posts where id='${post}'`).out;
      const tryPost = (u, n, parent = null) => psql("t", `set role authenticated; set request.jwt.claim.sub='${U(u)}'; insert into public.posts (id, user_id, media_url, media_type${parent ? ", parent_post_id" : ""}) values ('${P(n)}','${U(u)}','u','video'${parent ? `,'${parent}'` : ""})`, ["-v", "ON_ERROR_STOP=1"]);

      // ── 1. only the owner ──
      resetAll();
      eq("a non-admin cannot sanction, lift, list or read the log", [sanction(7, TARGET, "ban").ok, lift(7, TARGET).ok, as(U(7), `select count(*) from public.admin_sanctions_list()`).ok, as(U(7), `select count(*) from public.admin_moderation_log()`).ok], [false, false, false, false]);
      eq("the tables are closed and the internals are not callable by apps", [["account_sanctions", "moderation_log", "sanction_hidden_posts"].map((t) => as(U(7), `select count(*) from public.${t}`).ok), as(U(7), `select public.sanctions_expire()`).ok, as(U(7), `select public.account_sanction_of('${U(TARGET)}')`).ok], [[false, false, false], false, false]);
      eq("nothing is logged for refused attempts", logActions(), "");

      // ── 2. what can be sanctioned ──
      eq("suspend needs 1 to 365 days; a ban takes none; unknown kinds, unknown accounts, yourself and another admin are refused", [sanction(14, TARGET, "suspend").ok, sanction(14, TARGET, "suspend", 0).ok, sanction(14, TARGET, "suspend", 400).ok, sanction(14, TARGET, "mute", 3).ok, sanction(14, 14, "ban").ok, sanction(14, 999, "ban").ok, (Q(`insert into public.spotlight_admins (user_id) values ('${U(13)}') on conflict do nothing`), sanction(14, 13, "ban").ok)], Array(7).fill(false));
      Q(`delete from public.spotlight_admins where user_id='${U(13)}'`);
      eq("a normal account is fine before anything happens", [mine(TARGET), tryPost(TARGET, 5).status === 0], ["", true]);
      Q(`delete from public.posts where id='${P(5)}'`);

      // ── 3. suspend: enforcement, hiding, the sign-in screen ──
      resetAll();
      const sus = sanction(14, TARGET, "suspend", 7);
      ok("the owner suspends for 7 days", sus.ok);
      eq("the account sees 'suspend' with the end date at sign-in (my_sanction); other accounts see nothing", [/^suspend\|/.test(mine(TARGET)), mine(7), q(`select round(extract(epoch from (until - now())) / 86400) from public.account_sanctions`)], [true, "", "7"]);
      const blocked = (r) => [r.status !== 0, /account is suspended until/.test(r.stderr)];
      eq("a suspended account cannot post", blocked(tryPost(TARGET, 5)), [true, true]);
      eq("...cannot react", blocked(tryPost(TARGET, 6, P(2))), [true, true]);
      eq("...cannot like", (() => { const r = psql("t", `set role authenticated; set request.jwt.claim.sub='${U(TARGET)}'; insert into public.likes (user_id, post_id) values ('${U(TARGET)}','${P(2)}')`, ["-v", "ON_ERROR_STOP=1"]); return [r.status !== 0, /account is suspended until/.test(r.stderr)]; })(), [true, true]);
      eq("...cannot message (friends, through send_message and the older table path)", [as(U(TARGET), `select public.send_message('${U(11)}', 'hello')`).ok, /suspended/.test(as(U(TARGET), `select public.send_message('${U(11)}', 'hello')`).err), psql("t", `set role authenticated; set request.jwt.claim.sub='${U(TARGET)}'; insert into public.chat_messages (conversation_id, sender_id, body) select id, '${U(TARGET)}', 'x' from public.chat_conversations limit 1`, ["-v", "ON_ERROR_STOP=1"]).status !== 0], [false, true, true]);
      eq("everyone else still can", [tryPost(7, 7).status === 0, as(U(7), `select public.send_message('${U(11)}', 'hello')`).ok], [true, true]);
      eq("their post and reaction are hidden from everyone else (and from the feed), but the account still sees its own", [readable(7, P(1)), readable(7, P(3)), readable(TARGET, P(1)), as(U(7), `select count(*) from public.get_feed_engine(50, 0) where post_id='${P(1)}'`).out], ["0", "0", "1", "0"]);
      eq("it is logged: who, what, how long, how many posts were hidden", [logActions(), q(`select detail->>'days' || '/' || (detail->>'hidden_posts') from public.moderation_log where action='suspend'`), q(`select actor = '${U(14)}' and target_user = '${U(TARGET)}' from public.moderation_log where action='suspend'`)], ["suspend", "7/2", "t"]);

      // ── 4. unsuspend ──
      eq("unsuspend: sign-in screen gone, posts back, can post again, logged", (() => {
        const l = lift(14, TARGET).ok;
        return [l, mine(TARGET), readable(7, P(1)), readable(7, P(3)), tryPost(TARGET, 8).status === 0, logActions()];
      })(), [true, "", "1", "1", true, "suspend,unsuspend"]);
      eq("lifting when nothing is in force is refused", lift(14, TARGET).ok, false);

      // ── 5. posts hidden for another reason stay hidden ──
      resetAll();
      Q(`update public.posts set moderation_status = 'hidden' where id='${P(1)}'`);      // hidden by reports before
      sanction(14, TARGET, "suspend", 3);
      eq("a post already hidden by reports is not recorded as hidden by the sanction, and stays hidden after the lift; the reaction comes back", (() => { lift(14, TARGET); return [readable(7, P(1)), readable(7, P(3)), q("select count(*) from public.sanction_hidden_posts")]; })(), ["0", "1", "0"]);

      // ── 6. ban ──
      resetAll();
      eq("ban: no end date, 'banned' message, everything blocked, posts hidden", (() => {
        const b = sanction(14, TARGET, "ban", null, "harassment");
        return [b.ok, mine(TARGET), /account is banned/.test(tryPost(TARGET, 5).stderr), readable(7, P(1)), q("select until is null from public.account_sanctions")];
      })(), [true, "ban|", true, "0", "t"]);
      eq("unban: back to normal, logged as unban", (() => { lift(14, TARGET); return [mine(TARGET), readable(7, P(1)), tryPost(TARGET, 9).status === 0, logActions()]; })(), ["", "1", true, "ban,unban"]);
      eq("a new sanction replaces the one in force: one active at a time, posts hidden once and restored by the last lift", (() => {
        resetAll();
        sanction(14, TARGET, "suspend", 5); sanction(14, TARGET, "ban");
        const active = q(`select count(*) from public.account_sanctions where lifted_at is null`);
        const kind = mine(TARGET);
        lift(14, TARGET);
        return [active, kind, readable(7, P(1)), logActions()];
      })(), ["1", "ban|", "1", "suspend,ban,unban"]);

      // ── 7. a suspension ends by itself ──
      resetAll();
      sanction(14, TARGET, "suspend", 2);
      eq("when the time is up the account can post even before the job runs", (() => { Q(`update public.account_sanctions set until = now() - interval '1 minute'`); return [tryPost(TARGET, 10).status === 0]; })(), [true]);
      eq("the job (or any read) ends it: posts back, one 'suspension_ended' log line", (() => { as(U(TARGET), `select * from public.my_sanction()`); return [readable(7, P(1)), q("select count(*) from public.account_sanctions where lifted_at is not null"), logActions()]; })(), ["1", "1", "suspend,suspension_ended"]);
      eq("a ban never expires", (() => { resetAll(); sanction(14, TARGET, "ban"); Q(`update public.account_sanctions set created_at = now() - interval '5 years'`); as(U(TARGET), `select * from public.my_sanction()`); return mine(TARGET); })(), "ban|");

      // ── 8. every action is logged, including the queue's ──
      resetAll();
      Q(`insert into public.reports (id, reporter_id, target_type, target_id, reason) values ('${P(70)}','${U(7)}','post','${P(2)}','spam')`);
      as(U(14), `select public.admin_report_resolve('${P(70)}', 'dismiss')`);
      sanction(14, TARGET, "suspend", 1); lift(14, TARGET); sanction(14, TARGET, "ban"); lift(14, TARGET);
      eq("the log has every action in order: the report dismissed, suspend, unsuspend, ban, unban", logActions(), "report_dismissed,suspend,unsuspend,ban,unban");
      eq("the owner reads it with names; the sanctions list shows what is in force", [as(U(14), `select count(*) from public.admin_moderation_log(50)`).out, as(U(14), `select count(*) from public.admin_sanctions_list(true)`).out, as(U(14), `select count(*) from public.admin_sanctions_list(false)`).out], ["5", "0", "2"]);

      // ── 9. the owner's alert for each new report ──
      resetAll();
      Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(7)}','post','${P(2)}','harassment')`);
      eq("a new report notifies every admin (in-app, report_alert, with the post) and nobody else", [q(`select count(*) from public.notifications where type='report_alert' and recipient_id='${U(14)}' and post_id='${P(2)}'`), q(`select count(*) from public.notifications where type='report_alert'`), q(`select count(*) from public.spotlight_admins`), q(`select count(*) from public.notifications where type='report_alert' and recipient_id not in (select user_id from public.spotlight_admins)`)], ["1", "2", "2", "0"]);
      Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(9)}','message','${P(2)}','spam')`);
      eq("a report on a message carries no post; an admin reporting something is not alerted about their own report", [q(`select count(*) from public.notifications where type='report_alert' and post_id is null and recipient_id='${U(14)}'`), (Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(14)}','post','${P(1)}','other')`), q(`select count(*) from public.notifications where type='report_alert' and recipient_id='${U(14)}'`))], ["1", "2"]);
      eq("the push: an admin's alert is claimed for sending (category 'admin') when they have a token", (() => {
        Q(`insert into public.push_tokens (token, user_id) values ('ExponentPushToken[owner]', '${U(14)}')`);
        const r = psql("t", "select public.push_claim_batch(200)", ["-v", "ON_ERROR_STOP=1"]);
        const rows = JSON.parse(r.stdout.trim() || "[]");
        return [rows.filter((x) => x.type === "report_alert" && x.recipient_id === U(14)).length, rows.every((x) => Array.isArray(x.tokens))];
      })(), [2, true]);
      eq("...and a master 'push off' switch still turns it off", (() => {
        Q(`delete from public.notifications; insert into public.push_prefs (user_id, enabled) values ('${U(14)}', false) on conflict (user_id) do update set enabled = false`);
        Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(10)}','post','${P(2)}','other')`);
        const r = psql("t", "select public.push_claim_batch(200)", ["-v", "ON_ERROR_STOP=1"]);
        return [JSON.parse(r.stdout.trim() || "[]").filter((x) => x.type === "report_alert" && x.recipient_id === U(14)).length, q(`select push_skip_reason from public.notifications where type='report_alert' and recipient_id='${U(14)}'`)];
      })(), [0, "user setting"]);
      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
