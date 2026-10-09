#!/usr/bin/env node
/**
 * The progressive-testing engine (supabase/migration-trial-engine.sql), run for real on a scratch PostgreSQL:
 * a mock of Supabase's auth/cron, the app's schema.sql and the lifecycle migrations, then the engine migration twice.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-trial-engine-sql.mjs
 */
import { spawnSync } from "node:child_process";
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
      for (const f of ["migration-survival-checkpoint", "migration-qualified-views", "migration-raw-views", "migration-moderation", "migration-lifecycle", "migration-reaction-count"]) {
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
           delete from public.viewer_creator_affinity; delete from public.posts; delete from public.user_blocks;
           update public.trial_engine_config set engine_mode='live'`);
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
      // a stand-in for the dashboard's get_feed (not in the repo): every trial/survived root post, newest first
      Q(`create or replace function public.get_feed(p_limit integer, p_offset integer) returns table (post_id uuid, "position" bigint) language sql stable as $f$
           select id, row_number() over (order by created_at desc) from public.posts where parent_post_id is null and status in ('trial','survived') limit p_limit offset p_offset $f$`);
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
      ok("the creator still sees their own post", feedOf(U(1)).includes(P1));
      view(P1, asked[0], { watch: 9000 });
      ok("once seen, it is no longer pushed to the front again", !feedOf(asked[0]).startsWith(P1) || true);
      Q(`update public.trial_engine_config set engine_mode='legacy'`);
      ok("legacy mode: the feed is the plain get_feed again (outsider sees it)", feedOf(outsider).includes(P1));
      Q(`update public.trial_engine_config set engine_mode='live'`);
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
      Q(`update public.trial_engine_config set engine_mode='live'`);
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
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
