#!/usr/bin/env node
/**
 * POST LINKS (supabase/migration-post-links.sql): the video link on a post, the tracked short link's database side, tap counting with the 24-hour
 * de-duplication, the 48-hour purge, privacy. Standalone: it needs only the base schema, so it can ship before Money. Same scratch-PostgreSQL
 * harness as test-money-sql.mjs.
 *   node --experimental-strip-types --no-warnings scripts/test-post-links-sql.mjs
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
import { BAD, GOOD } from "./post-link-cases.mjs";
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


      const pl = join(sqlDir, "migration-post-links.sql");
      const l1 = psqlFile("t", pl), l2 = psqlFile("t", pl);
      if (/ERROR/.test(l1.stderr + l2.stderr)) console.log((l1.stderr + l2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n"));
      eq("the post-links migration applies cleanly, and again (idempotent)", [/ERROR/.test(l1.stderr), /ERROR/.test(l2.stderr)], [false, false]);
      eq("(0) the hourly purge is scheduled once", q("select count(*) from cron.job where jobname = 'link-taps-purge'"), "1");

      const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const asUser = (uid, sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
      const as = (uid, sql) => { const r = asUser(uid, sql); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const svc = (sql) => { const r = psql("t", `set role service_role; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const anon = (sql) => { const r = psql("t", `set role anon; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim() }; };
      const mkUser = (n) => Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(n)}','{"username":"u${n}"}','u${n}@example.test') on conflict do nothing; update public.profiles set birthdate='1990-01-01' where id='${U(n)}'`);
      const P = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
      for (const n of [1, 2, 3]) mkUser(n);
      const mkPost = (n, user, parent = null) => Q(`insert into public.posts (id, user_id, media_url, media_type${parent ? ", parent_post_id" : ""}) values ('${P(n)}','${U(user)}','u','video'${parent ? `,'${P(parent)}'` : ""})`);
      mkPost(1, 1); mkPost(2, 1, 1); mkPost(3, 2);

      // ── A. which addresses are allowed ──
      const plat = (u) => q(`select coalesce(public.link_platform_of('${u.replace(/'/g, "''")}'), 'null')`);
      for (const [u, p] of GOOD) eq(`(A) allowed: ${u.trim()} -> ${p}`, plat(u), p);
      for (const u of BAD) eq(`(A) refused: ${u.slice(0, 40)}${u.length > 40 ? "…" : ""}`, plat(u), "null");

      // ── B. add, change, clear: only the owner, only on a post (not a reaction) ──
      const set = (uid, post, url) => as(U(uid), `select public.set_post_video_link('${P(post)}', '${url}')`);
      const r1 = set(1, 1, "https://www.youtube.com/watch?v=abc");
      eq("(B) the owner adds a video link: a 10-character code comes back", [r1.ok, /^[0-9a-f]{10}$/.test(r1.out)], [true, true]);
      eq("(B) the post carries the code and the platform; post_links holds the address", [q(`select link_code || ':' || link_platform from public.posts where id = '${P(1)}'`) === `${r1.out}:youtube`, q(`select url from public.post_links where post_id = '${P(1)}'`)], [true, "https://www.youtube.com/watch?v=abc"]);
      const r2 = set(1, 1, "https://youtu.be/xyz");
      eq("(B) changing the address keeps the same code (a shared short link keeps working)", [r2.out === r1.out, q(`select url from public.post_links where post_id = '${P(1)}'`), q(`select count(*) from public.post_links`)], [true, "https://youtu.be/xyz", "1"]);
      const r3 = set(1, 1, "https://www.tiktok.com/@a/video/1");
      eq("(B) switching platform updates the platform", q(`select link_platform from public.posts where id = '${P(1)}'`), "tiktok");
      eq("(B) another person cannot add a link to my post, a reaction cannot carry one, an invalid address is refused, and a missing post fails", [set(3, 1, "https://youtu.be/x").ok, set(1, 2, "https://youtu.be/x").ok, set(1, 1, "https://evil.com/x").ok, as(U(1), `select public.set_post_video_link('${P(99)}', 'https://youtu.be/x')`).ok], [false, false, false, false]);
      eq("(B) the refused ones changed nothing", [q(`select link_platform from public.posts where id = '${P(1)}'`), q(`select count(*) from public.post_links`)], ["tiktok", "1"]);
      eq("(B) the error for a bad address is plain", set(1, 1, "https://evil.com/x").err.includes("that link is not allowed"), true);
      eq("(B) two posts get different codes", [(() => { const c = set(2, 3, "https://open.spotify.com/episode/abc"); return [c.ok, c.out !== r1.out, /^[0-9a-f]{10}$/.test(c.out)]; })()][0], [true, true, true]);
      eq("(B) the owner clears it: the columns and the address go", [as(U(2), `select public.clear_post_video_link('${P(3)}')`).ok, q(`select (link_code is null)::text || ':' || (link_platform is null)::text from public.posts where id = '${P(3)}'`), q(`select count(*) from public.post_links where post_id = '${P(3)}'`)], [true, "true:true", "0"]);
      eq("(B) only the owner can clear, and not signed out", [as(U(3), `select public.clear_post_video_link('${P(1)}')`).ok, anon(`select public.set_post_video_link('${P(1)}', 'https://youtu.be/x')`).ok], [false, false]);

      // ── C. apps cannot write the columns around the functions ──
      // (apps have no UPDATE grant on posts at all; the trigger is the second wall, tested here as a signed-in user with full table rights)
      const su = (uid, sql) => { const r = psql("t", `set request.jwt.claim.sub='${U(uid)}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      eq("(C) a direct update of link_code / link_platform by the owner is refused", [su(1, `update public.posts set link_code = 'abcdef0123' where id = '${P(1)}'`).ok, su(1, `update public.posts set link_platform = 'youtube' where id = '${P(1)}'`).ok, as(U(1), `update public.posts set link_code = 'abcdef0123' where id = '${P(1)}'`).ok], [false, false, false]);
      eq("(C) a post cannot be created already carrying a link", as(U(1), `insert into public.posts (id, user_id, media_url, media_type, link_code, link_platform) values ('${P(50)}','${U(1)}','u','video','abcdef0123','youtube')`).ok, false);
      eq("(C) an ordinary post and an ordinary edit are untouched", [as(U(1), `insert into public.posts (id, user_id, media_url, media_type) values ('${P(51)}','${U(1)}','u','video')`).ok, su(1, `update public.posts set caption = 'hello' where id = '${P(51)}'`).ok], [true, true]);
      eq("(C) the SQL editor (no signed-in user) may still correct a link", (() => { Q(`update public.posts set link_platform = 'tiktok' where id = '${P(1)}'`); return q(`select link_platform from public.posts where id = '${P(1)}'`); })(), "tiktok");

      // ── D. who sees what ──
      const code1 = r1.out;
      eq("(D) anyone signed in can read the platform and code of a post (that is how the button works)", [as(U(3), `select link_code from public.posts where id = '${P(1)}'`).out, as(U(3), `select link_platform from public.posts where id = '${P(1)}'`).out], [code1, "tiktok"]);
      eq("(D) the address is the owner's alone: the owner reads it, nobody else does, not even with a direct query", [as(U(1), `select count(*) from public.post_links`).out, as(U(3), `select count(*) from public.post_links`).out, anon(`select count(*) from public.post_links`).ok], ["1", "0", false]);
      eq("(D) apps cannot write or read the tap tables, and cannot call the two edge-function functions or the purge", [as(U(1), `select count(*) from public.post_link_tap_days`).ok, as(U(1), `select count(*) from public.link_tap_seen`).ok, as(U(1), `insert into public.post_links (post_id, url, platform, code) values ('${P(3)}', 'https://youtu.be/x', 'youtube', 'zzzzzzzzzz')`).ok, as(U(1), `select public.link_target('${code1}')`).ok, as(U(1), `select public.record_link_tap('${code1}', 'aaaaaaaaaaaaaaaaaaaa')`).ok, as(U(1), `select public.link_taps_purge()`).ok, anon(`select public.link_target('${code1}')`).ok, as(U(1), `select * from public.link_taps_weekly`).ok], Array(8).fill(false));
      eq("(D) the service role reads the address behind a code", svc(`select url from public.link_target('${code1}')`).out, "https://youtu.be/xyz".replace("xyz", "xyz") === "" ? "" : q(`select url from public.post_links where code = '${code1}'`));
      eq("(D) an unknown code gives nothing", svc(`select count(*) from public.link_target('0000000000')`).out, "0");

      // ── E. a hidden, removed or deleted post's link stops working ──
      eq("(E) hidden / removed post: link_target gives nothing; active again: works; deleted: gone with the post", (() => {
        Q(`update public.posts set moderation_status = 'hidden' where id = '${P(1)}'`); const a = svc(`select count(*) from public.link_target('${code1}')`).out;
        Q(`update public.posts set moderation_status = 'removed' where id = '${P(1)}'`); const b = svc(`select count(*) from public.link_target('${code1}')`).out;
        Q(`update public.posts set moderation_status = 'active' where id = '${P(1)}'`); const c = svc(`select count(*) from public.link_target('${code1}')`).out;
        mkPost(60, 1); const c60 = set(1, 60, "https://x.com/a/status/1").out; Q(`delete from public.posts where id = '${P(60)}'`); const d = svc(`select count(*) from public.link_target('${c60}')`).out;
        return [a, b, c, d, q(`select count(*) from public.post_links where code = '${c60}'`)];
      })(), ["0", "0", "1", "0", "0"]);

      // ── F. counting taps: once per device per 24 hours ──
      const FP1 = "a".repeat(32), FP2 = "b".repeat(32);
      const tap = (code, fp) => svc(`select public.record_link_tap('${code}', '${fp}')`).out;
      const taps = () => as(U(1), `select public.my_post_link_taps('${P(1)}')`).out;
      eq("(F) the first tap counts; the same device again does not; another device does", [tap(code1, FP1), tap(code1, FP1), tap(code1, FP2), tap(code1, FP2), taps()], ["t", "f", "t", "f", "2"]);
      eq("(F) after 24 hours the same device counts again (once)", (() => { Q(`update public.link_tap_seen set seen_at = now() - interval '25 hours' where fp = '${FP1}'`); const a = tap(code1, FP1), b = tap(code1, FP1); return [a, b, taps()]; })(), ["t", "f", "3"]);
      eq("(F) 23 hours is not enough", (() => { Q(`update public.link_tap_seen set seen_at = now() - interval '23 hours' where fp = '${FP2}'`); return [tap(code1, FP2), taps()]; })(), ["f", "3"]);
      eq("(F) a bad code or a bad fingerprint counts nothing", [tap("0000000000", FP1), tap(code1, "short"), tap(code1, "x".repeat(65)), svc(`select public.record_link_tap('${code1}', null)`).out, taps()], ["f", "f", "f", "f", "3"]);
      eq("(F) the same fingerprint on a different post's link counts there (the key is per link)", (() => { const c = set(2, 3, "https://open.spotify.com/episode/abc").out; return [tap(c, FP1), as(U(2), `select public.my_post_link_taps('${P(3)}')`).out]; })(), ["t", "1"]);
      eq("(F) counts are per day, in UTC", (() => { Q(`update public.post_link_tap_days set day = day - 1 where post_id = '${P(1)}'`); tap(code1, "c".repeat(32)); return q(`select count(*) from public.post_link_tap_days where post_id = '${P(1)}'`) + ":" + taps(); })(), "2:4");
      eq("(F) the owner sees their total; another person gets 0; signed-out cannot ask", [as(U(1), `select public.my_post_link_taps('${P(1)}')`).out, as(U(3), `select public.my_post_link_taps('${P(1)}')`).out, anon(`select public.my_post_link_taps('${P(1)}')`).ok], ["4", "0", false]);
      eq("(F) clearing the link keeps the counts (the post's history does not vanish)", (() => { const keep = taps(); as(U(1), `select public.clear_post_video_link('${P(1)}')`); return [keep, taps(), q(`select count(*) from public.post_link_tap_days where post_id = '${P(1)}'`)]; })(), ["4", "4", "2"]);
      eq("(F) after clearing, the old code no longer redirects and counts nothing", [svc(`select count(*) from public.link_target('${code1}')`).out, tap(code1, "d".repeat(32)), taps()], ["0", "f", "4"]);

      // ── F2. the hourly cap: a script with many addresses still cannot push one link's count past it ──
      eq("(F2) the default cap is 120 counted taps per link per hour, kept in a closed one-row config table", [q("select max_per_hour from public.link_tap_config"), q("select count(*) from public.link_tap_config"), as(U(1), `select * from public.link_tap_config`).ok, as(U(1), `update public.link_tap_config set max_per_hour = 100000`).ok, psql("t", "update public.link_tap_config set max_per_hour = 0", ["-v", "ON_ERROR_STOP=1"]).status === 0], ["120", "1", false, false, false]);
      Q(`update public.link_tap_config set max_per_hour = 5`);
      mkPost(70, 1); mkPost(71, 1);
      const cA = set(1, 70, "https://youtu.be/a").out, cB = set(1, 71, "https://youtu.be/b").out;
      const fpn = (n) => String(n).padStart(2, "0").repeat(16);
      eq("(F2) five different devices count; the sixth, seventh... do not, however many arrive", [1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => tap(cA, fpn(n))), ["t", "t", "t", "t", "t", "f", "f", "f", "f"]);
      eq("(F2) the total is the cap, and refused taps left nothing behind (no hash rows past the cap)", [as(U(1), `select public.my_post_link_taps('${P(70)}')`).out, q(`select count(*) from public.link_tap_seen where code = '${cA}'`)], ["5", "5"]);
      eq("(F2) a device already counted does not use up the cap again, and another link has its own allowance", [tap(cA, fpn(1)), tap(cB, fpn(1)), tap(cB, fpn(2)), as(U(1), `select public.my_post_link_taps('${P(71)}')`).out], ["f", "t", "t", "2"]);
      eq("(F2) after the hour passes the link counts again (new devices), up to the cap again", (() => { Q(`update public.link_tap_seen set seen_at = now() - interval '61 minutes' where code = '${cA}'`); return [60, 61, 62, 63, 64, 65, 66].map((n) => tap(cA, fpn(n))); })(), ["t", "t", "t", "t", "t", "f", "f"]);
      eq("(F2) the cap is the hourly COUNT of counted taps: 4 counted 30 minutes ago and 4 counted 90 minutes ago leave room for 1 only", (() => { const c = set(1, 70, "https://youtu.be/a").out; Q(`delete from public.link_tap_seen where code = '${c}'`); for (const n of [71, 72, 73, 74]) tap(c, fpn(n)); Q(`update public.link_tap_seen set seen_at = now() - interval '30 minutes' where code = '${c}'`); for (const n of [75, 76, 77, 78]) tap(c, fpn(n)); Q(`update public.link_tap_seen set seen_at = now() - interval '90 minutes' where code = '${c}' and fp in ('${fpn(75)}','${fpn(76)}','${fpn(77)}','${fpn(78)}')`); return [tap(c, fpn(79)), tap(c, fpn(80))]; })(), ["t", "f"]);
      eq("(F2) the owner can raise the cap in the SQL editor and counting resumes at once", (() => { Q(`update public.link_tap_config set max_per_hour = 500`); return [tap(cA, fpn(90)), tap(cA, fpn(91))]; })(), ["t", "t"]);
      Q(`update public.link_tap_config set max_per_hour = 120`);

      // ── G. the 48-hour purge ──
      eq("(G) the purge removes hashes older than 48 hours and keeps newer ones, and never touches the counts", (() => {
        const code = set(1, 1, "https://youtu.be/q").out;
        tap(code, "e".repeat(32)); tap(code, "f".repeat(32));
        Q(`update public.link_tap_seen set seen_at = now() - interval '49 hours' where fp = '${"e".repeat(32)}'; update public.link_tap_seen set seen_at = now() - interval '47 hours' where fp = '${"f".repeat(32)}'`);
        const n = svc(`select public.link_taps_purge()`).out;
        const left = q(`select string_agg(left(fp, 1), ',' order by fp) from public.link_tap_seen where code = '${code}'`);
        return [n >= "1", left, taps() >= "4"];
      })(), [true, "f", true]);

      // ── H. nothing about the person is kept; weekly counts for the pitch ──
      eq("(H) the tables hold only what is needed: no address, device, user or time-of-day columns beyond seen_at", [q(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'link_tap_seen'`), q(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'post_link_tap_days'`)], ["code,fp,seen_at", "post_id,day,taps"]);
      eq("(H) no column anywhere in these tables is named ip, user_agent, device, user_id or viewer", q(`select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('link_tap_seen', 'post_link_tap_days', 'post_links') and column_name ~ '(^ip|user_agent|device|user_id|viewer|ua$)'`), "0");
      eq("(H) the weekly view sums taps per Monday-start week (closed to apps)", (() => { const r = q(`select taps || ':' || posts_with_taps from public.link_taps_weekly order by week_start desc limit 1`); return [/^\d+:\d+$/.test(r), q(`select (week_start = date_trunc('week', week_start::timestamp)::date)::text from public.link_taps_weekly order by week_start desc limit 1`)]; })(), [true, "true"]);
      eq("(H) re-applying the migration keeps the links, the counts and the guard", (() => { const before = [q("select count(*) from public.post_links"), q("select sum(taps) from public.post_link_tap_days")]; const r = psqlFile("t", pl); return [/ERROR/.test(r.stderr), q("select count(*) from public.post_links"), q("select sum(taps) from public.post_link_tap_days"), su(1, `update public.posts set link_code = 'abcdef0123' where id = '${P(1)}'`).ok].concat(before); })(), [false, q("select count(*) from public.post_links"), q("select sum(taps) from public.post_link_tap_days"), false, q("select count(*) from public.post_links"), q("select sum(taps) from public.post_link_tap_days")]);

      }
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
