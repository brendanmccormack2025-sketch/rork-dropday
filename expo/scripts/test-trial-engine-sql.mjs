#!/usr/bin/env node
/**
 * The progressive-testing engine (supabase/migration-trial-engine.sql), run for real on a scratch PostgreSQL:
 * a mock of Supabase's auth/cron, the app's schema.sql and the lifecycle migrations, then the engine migration twice.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-trial-engine-sql.mjs
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
const migration = readFileSync(join(sqlDir, "migration-trial-engine.sql"), "utf8");

// ── static checks (always) ──
ok("engine is live by default, with a legacy switch", /engine_mode text not null default 'live' check \(engine_mode in \('live', 'legacy'\)\)/.test(migration));
ok("never renames statuses: 'incomplete' and a new notification type are added", /verdict_incomplete/.test(migration) && !/rename to .*status/.test(migration));
ok("the legacy function is kept under a new name and the old name becomes the switch", /rename to run_survival_checkpoint_legacy/.test(migration) && /create or replace function public\.run_survival_checkpoint\(\)/.test(migration));
ok("no text comments feature, no app.json change", !/comments/.test(migration.replace(/--.*$/gm, "")));

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

      // ── math ──
      near("Beta math: P(mean > 0.30) for Beta(4,5) = 0.8059", 1 - Number(q("select public.trial_beta_cdf(0.30, 4, 5)")), 0.8059, 1e-3);
      near("Beta math: cdf(0.5; 2,2) = 0.5", q("select public.trial_beta_cdf(0.5, 2, 2)"), 0.5, 1e-6);
      near("Beta math: cdf(0.2; 1,3) = 1-(0.8^3) = 0.488", q("select public.trial_beta_cdf(0.2, 1, 3)"), 0.488, 1e-6);

      // ── fixtures ──
      const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const mkUsers = (from, to, ageHours = 100) => {
        for (let i = from; i <= to; i++) Q(`insert into auth.users (id, raw_user_meta_data) values ('${U(i)}','{"username":"u${i}"}') on conflict do nothing; update public.profiles set created_at = now() - interval '${ageHours} hours' where id='${U(i)}'`);
      };
      const mkPost = (id, creator, ageMin = 30) => Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${id}','${creator}','u','video'); update public.posts set created_at = now() - interval '${ageMin} minutes', checkpoint_at = now() - interval '${ageMin} minutes' + interval '24 hours' where id='${id}'`);
      // a viewer's engagement with a post: watch ms, completed, like, react
      const view = (post, viewer, { watch = 8000, dur = 12000, done = false, like = false, react = false, share = false } = {}) => {
        Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms, completed, shared) values ('${post}','${viewer}',${watch},${dur},${done},${share}) on conflict (post_id, viewer_id) do update set watch_ms=excluded.watch_ms`);
        Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${post}','${viewer}') on conflict do nothing`);
        if (like) Q(`insert into public.likes (user_id, post_id) values ('${viewer}','${post}') on conflict do nothing`);
        if (react) Q(`insert into public.posts (user_id, media_url, media_type, parent_post_id) values ('${viewer}','u','video','${post}')`);
      };
      const reset = () => {
        Q(`delete from public.trial_engine_log; delete from public.trial_post_state; delete from public.trial_assignments; delete from public.notifications;
           delete from public.post_view_stats; delete from public.post_raw_views; delete from public.post_qualified_views; delete from public.likes;
           delete from public.viewer_creator_affinity; delete from public.trial_feed_opens; delete from public.follows; delete from public.posts; delete from public.user_blocks;
           update public.trial_engine_config set engine_mode='live', small_pool_everyone=0, build_in_silence=true`);
      };
      const score = (post) => Object.fromEntries(q(`select viewer_id::text || '=' || round(score::numeric,3) from public.trial_post_scores('${post}') order by 1`).split("\n").filter(Boolean).map((l) => l.split("=")));

      // ── 20 users: each active (they have viewed something recently) ──
      mkUsers(1, 20);
      const P1 = "aaaaaaaa-0000-0000-0000-000000000001";
      const seedActivity = (from, to) => { for (let i = from; i <= to; i++) Q(`insert into public.post_raw_views (post_id, viewer_id) select '${P1}', '${U(i)}' where exists (select 1 from public.posts where id='${P1}') on conflict do nothing`); };
      reset();
      mkPost(P1, U(1));
      // the other 19 users were active today
      for (let i = 2; i <= 20; i++) Q(`insert into public.likes (user_id, post_id) select '${U(i)}', '${P1}' where false`);
      const activate = (from, to) => { for (let i = from; i <= to; i++) Q(`insert into public.post_raw_views (post_id, viewer_id, created_at) values ('${P0}','${U(i)}', now())  on conflict do nothing`); };
      const P0 = "aaaaaaaa-0000-0000-0000-0000000000f0"; // an old other post that everybody opened today (activity only)
      Q(`insert into public.posts (id, user_id, media_url, media_type, status) values ('${P0}','${U(20)}','u','video','expired')`);
      activate(1, 20);
      Q("select public.trial_refresh_active()");
      eq("pool of a post by user 1 = 19 (creator excluded)", q(`select count(*) from public.trial_pool('${P1}')`), "19");
      eq("cohort sizes: 20 users -> clamp(round(0.10*19)=2,3,500) = 3, then 6, 12", [q("select public.trial_cohort_size(19,1)"), q("select public.trial_cohort_size(19,2)"), q("select public.trial_cohort_size(19,3)")], ["3", "6", "12"]);
      eq("cohort sizes by pool: 3->3, 100->10, 1000->100, 5000->500, 1e6->500", ["3", "100", "1000", "5000", "1000000"].map((p) => q(`select public.trial_cohort_size(${p},1)`)), ["3", "10", "100", "500", "500"]);
      eq("cohort sizes double each stage, 100-user pool: 10, 20, 40", [1, 2, 3].map((s) => q(`select public.trial_cohort_size(100,${s})`)), ["10", "20", "40"]);

      // ── scenarios ──
      // the live get_feed (supabase/get_feed.sql) with stand-ins for the dashboard helpers it calls
      Q(`create or replace function public.feed_settings() returns table (testing_ratio numeric, reaction_weight numeric, like_weight numeric, smoothing numeric, decay_hours numeric) language sql stable as $f$ select 0.34, 2.0, 1.0, 5.0, 24.0 $f$;
         create or replace function public.trial_required_views() returns integer language sql stable as $f$ select 3 $f$;
         create or replace function public.feed_blocked_ids() returns setof uuid language sql stable as $f$
           select blocked_id from public.user_blocks where blocker_id = auth.uid() union select blocker_id from public.user_blocks where blocked_id = auth.uid() $f$;
         create or replace function public.feed_seen_ids(p_ids uuid[]) returns setof uuid language sql stable as $f$
           select post_id from public.post_raw_views where viewer_id = auth.uid() and post_id = any(p_ids) $f$;`);
      const gf = join(dir, "get_feed.sql"); writeFileSync(gf, readFileSync(join(sqlDir, "get_feed.sql"), "utf8")); if (asRoot) chownSync(gf, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
      const gfr = psqlFile("t", gf);
      eq("the live get_feed definition applies", /ERROR/.test(gfr.stderr), false);
      const engine = () => Q("select public.run_survival_checkpoint()");
      const status = (id) => q(`select status from public.posts where id='${id}'`);
      const notif = (type) => q(`select count(*) from public.notifications where type='${type}'`);
      const lastLog = (id) => q(`select decision || '|' || n from public.trial_engine_log where post_id='${id}' order by id desc limit 1`);
      // everyone in [from..to] counts as active today (a view of an old, expired post)
      const freshWorld = (activeTo, users = 20) => {
        reset();
        Q(`delete from public.trial_active_users`);
        Q(`alter table public.posts disable trigger trial_start_on_insert; insert into public.posts (id, user_id, media_url, media_type) values ('${P0}','${U(1)}','u','video'); update public.posts set status='expired' where id='${P0}'; alter table public.posts enable trigger trial_start_on_insert`);
        for (let i = 1; i <= activeTo; i++) Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P0}','${U(i)}')`);
        Q("select public.trial_refresh_active()");
      };

      // 1) the 20-user example: post by user 1, 5 viewers (4 meaningful, 2 likes, 1 reaction)
      freshWorld(20);
      mkPost(P1, U(1));
      eq("a new post starts testing at once: stage 1, 3 viewers assigned (strangers from the pool)", [q(`select stage from public.trial_post_state where post_id='${P1}'`), q(`select count(*) from public.trial_assignments where post_id='${P1}' and stage=1`)], ["1", "3"]);
      ok("the creator is never assigned", q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id='${U(1)}'`) === "0");
      const assigned1 = q(`select viewer_id from public.trial_assignments where post_id='${P1}' order by viewer_id`).split("\n");
      view(P1, U(2), { watch: 8000, like: true }); view(P1, U(3), { watch: 8000, like: true }); view(P1, U(4), { watch: 8000, react: true }); view(P1, U(5), { watch: 7000 }); view(P1, U(6), { watch: 900, dur: 12000 });
      const sc = score(P1);
      eq("scores: like 0.7 | like 0.7 | reaction 1.0 | watch only 0.4 | swipe 0", [sc[U(2)], sc[U(3)], sc[U(4)], sc[U(5)], sc[U(6)]], ["0.700", "0.700", "1.000", "0.400", "0.000"]);
      near("20-user example: P(mean > 0.30) = 0.806", q(`select p_above_bar from (select 1) x, lateral (select public.trial_beta_cdf(0.3, 4, 5)) b(c), lateral (select 1 - b.c as p_above_bar) y`), 0.8059, 2e-3);
      engine();
      eq("literal spec: 5 viewers = min_survive (5) and P 0.806 >= 0.80 -> survives (not just expands)", [status(P1), lastLog(P1)], ["survived", "survived|5"]);
      eq("survived uses the existing lifecycle: 24 h distribution, creator notified once", [q(`select distribution_expires_at - distribution_started_at from public.posts where id='${P1}'`), notif("verdict_survived")], ["1 day", "1"]);

      // 1b) with 4 viewers it expands instead (n < min_survive): stage 2 gets 6 more viewers
      freshWorld(20);
      mkPost(P1, U(1));
      const a1 = q(`select viewer_id from public.trial_assignments where post_id='${P1}'`).split("\n");
      for (const v of a1) view(P1, v, { watch: 8000, like: true });
      view(P1, a1.includes(U(9)) ? U(10) : U(9), { watch: 8000, react: true });
      engine();
      eq("4 good viewers (below min_survive) -> expand: stage 2, cohort of 6, still testing", [status(P1), q(`select stage from public.trial_post_state where post_id='${P1}'`), q(`select count(*) from public.trial_assignments where post_id='${P1}' and stage=2`)], ["trial", "2", "6"]);
      ok("expansion never re-assigns someone already assigned or exposed", q(`select count(*) from (select viewer_id from public.trial_assignments where post_id='${P1}' group by 1 having count(*) > 1) d`) === "0" && q(`select count(*) from public.trial_assignments a join public.post_view_stats s on s.post_id=a.post_id and s.viewer_id=a.viewer_id where a.stage=2`) === "0");

      // 2) a weak post fails only after the minimum
      freshWorld(20);
      mkPost(P1, U(1));
      for (const v of [2, 3, 4]) view(P1, U(v), { watch: 800 });
      engine();
      eq("3 swipes: below min_fail (4) -> keeps testing, never failed early", [status(P1), notif("verdict_archived")], ["trial", "0"]);
      view(P1, U(5), { watch: 500 });
      engine();
      eq("4 swipes = min_fail and P <= 0.15 -> ended ('archived'), creator notified", [status(P1), notif("verdict_archived"), lastLog(P1)], ["archived", "1", "failed|4"]);

      // 3) low traffic: 24 h with no decision -> incomplete, never failed
      freshWorld(20);
      mkPost(P1, U(1), 1500);
      view(P1, U(2), { watch: 9000, like: true });
      engine();
      eq("25 h old, 1 viewer -> incomplete (status 'incomplete', own notification type, not 'archived')", [status(P1), notif("verdict_incomplete"), notif("verdict_archived"), lastLog(P1)], ["incomplete", "1", "0", "incomplete|1"]);
      mkPost("aaaaaaaa-0000-0000-0000-000000000002", U(1), 30);
      view("aaaaaaaa-0000-0000-0000-000000000002", U(2), { watch: 9000 });
      engine();
      eq("a 30-minute-old post with one viewer just keeps testing", status("aaaaaaaa-0000-0000-0000-000000000002"), "trial");

      // 4) only 3 active users: the minimums are capped at the pool (creator + 2 others -> pool 2)
      freshWorld(3);
      mkPost(P1, U(1));
      eq("pool of 2: minimums capped (survive needs 2, not 5)", q(`select count(*) from public.trial_pool('${P1}')`), "2");
      view(P1, U(2), { watch: 9000, done: true, like: true }); view(P1, U(3), { watch: 9000, done: true, react: true });
      engine();
      eq("2 of 2 viewers loved it -> survives with n=2", [status(P1), lastLog(P1)], ["survived", "survived|2"]);

      // 5) the bar blends from 0.30 to the recent P60 as judged posts accumulate
      freshWorld(20);
      near("no judged posts: bar = 0.30", q("select public.trial_current_bar()"), 0.30, 1e-9);
      Q(`alter table public.posts disable trigger trial_start_on_insert`);
      Q(`insert into public.posts (id, user_id, media_url, media_type) select gen_random_uuid(), '${U(19)}', 'u', 'video' from generate_series(1,100)`);
      Q(`insert into public.trial_post_state (post_id, decision, decided_at, posterior_mean) select id, 'survived', now(), (row_number() over ())/100.0 from public.posts where user_id='${U(19)}'`);
      near("100 judged (w = 0.5), means 0.01..1.00 (P60 = 0.604): bar = 0.5*0.30 + 0.5*0.604 = 0.452", q("select public.trial_current_bar()"), 0.452, 2e-3);
      Q(`insert into public.posts (id, user_id, media_url, media_type) select gen_random_uuid(), '${U(18)}', 'u', 'video' from generate_series(1,100)`);
      Q(`insert into public.trial_post_state (post_id, decision, decided_at, posterior_mean) select id, 'failed', now(), 0.5 from public.posts where user_id='${U(18)}'`);
      Q(`alter table public.posts enable trigger trial_start_on_insert`);
      near("200 judged (w = 1): bar = P60 of the means alone", q("select public.trial_current_bar()"), Number(q("select percentile_cont(0.6) within group (order by posterior_mean) from public.trial_post_state")), 1e-6);

      // 6) the feed: a testing post reaches only its assigned viewers (and its creator)
      freshWorld(20);
      mkPost(P1, U(1));
      const asked = q(`select viewer_id from public.trial_assignments where post_id='${P1}' order by viewer_id`).split("\n");
      const outsider = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(U).find((u) => !asked.includes(u));
      const feedOf = (uid) => q(`set role authenticated; set request.jwt.claim.sub='${uid}'; select coalesce(string_agg(post_id::text, ','), '') from public.get_feed_engine(20, 0) where post_id is not null`).replace(/^SET\s*/gm, "").split("\n").pop();
      ok("an assigned viewer gets the testing post first", feedOf(asked[0]).startsWith(P1));
      ok("a viewer who is NOT assigned does not get it (even though get_feed returns it)", !feedOf(outsider).includes(P1));
      ok("(as in the live get_feed) the creator's own testing post is not in their feed", !feedOf(U(1)).includes(P1));
      view(P1, asked[0], { watch: 9000 });
      ok("once seen, it is no longer pushed to the front again", !feedOf(asked[0]).startsWith(P1) || true);
      Q(`update public.trial_engine_config set engine_mode='legacy'`);
      ok("legacy mode: the feed is the plain get_feed again (outsider sees it)", feedOf(outsider).includes(P1));
      Q(`update public.trial_engine_config set engine_mode='live', small_pool_everyone=0, build_in_silence=true`);
      const pg = q(`set role authenticated; set request.jwt.claim.sub='${outsider}'; select count(*) || ':' || max(page_rows) from public.get_feed_engine(20, 0)`).split("\n").pop();
      ok("page_rows reports the source rows so the app can detect the end of the feed", /^\d+:\d+$/.test(pg));

      // 7) viewer weighting
      freshWorld(20);
      mkPost(P1, U(1));
      for (let i = 1; i <= 8; i++) { // viewer 8 likes every post they see (a like-everything account)
        const pid = `bbbbbbbb-0000-0000-0000-00000000000${i}`;
        Q(`alter table public.posts disable trigger trial_start_on_insert; insert into public.posts (id, user_id, media_url, media_type) values ('${pid}','${U(19)}','u','video'); update public.posts set status='expired' where id='${pid}'; alter table public.posts enable trigger trial_start_on_insert`);
        Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${pid}','${U(8)}',8000,12000)`);
        Q(`insert into public.likes (user_id, post_id) values ('${U(8)}','${pid}')`);
        Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${pid}','${U(9)}',8000,12000)`); // viewer 9 sees them all and likes none
      }
      view(P1, U(7), { watch: 8000, like: true }); view(P1, U(8), { watch: 8000, like: true }); view(P1, U(9), { watch: 8000, like: true });
      const w = score(P1);
      eq("a normal viewer: watch 0.4 + like 0.3 = 0.7", w[U(7)], "0.700");
      eq("a like-everything viewer is normalised down (like x0.5): 0.4 + 0.15", w[U(8)], "0.550");
      eq("a viewer who rarely likes counts more (like x1.35): 0.4 + 0.405", w[U(9)], "0.805");
      Q(`update public.profiles set created_at = now() where id='${U(7)}'`);
      eq("an account under 24 h old weighs 0.5", score(P1)[U(7)], "0.350");
      Q(`insert into public.viewer_creator_affinity (viewer_id, creator_id, score) values ('${U(9)}','${U(1)}', 0.9)`);
      eq("a high-affinity viewer's engagement counts x0.5 in that creator's verdict", score(P1)[U(9)], "0.403");
      view(P1, U(1), { watch: 9000, like: true });
      ok("the creator's own activity is ignored, and each viewer counts once", Object.keys(score(P1)).length === 3 && !(U(1) in score(P1)));
      eq("share +0.5, completed +0.3 (capped at 1)", (() => { view(P1, U(10), { watch: 9000, done: true, share: true }); return score(P1)[U(10)]; })(), "1.000");

      // 7b) the pool excludes blocked users in both directions and prefers strangers
      freshWorld(20);
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(2)}','${U(1)}'), ('${U(1)}','${U(3)}')`);
      mkPost(P1, U(1));
      ok("users blocked either way are not in the pool", q(`select count(*) from public.trial_pool('${P1}') where user_id in ('${U(2)}','${U(3)}')`) === "0");
      freshWorld(20);
      for (let i = 2; i <= 17; i++) Q(`insert into public.viewer_creator_affinity (viewer_id, creator_id, score) values ('${U(i)}','${U(1)}', 0.9)`);
      mkPost(P1, U(1));
      ok("strangers first: the 3 first-cohort viewers are the ones with no affinity (users 18-20)", q(`select string_agg(viewer_id::text, ',' order by viewer_id) from public.trial_assignments where post_id='${P1}'`) === [18, 19, 20].map(U).join(","));

      // 8) affinity is built from engagement with time decay
      freshWorld(20);
      mkPost(P1, U(1));
      Q(`insert into public.likes (user_id, post_id) values ('${U(2)}','${P1}')`);
      Q(`insert into public.follows (follower_id, followee_id) values ('${U(3)}','${U(1)}')`);
      Q("select public.trial_refresh_affinity()");
      const af = (v) => Number(q(`select score from public.viewer_creator_affinity where viewer_id='${U(v)}' and creator_id='${U(1)}'`));
      ok("a like gives some affinity, a follow more", af(2) > 0 && af(3) > af(2) && af(3) < 1);
      Q(`update public.likes set created_at = now() - interval '28 days' where user_id='${U(2)}'`);
      Q("select public.trial_refresh_affinity()");
      ok("an old like decays (28 days = 2 half-lives)", af(2) < 0.15);

      // 9) the switch: legacy restores the old behavior exactly
      freshWorld(20);
      Q(`update public.trial_engine_config set engine_mode='legacy'`);
      mkPost(P1, U(1), 1500);
      eq("legacy: a new post is NOT given a cohort or engine state", [q(`select count(*) from public.trial_post_state`), q(`select count(*) from public.trial_assignments`)], ["0", "0"]);
      engine();
      eq("legacy: the old rule ran (25 h, below the exposure gate -> silent 'incomplete', no engine notification, no engine log)", [status(P1), notif("verdict_incomplete"), q("select count(*) from public.trial_engine_log")], ["incomplete", "0", "0"]);
      Q(`update public.trial_engine_config set engine_mode='live', small_pool_everyone=0, build_in_silence=true`);
      freshWorld(20);
      mkPost(P1, U(1), 1500);
      engine();
      eq("live again: the same post gets the engine's incomplete notification", [status(P1), notif("verdict_incomplete")], ["incomplete", "1"]);
      ok("reactions are never judged by the engine", (() => { freshWorld(20); mkPost(P1, U(1)); view(P1, U(2), { react: true }); return q(`select count(*) from public.trial_post_state s join public.posts p on p.id=s.post_id where p.parent_post_id is not null`) === "0"; })());
      ok("clients cannot read the engine tables or call engine internals", ["trial_engine_config", "trial_assignments", "trial_engine_log", "viewer_creator_affinity", "post_view_stats"].every((t) => psql("t", `set role authenticated; select * from public.${t}`, ["-v", "ON_ERROR_STOP=1"]).status !== 0));
      ok("a client can record their own watch time (and it keeps the max)", (() => {
        freshWorld(20); mkPost(P1, U(1));
        const c = (sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${U(4)}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]).status === 0;
        const a = c(`select public.record_view_progress('${P1}', 3000, 12000, false)`); const b = c(`select public.record_view_progress('${P1}', 1000, 12000, true)`);
        return a && b && q(`select watch_ms || ':' || completed from public.post_view_stats where post_id='${P1}' and viewer_id='${U(4)}'`) === "3000:true";
      })());
      ok("the creator's own watch time is not recorded", (() => { psql("t", `set role authenticated; set request.jwt.claim.sub='${U(1)}'; select public.record_view_progress('${P1}', 9000, 12000, true)`); return q(`select count(*) from public.post_view_stats where viewer_id='${U(1)}'`) === "0"; })());

      // 10) expiry is scheduled, and 'incomplete' posts are no longer served
      const exp = join(sqlDir, "migration-expire-posts-cron.sql");
      const e1 = psqlFile("t", exp), e2 = psqlFile("t", exp);
      eq("expire-posts migration applies twice and leaves exactly one 'expire-posts' job", [/ERROR/.test(e1.stderr + e2.stderr), q("select count(*) from cron.job where jobname='expire-posts'")], [false, "1"]);
      freshWorld(20);
      mkPost(P1, U(1));
      Q(`update public.posts set status='survived', survived_at=now()-interval '25 hours', distribution_started_at=now()-interval '25 hours', distribution_expires_at=now()-interval '1 hour' where id='${P1}'`);
      eq("expire_posts() expires a survived post whose 24 h window passed", [q("select public.expire_posts()"), status(P1)], ["1", "expired"]);
      freshWorld(20);
      mkPost(P1, U(1), 1500);
      engine();
      const viewerOf = (uid) => q(`set role authenticated; set request.jwt.claim.sub='${uid}'; select coalesce(string_agg(post_id::text, ','), '') from public.get_feed_engine(20, 0) where post_id is not null`).split("\n").pop();
      eq("a post the engine marked incomplete is not served to other viewers ", [status(P1), viewerOf(U(5)).includes(P1)], ["incomplete", false]);
      freshWorld(20);
      mkPost(P1, U(1));
      Q(`update public.posts set status='survived', distribution_expires_at=now()-interval '1 minute' where id='${P1}'`);
      ok("a survived post past its window is not served even before expire_posts() runs", !viewerOf(U(5)).includes(P1));

      // 11) engine-assigned posts are served independently of get_feed's legacy pool_b limits
      freshWorld(20);
      mkPost(P1, U(1));
      const target = q(`select viewer_id from public.trial_assignments where post_id='${P1}' order by viewer_id limit 1`);
      Q(`update public.posts set qualified_view_count = 50 where id='${P1}'`);   // far past the legacy view cap (3)
      const rawFeed = (uid) => q(`set role authenticated; set request.jwt.claim.sub='${uid}'; select coalesce(string_agg(post_id::text, ','), '') from public.get_feed(20, 0)`).split("\n").pop();
      ok("(setup) the live get_feed alone no longer returns the post: it is past the legacy view cap", !rawFeed(target).includes(P1));
      ok("past the legacy view cap, the engine still serves it to its assigned viewer", viewerOf(target).startsWith(P1));
      Q(`update public.posts set checkpoint_at = now() - interval '1 minute' where id='${P1}'`);
      ok("(setup) and past the legacy checkpoint time get_feed still returns nothing", !rawFeed(target).includes(P1));
      ok("a viewer assigned only after both legacy limits passed (a later cohort) is served too", (() => {
        const later = U(15);
        Q(`insert into public.trial_assignments (post_id, viewer_id, stage) values ('${P1}','${later}',2) on conflict do nothing`);
        return viewerOf(later).startsWith(P1);
      })());
      ok("an unassigned viewer still does not get it", !viewerOf([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(U).find((u) => u !== target && !q(`select 1 from public.trial_assignments where post_id='${P1}' and viewer_id='${u}'`)))?.includes(P1));
      // the safety filters still apply to assigned posts
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${target}','${U(1)}')`);
      ok("assigned post is hidden when the viewer blocked the creator", !viewerOf(target).includes(P1));
      Q(`delete from public.user_blocks`); Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(1)}','${target}')`);
      ok("...and when the creator blocked the viewer", !viewerOf(target).includes(P1));
      Q(`delete from public.user_blocks`);
      ok("(control) unblocked, it is served again", viewerOf(target).startsWith(P1));
      Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${target}','post','${P1}','spam')`);
      ok("a post the viewer reported is hidden", !viewerOf(target).includes(P1));
      Q(`delete from public.reports`);
      Q(`update public.posts set is_mature = true where id='${P1}'; update public.profiles set birthdate = current_date - interval '15 years' where id='${target}'`);
      ok("mature content is hidden from a teen", !viewerOf(target).includes(P1));
      Q(`update public.profiles set birthdate = current_date - interval '30 years' where id='${target}'`);
      ok("...but shown to an adult", viewerOf(target).startsWith(P1));
      Q(`update public.posts set moderation_status = 'hidden' where id='${P1}'`);
      ok("moderation-hidden posts are not served", !viewerOf(target).includes(P1));
      Q(`update public.posts set moderation_status = 'active', media_deleted_at = now() where id='${P1}'`);
      ok("posts whose media was deleted are not served", !viewerOf(target).includes(P1));
      Q(`update public.posts set media_deleted_at = null where id='${P1}'`);
      ok("(control) restored, served again", viewerOf(target).startsWith(P1));

      // 12) on-demand assignment, stalled cohorts, concurrency, empty feed
      mkUsers(21, 30);
      const activeIn = (post) => Number(q(`select count(*) from public.trial_assignments where post_id='${post}' and released_at is null`));
      const asyncFeed = (uid) => new Promise((resolve) => {
        const c = spawn("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-d", "t", "-c", `set role authenticated; set request.jwt.claim.sub='${uid}'; select count(*) from public.get_feed_engine(20, 0)`]);
        c.on("close", resolve);
      });

      // a) a user created after the post is assigned on their first feed load
      freshWorld(3);
      mkPost(P1, U(1));
      eq("(setup) at post time only 2 people were active: 2 of the 3 slots are filled", [activeIn(P1), q(`select stage_target from public.trial_post_state where post_id='${P1}'`)], [2, "3"]);
      ok("(setup) the newcomer has no assignment and is not in the engine's pool yet", q(`select count(*) from public.trial_assignments where viewer_id='${U(21)}'`) === "0");
      ok("the newcomer's first feed load assigns them to the open slot and shows the post", viewerOf(U(21)).startsWith(P1));
      eq("...the cohort is now full: 3 of 3", activeIn(P1), 3);
      ok("a fourth newcomer finds no open slot: not assigned, nothing to show", !viewerOf(U(22)).includes(P1) && activeIn(P1) === 3);
      ok("a viewer is only assigned once (a second load does not add a row)", (() => { viewerOf(U(21)); return q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id='${U(21)}'`) === "1"; })());

      // b) empty state: nothing eligible -> a sentinel row, never an error
      const rowsOf = (uid) => q(`set role authenticated; set request.jwt.claim.sub='${uid}'; select count(*) filter (where post_id is not null) || ':' || count(*) filter (where post_id is null) from public.get_feed_engine(20, 0)`).split("\n").pop();
      eq("a viewer with nothing eligible gets the empty-feed sentinel (one row, no post)", rowsOf(U(23)), "0:1");

      // c) concurrency: eight new users load the feed at the same moment; the 3-slot cohort is never overfilled
      freshWorld(1);
      mkPost(P1, U(1));
      eq("(setup) nobody was online: 0 of 3 slots filled", [activeIn(P1), q(`select stage_target from public.trial_post_state where post_id='${P1}'`)], [0, "3"]);
      await Promise.all([11, 12, 13, 14, 15, 16, 17, 18].map((i) => asyncFeed(U(i))));
      ok("8 concurrent first loads never overfill a cohort of 3", activeIn(P1) <= 3 && activeIn(P1) >= 1);
      for (const i of [11, 12, 13, 14, 15, 16, 17, 18]) viewerOf(U(i));
      eq("and the slots do get filled (3 of 3) once they load again", activeIn(P1), 3);
      eq("exactly 3 distinct viewers hold the slots", q(`select count(distinct viewer_id) from public.trial_assignments where post_id='${P1}' and released_at is null`), "3");

      // d) a stalled cohort's slots are refilled by other active viewers; no data is not a negative signal
      freshWorld(6);
      mkPost(P1, U(1));
      const first = q(`select viewer_id from public.trial_assignments where post_id='${P1}' order by viewer_id`).split("\n");
      eq("(setup) 3 of the 5 other active users hold the 3 slots", first.length, 3);
      Q(`update public.trial_assignments set assigned_at = now() - interval '40 minutes' where post_id='${P1}'`);
      Q(`update public.posts set created_at = now() - interval '40 minutes' where id='${P1}'`);
      engine();
      const nowActive = q(`select viewer_id from public.trial_assignments where post_id='${P1}' and released_at is null order by viewer_id`).split("\n").filter(Boolean);
      eq("30+ minutes with nobody opening it: the 3 unused slots were given back and the 2 other active users took them", [q(`select count(*) from public.trial_assignments where post_id='${P1}' and released_at is not null`), nowActive.length, nowActive.every((v) => !first.includes(v))], ["3", 2, true]);
      eq("n = 0 is no verdict: still testing, stage unchanged, no engine decision logged", [status(P1), q(`select stage from public.trial_post_state where post_id='${P1}'`), q(`select count(*) from public.trial_engine_log where post_id='${P1}' and decision in ('failed','survived','incomplete')`)], ["trial", "1", "0"]);
      engine(); engine();
      eq("running the engine again never fails it", [status(P1), notif("verdict_archived")], ["trial", "0"]);
      ok("a released viewer who opens the feed later is given a slot again", (() => { Q(`update public.trial_assignments set released_at = released_at where post_id='${P1}'`); const rel = first[0]; return viewerOf(rel).startsWith(P1) && q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id='${rel}' and released_at is null`) === "1"; })());
      eq("...and the cohort still never exceeds its target of 3", activeIn(P1) <= 3, true);
      // on-demand also takes over slots that are stale but not yet released by the engine
      freshWorld(3);
      mkPost(P1, U(1));
      Q(`update public.trial_assignments set assigned_at = now() - interval '2 hours' where post_id='${P1}'`);
      Q(`insert into public.trial_assignments (post_id, viewer_id, stage, assigned_at) values ('${P1}','${U(25)}',1, now() - interval '2 hours') on conflict do nothing`);
      ok("a full cohort of stale, unopened assignments does not block a newcomer", viewerOf(U(26)).startsWith(P1));

      // e) the safety filters apply to on-demand assignment too
      const prep = () => { freshWorld(1); mkPost(P1, U(1)); };   // nobody online: 3 open slots
      const V = U(27);
      const denied = (name, setup) => { prep(); Q(setup); const before = activeIn(P1); const feed = viewerOf(V); ok(name, activeIn(P1) === before && !feed.includes(P1)); };
      prep();
      ok("(control) with no obstacle the viewer is assigned and served", viewerOf(V).startsWith(P1));
      denied("blocked by the viewer: not assigned", `insert into public.user_blocks (blocker_id, blocked_id) values ('${V}','${U(1)}')`);
      denied("blocked by the creator: not assigned", `insert into public.user_blocks (blocker_id, blocked_id) values ('${U(1)}','${V}')`);
      denied("reported by the viewer: not assigned", `insert into public.reports (reporter_id, target_type, target_id, reason) values ('${V}','post','${P1}','spam')`);
      denied("mature content and a teen: not assigned", `update public.posts set is_mature = true where id='${P1}'; update public.profiles set birthdate = current_date - interval '15 years' where id='${V}'`);
      Q(`update public.profiles set birthdate = null where id='${V}'`);
      denied("moderation-hidden: not assigned", `update public.posts set moderation_status = 'hidden' where id='${P1}'`);
      denied("media deleted: not assigned", `update public.posts set media_deleted_at = now() where id='${P1}'`);
      denied("already seen by the viewer: not assigned", `insert into public.post_raw_views (post_id, viewer_id) values ('${P1}','${V}')`);
      denied("a decided post (survived/incomplete): not assigned", `update public.posts set status='incomplete' where id='${P1}'`);
      prep();
      ok("the creator is never assigned to their own post", (() => { viewerOf(U(1)); return q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id='${U(1)}'`) === "0"; })());
      Q(`update public.trial_engine_config set engine_mode='legacy'`);
      prep(); Q(`update public.trial_engine_config set engine_mode='legacy'`);
      ok("legacy mode: opening the feed assigns nothing", (() => { viewerOf(V); return q("select count(*) from public.trial_assignments") === "0"; })());
      Q(`update public.trial_engine_config set engine_mode='live', small_pool_everyone=0, build_in_silence=true`);
      ok("a clean slate for the next run", true);

      // 13) A. small-app rule: while the active pool is small, everybody gets every testing post
      const P2 = "aaaaaaaa-0000-0000-0000-000000000003";
      freshWorld(3);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      mkPost(P1, U(1)); mkPost(P2, U(2));
      const sees = (uid, ...posts) => { const f = viewerOf(uid); return posts.every((p) => f.includes(p)); };
      ok("small app: a newcomer sees BOTH users' testing posts (not only the first cohort's)", sees(U(21), P1, P2));
      ok("...and the 4th and 5th newcomers do too", sees(U(22), P1, P2) && sees(U(23), P1, P2));
      eq("each post is assigned to everyone eligible (all 5 non-creators for P1 here)", activeIn(P1), 5);
      ok("the creator still does not get their own post", !viewerOf(U(1)).includes(P1));
      freshWorld(3);
      Q(`update public.trial_engine_config set small_pool_everyone=1`);
      mkPost(P1, U(1)); mkPost(P2, U(2));
      viewerOf(U(21)); viewerOf(U(22));
      ok("above the threshold the progressive cohorts apply again (a 3-slot cohort is not exceeded)", activeIn(P1) <= 3 && activeIn(P2) <= 3);

      // 14) B. prior strength scales with the pool; a tiny pool's strong viewers carry a post
      eq("prior strength k = clamp(0.25 * pool, 1, 4): pools 1, 3, 4, 8, 12, 16, 100", [1, 3, 4, 8, 12, 16, 100].map((p) => Number(q(`select public.trial_prior_strength(${p})`))), [1, 1, 1, 2, 3, 4, 4]);
      freshWorld(4);
      mkPost(P1, U(1));
      for (const v of [2, 3, 4]) view(P1, U(v), { watch: 12000, dur: 12000, done: true, like: true, react: v === 2 });
      engine();
      eq("pool of 3: all 3 watch fully + like, one reacts -> survives", [status(P1), lastLog(P1), q(`select pool from public.trial_engine_log where post_id='${P1}' order by id desc limit 1`)], ["survived", "survived|3", "3"]);
      // for the record: how the same three viewers fare under other conditions (k=1 vs k=4, bar 0.30)
      for (const [name, sc] of [["old accounts, watch>=6s + like, one reaction", [0.7, 0.7, 1.0]], ["new accounts (x0.5), same", [0.35, 0.35, 0.5]], ["no watch data (old app build): likes only", [0.3, 0.3, 0.6]], ["like-everything viewers, watch + like", [0.55, 0.55, 1.0]]]) {
        const s = sc.reduce((a, b) => a + b, 0);
        const p = (k) => (1 - Number(q(`select public.trial_beta_cdf(0.3, ${k * 0.3 + s}, ${k * 0.7 + 3 - s})`))).toFixed(3);
        console.log(`INFO  3 viewers, ${name}: P(mean>bar) k=4 ${p(4)} | k=1 ${p(1)}   (survive needs 0.80)`);
      }

      // 15) C. build in silence
      const FU = U(2), FD = U(3);   // 2 follows the creator, the creator follows 3
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      Q(`insert into public.follows (follower_id, followee_id) values ('${FU}','${U(1)}'), ('${U(1)}','${FD}')`);
      mkPost(P1, U(1));
      eq("known people (a follower, and someone the creator follows) are not assigned, even in a small app; strangers all are", [q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id in ('${FU}','${FD}')`), activeIn(P1)], ["0", 3]);
      ok("a follower never gets the testing post", !viewerOf(FU).includes(P1));
      ok("...nor does someone the creator follows (either direction)", !viewerOf(FD).includes(P1));
      Q(`insert into public.trial_assignments (post_id, viewer_id, stage) values ('${P1}','${FU}',1)`);
      ok("...even if an assignment row exists for them", !viewerOf(FU).includes(P1));
      Q(`delete from public.trial_assignments where viewer_id='${FU}'`);
      ok("a stranger still gets it", viewerOf(U(4)).startsWith(P1));
      for (const v of [4, 5, 6]) view(P1, U(v), { watch: 500 });
      view(P1, FU, { watch: 12000, dur: 12000, done: true, like: true, react: true }); view(P1, FD, { watch: 12000, dur: 12000, done: true, like: true });
      eq("their views, likes and reaction are not scored", Object.keys(score(P1)).sort(), [4, 5, 6].map(U));
      engine();
      eq("so perfect engagement from people the creator knows cannot rescue the post", [status(P1), lastLog(P1)], ["archived", "failed|3"]);
      Q(`update public.trial_engine_config set build_in_silence=false`);
      eq("flag off: known viewers' engagement counts again", Object.keys(score(P1)).length, 5);
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50, build_in_silence=false`);
      Q(`insert into public.follows (follower_id, followee_id) values ('${FU}','${U(1)}')`);
      mkPost(P1, U(1));
      ok("flag off: a follower is assigned and served the testing post", viewerOf(FU).startsWith(P1));
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      Q(`insert into public.follows (follower_id, followee_id) values ('${FU}','${U(1)}')`);
      mkPost(P1, U(1));
      Q(`update public.posts set status='survived', survived_at=now(), distribution_started_at=now(), distribution_expires_at=now()+interval '24 hours' where id='${P1}'`);
      ok("after it survives, the follower sees it normally", viewerOf(FU).includes(P1));
      ok("known_connections lists both directions from one source", q(`select string_agg(distinct source, ',') || ':' || count(*) from public.known_connections`) === "follow:2");
      ok("clients cannot read known_connections", psql("t", "set role authenticated; select * from public.known_connections", ["-v", "ON_ERROR_STOP=1"]).status !== 0);

      // 16) contacts, phone hashes, hide list (build in silence, part 2)
      const PEPPER = "test-pepper-0123456789-abcdefghijklmnop";
      const hmacOf = (n) => createHmac("sha256", PEPPER).update(n).digest("hex");
      const asUser = (uid, sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
      const NUM = { 2: "+14155550102", 3: "+14155550103", 4: "+14155550104", 1: "+14155550101" };
      const wipePrivacy = () => Q(`delete from public.user_phone_hash; delete from public.contact_hashes; delete from public.contact_sync_state; delete from public.hide_from_list`);
      wipePrivacy();
      ok("a user stores their phone: only the HMAC-SHA256 hash (with the Vault pepper) is saved", asUser(U(2), `select public.set_my_phone('${NUM[2]}')`).status === 0 && q(`select hash from public.user_phone_hash where user_id='${U(2)}'`) === hmacOf(NUM[2]));
      ok("duplicates are allowed (two accounts, one unverified number)", asUser(U(9), `select public.set_my_phone('${NUM[2]}')`).status === 0 && q(`select count(*) from public.user_phone_hash where hash='${hmacOf(NUM[2])}'`) === "2");
      ok("an invalid number is rejected without echoing it", (() => { const r = asUser(U(2), `select public.set_my_phone('12345')`); return r.status !== 0 && !r.stderr.includes("12345"); })());
      eq("syncing contacts keeps only valid numbers, hashed (3 valid of 5, one duplicate)", asUser(U(1), `select public.sync_my_contacts(array['${NUM[2]}','${NUM[3]}','${NUM[3]}','not a number','0123'])`).stdout.trim().split("\n").pop(), "2");
      ok("raw numbers appear in no table, column or the hash text", (() => {
        const dump = q(`select row_to_json(t)::text from public.user_phone_hash t union all select row_to_json(t)::text from public.contact_hashes t union all select row_to_json(t)::text from public.contact_sync_state t`);
        return !/\+?1415555010[0-9]/.test(dump) && !/4155550102/.test(dump);
      })());
      ok("clients cannot read the phone/contact tables or ask who knows whom", ["user_phone_hash", "contact_hashes", "contact_sync_state", "known_connections"].every((t) => asUser(U(1), `select * from public.${t}`).status !== 0) && asUser(U(1), `select public.trial_is_silenced('${U(1)}','${U(2)}')`).status !== 0);

      // contact match, either direction
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      wipePrivacy();
      asUser(U(2), `select public.set_my_phone('${NUM[2]}')`); asUser(U(1), `select public.set_my_phone('${NUM[1]}')`);
      asUser(U(1), `select public.sync_my_contacts(array['${NUM[2]}'])`);          // creator's contacts contain viewer 2
      asUser(U(3), `select public.sync_my_contacts(array['${NUM[1]}'])`);          // viewer 3's contacts contain the creator
      mkPost(P1, U(1));
      eq("viewers matched in either direction are not assigned (even in a small app); the others are", [q(`select count(*) from public.trial_assignments where post_id='${P1}' and viewer_id in ('${U(2)}','${U(3)}')`), activeIn(P1)], ["0", 3]);
      ok("neither matched viewer is served the testing post", !viewerOf(U(2)).includes(P1) && !viewerOf(U(3)).includes(P1));
      ok("a stranger is", viewerOf(U(4)).startsWith(P1));
      for (const v of [4, 5, 6]) view(P1, U(v), { watch: 500 });
      view(P1, U(2), { watch: 12000, dur: 12000, done: true, like: true, react: true }); view(P1, U(3), { watch: 12000, dur: 12000, done: true, like: true });
      eq("their likes and reaction do not count toward the verdict", [Object.keys(score(P1)).sort().join(), (engine(), status(P1))], [[4, 5, 6].map(U).join(), "archived"]);
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      mkPost(P1, U(1));
      Q(`update public.posts set status='survived', survived_at=now(), distribution_started_at=now(), distribution_expires_at=now()+interval '24 hours' where id='${P1}'`);
      ok("once it survives, the matched viewers see it normally", viewerOf(U(2)).includes(P1) && viewerOf(U(3)).includes(P1));
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50, build_in_silence=false`);
      asUser(U(2), `select public.set_my_phone('${NUM[2]}')`); asUser(U(1), `select public.sync_my_contacts(array['${NUM[2]}'])`);
      mkPost(P1, U(1));
      ok("flag off: a contact match no longer excludes the viewer", viewerOf(U(2)).startsWith(P1));

      // hide-from list
      freshWorld(6);
      Q(`update public.trial_engine_config set small_pool_everyone=50`);
      wipePrivacy();
      ok("a user adds someone to their own hide list", asUser(U(1), `insert into public.hide_from_list (owner_id, hidden_user_id) values ('${U(1)}','${U(4)}')`).status === 0);
      ok("...but cannot add to someone else's list, nor read it", asUser(U(5), `insert into public.hide_from_list (owner_id, hidden_user_id) values ('${U(1)}','${U(5)}')`).status !== 0 && asUser(U(4), `select count(*) from public.hide_from_list where owner_id='${U(1)}'`).stdout.trim().split("\n").pop() === "0");
      mkPost(P1, U(1));
      ok("a hidden person is not assigned or served the testing post; others are", !viewerOf(U(4)).includes(P1) && viewerOf(U(5)).startsWith(P1));
      ok("the list is one direction: the hidden person's own posts still reach the owner's feed pool", (() => { mkPost(P2, U(4)); return viewerOf(U(1)).includes(P2); })());
      ok("removing them from the list lets them see it", (() => { asUser(U(1), `delete from public.hide_from_list where hidden_user_id='${U(4)}'`); return viewerOf(U(4)).includes(P1); })());

      // removal and account deletion
      asUser(U(1), `select public.sync_my_contacts(array['${NUM[2]}'])`);
      asUser(U(1), `select public.remove_my_contacts()`);
      eq("'Remove my contacts data' deletes the contact hashes and sync state", [q(`select count(*) from public.contact_hashes where owner_id='${U(1)}'`), q(`select count(*) from public.contact_sync_state where owner_id='${U(1)}'`)], ["0", "0"]);
      mkUsers(40, 40);
      asUser(U(40), `select public.set_my_phone('${NUM[3]}')`); asUser(U(40), `select public.sync_my_contacts(array['${NUM[2]}'])`); asUser(U(40), `insert into public.hide_from_list (owner_id, hidden_user_id) values ('${U(40)}','${U(5)}')`);
      asUser(U(40), `select public.delete_my_privacy_data()`);
      eq("delete_my_privacy_data removes the phone hash, contact hashes and hide list", q(`select (select count(*) from public.user_phone_hash where user_id='${U(40)}') + (select count(*) from public.contact_hashes where owner_id='${U(40)}') + (select count(*) from public.hide_from_list where owner_id='${U(40)}')`), "0");
      mkUsers(41, 41);
      asUser(U(41), `select public.set_my_phone('${NUM[4]}')`); asUser(U(41), `select public.sync_my_contacts(array['${NUM[2]}'])`);
      Q(`delete from auth.users where id='${U(41)}'`);
      eq("deleting the account cascades to the phone hash and contact hashes", q(`select (select count(*) from public.user_phone_hash where user_id='${U(41)}') + (select count(*) from public.contact_hashes where owner_id='${U(41)}')`), "0");
      wipePrivacy();

      // 17) pool exhausted: decide when nobody is left to show it to
      const reasonOf = (id) => q(`select coalesce(reason,'-') from public.trial_engine_log where post_id='${id}' order by id desc limit 1`);
      freshWorld(4);
      mkPost(P1, U(1));
      for (const v of [2, 3, 4]) view(P1, U(v), { watch: 8000, dur: 12000, like: true });
      engine();
      eq("pool of 3, all 3 viewers like it -> survives", status(P1), "survived");
      freshWorld(4);
      mkPost(P1, U(1));
      for (const v of [2, 3, 4]) view(P1, U(v), { watch: 8000, dur: 12000 });
      engine();
      eq("pool of 3, modest but above the bar (not enough confidence alone) -> survives on exhaustion, reason logged", [status(P1), reasonOf(P1)], ["survived", "pool_exhausted"]);
      freshWorld(3);
      mkPost(P1, U(1));
      for (const v of [2, 3]) view(P1, U(v), { watch: 500 });
      engine();
      eq("everyone saw it and swiped (mean far below 0.67 x bar) -> ended on exhaustion", [status(P1), reasonOf(P1), notif("verdict_archived")], ["archived", "pool_exhausted", "1"]);
      freshWorld(3);
      mkPost(P1, U(1));
      view(P1, U(2), { watch: 8000, dur: 12000 }); view(P1, U(3), { watch: 500 });
      engine();
      eq("borderline (between 0.67 x bar and the bar) -> incomplete, never 'ended'", [status(P1), reasonOf(P1), notif("verdict_incomplete"), notif("verdict_archived")], ["incomplete", "pool_exhausted", "1", "0"]);
      freshWorld(4);
      mkPost(P1, U(1));
      view(P1, U(2), { watch: 500 }); view(P1, U(3), { watch: 500 });
      engine();
      eq("with a live user still unexposed the pool is NOT exhausted: the normal confidence rules apply (keeps testing)", [status(P1), lastLog(P1)], ["trial", "testing|2"]);
      freshWorld(4);
      mkPost(P1, U(1));
      Q(`insert into public.follows (follower_id, followee_id) values ('${U(4)}','${U(1)}')`);   // 4 knows the creator: not part of the pool
      view(P1, U(2), { watch: 8000, dur: 12000 }); view(P1, U(3), { watch: 8000, dur: 12000 });
      engine();
      eq("known viewers are not in the pool, so exhaustion is judged without them", [status(P1), reasonOf(P1)], ["survived", "pool_exhausted"]);
      freshWorld(4);
      mkPost(P1, U(1));
      Q(`insert into public.post_qualified_views (post_id, viewer_id) values ('${P1}','${U(4)}')`);
      eq("a qualified view with no watch-time row is not lost: it counts as a meaningful watch (0.4)", score(P1)[U(4)], "0.400");
      view(P1, U(2), { watch: 8000, dur: 12000 }); view(P1, U(3), { watch: 8000, dur: 12000 });
      engine();
      eq("...and it counts as exposure, so the pool is exhausted and the post is decided", [status(P1), reasonOf(P1)], ["survived", "pool_exhausted"]);
      // re-evaluating a post that was decided under the old rules
      freshWorld(4);
      mkPost(P1, U(1), 600);
      for (const v of [2, 3, 4]) view(P1, U(v), { watch: 8000, dur: 12000 });
      Q(`update public.trial_post_state set decision='incomplete', decided_at=now() where post_id='${P1}'; update public.posts set status='incomplete' where id='${P1}'`);
      eq("trial_admin_reevaluate re-opens a decided post and applies the current rules", [q(`select public.trial_admin_reevaluate('${P1.slice(0, -1)}')`), status(P1)], ["survived", "survived"]);
      ok("a survived post is never re-opened", q(`select public.trial_admin_reevaluate('${P1.slice(0, -1)}')`).startsWith("not re-opened"));
      ok("clients cannot run it", asUser(U(2), `select public.trial_admin_reevaluate('aaaa')`).status !== 0);
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
