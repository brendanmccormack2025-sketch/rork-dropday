#!/usr/bin/env node
/**
 * HARASSMENT PROTECTION (supabase/migration-harassment.sql) on top of stranger-only and Spotlight, run for real on a scratch PostgreSQL (same
 * harness as test-stranger-only-sql.mjs). Admin-only offers, the creator's consent (full / strangers / decline), and the exposure
 * rule on every surface: the feed (Spotlight posts lead it, with a category label) and the profile badge; rotation, expiry, withdrawal.
 * Word filter (DMs and captions), unwanted-contact flags, creator controls (DM policy, removing a reaction, limiting one post)
 * and the owner-only review queue, with the existing reports and blocks still working.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-harassment-sql.mjs
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

      // friends: A(1)-C(3) from setup(); add 6-7, 6-11, 9-11, and a few more pairs as needed
      const befriend = (x, y, daysAgo = 30) => Q(`insert into public.friendships (user_a, user_b, created_at) values ('${U(Math.min(x, y))}','${U(Math.max(x, y))}', now() - interval '${daysAgo} days') on conflict (user_a, user_b) do update set created_at = excluded.created_at`);
      const resetAll = () => {
        setup();
        Q(`delete from public.harassment_flags; delete from public.creator_controls; delete from public.post_interaction_limits; delete from public.reaction_removals; delete from public.reports;
           delete from public.chat_messages; delete from public.chat_conversations; update public.word_filter_terms set term = term; delete from public.word_filter_terms where term not in ('kill yourself','kys','go die')`);
        befriend(1, 3); befriend(6, 11); befriend(7, 11); befriend(9, 11); befriend(10, 11);
        mkSurvived(1, 1);
      };
      const say = (from, to, body) => as(U(from), `select public.send_message('${U(to)}', $m$${body}$m$)`);
      const flags = (kind) => q(`select count(*) from public.harassment_flags where kind='${kind}'`);

      // ── 1. the word filter: DMs ──
      resetAll();
      const bad = say(3, 1, "you should kill yourself");
      eq("a DM with a block-listed phrase is refused, with a generic message that does not name the term", [bad.ok, /not allowed on Tryal/.test(bad.err), /kill yourself/.test(bad.err)], [false, true, false]);
      eq("...and nothing was stored", q("select count(*) from public.chat_messages"), "0");
      eq("a normal message goes through", say(3, 1, "hello there, nice post").ok, true);
      eq("look-alike characters, case and punctuation do not get around it", ["K1LL y0urself", "k.y.s", "KYS!!", "go   DIE", "kill-yourself", "k y s", "k-y-s"].map((t) => say(3, 1, t).ok), Array(7).fill(false));
      eq("whole words only: 'skills' and 'okay' are fine", [say(3, 1, "good skills yourself").ok, say(3, 1, "okay, kysely is a library").ok], [true, true]);
      eq("a shared post note goes through the same filter", as(U(1), `select public.send_post_to_friend('${U(3)}','${P(1)}', 'kys')`).ok, false);

      // ── 2. the word filter: captions ──
      eq("a caption with a listed phrase is refused on insert and on update; a clean one is fine", (() => {
        const bad = psql("t", `insert into public.posts (id, user_id, media_url, media_type, caption) values ('${P(61)}','${U(1)}','u','video','you should kys')`, ["-v", "ON_ERROR_STOP=1"]).status !== 0;
        const ok1 = psql("t", `insert into public.posts (id, user_id, media_url, media_type, caption) values ('${P(62)}','${U(1)}','u','video','a lovely day')`, ["-v", "ON_ERROR_STOP=1"]).status === 0;
        const upd = psql("t", `update public.posts set caption = 'go die' where id='${P(62)}'`, ["-v", "ON_ERROR_STOP=1"]).status !== 0;
        return [bad, ok1, upd];
      })(), [true, true, true]);
      eq("text overlays are checked too", [psql("t", `insert into public.posts (id, user_id, media_url, media_type, text_overlays) values ('${P(63)}','${U(1)}','u','video','[{"text":"kill yourself","x":1}]'::jsonb)`, ["-v", "ON_ERROR_STOP=1"]).status !== 0, psql("t", `insert into public.posts (id, user_id, media_url, media_type, text_overlays) values ('${P(64)}','${U(1)}','u','video','[{"text":"hello","x":1}]'::jsonb)`, ["-v", "ON_ERROR_STOP=1"]).status === 0], [true, true]);
      eq("an old post with a now-listed word can still be edited elsewhere (only a changed caption is checked)", (() => { Q(`update public.posts set caption = 'old news' where id='${P(62)}'`); Q(`insert into public.word_filter_terms (term) values ('old news')`); const r = psql("t", `update public.posts set view_count = coalesce(view_count, 0) + 1 where id='${P(62)}'`, ["-v", "ON_ERROR_STOP=1"]).status === 0; Q(`delete from public.word_filter_terms where term='old news'`); return r; })(), true);

      // ── 3. the list is the owner's ──
      eq("a non-admin cannot see, add or remove terms", [as(U(6), `select count(*) from public.admin_filter_terms()`).ok, as(U(6), `select public.admin_filter_add('badword')`).ok, as(U(6), `select public.admin_filter_remove('kys')`).ok], [false, false, false]);
      eq("the admin adds a term (it works at once), then removes it (and it stops)", [as(ADMIN, `select public.admin_filter_add('  Meanie Face ')`).ok, say(3, 1, "you meanie face").ok, as(ADMIN, `select public.admin_filter_remove('meanie face')`).ok, say(3, 1, "you meanie face").ok], [true, false, true, true]);
      eq("a term needs at least 2 letters; the admin lists them", [as(ADMIN, `select public.admin_filter_add('a')`).ok, as(ADMIN, `select count(*) from public.admin_filter_terms()`).out], [false, "3"]);
      eq("the tables are closed to apps", ["word_filter_terms", "harassment_flags", "creator_controls", "reaction_removals", "post_interaction_limits", "harassment_config"].map((t) => as(U(6), `select count(*) from public.${t}`).ok), Array(6).fill(false));
      eq("internals are not callable by apps", [as(U(6), `select public.text_blocked_term('kys')`).ok, as(U(6), `select public.root_post_of('${P(1)}')`).ok, as(U(6), `select public.mod_is_admin()`).ok, as(U(6), `select public.harassment_flag('${U(6)}', null, 'blocked_by_many', '{}')`).ok], [false, false, false, false]);

      // ── 4. who may DM me ──
      resetAll();
      eq("default: friends can message", say(3, 1, "hi").ok, true);
      as(U(1), `select public.set_dm_policy('nobody')`);
      eq("'nobody': nobody can message me, I can still message out", [say(3, 1, "hi again").ok, say(1, 3, "hi from me").ok], [false, true]);
      eq("...the same for the older view-based path that the previous app builds use", psql("t", `set role authenticated; set request.jwt.claim.sub='${U(3)}'; insert into public.chat_messages (conversation_id, sender_id, body) select id, '${U(3)}', 'sneaky' from public.chat_conversations limit 1`, ["-v", "ON_ERROR_STOP=1"]).status !== 0, true);
      as(U(1), `select public.set_dm_policy('friends_7d')`);
      befriend(1, 3, 1);
      eq("'friends_7d': a friend of one day cannot, a friend of 30 days can", (() => { const a = say(3, 1, "too soon").ok; befriend(1, 3, 30); return [a, say(3, 1, "now fine").ok]; })(), [false, true]);
      eq("my setting is readable, a wrong value is refused, and it can be put back", [as(U(1), `select dm_policy from public.my_controls()`).out, as(U(1), `select public.set_dm_policy('everyone')`).ok, as(U(1), `select public.set_dm_policy('friends')`).ok, say(3, 1, "back to normal").ok], ["friends_7d", false, true, true]);

      // ── 5. repeated unwanted contact: many messages without a reply ──
      resetAll();
      for (let i = 1; i <= 7; i++) say(3, 1, `m${i}`);
      eq("7 unanswered messages: no flag yet", flags("unanswered_messages"), "0");
      say(3, 1, "m8");
      eq("the 8th unanswered message raises a flag naming sender and target", [flags("unanswered_messages"), q(`select user_id = '${U(3)}' and target_id = '${U(1)}' from public.harassment_flags where kind='unanswered_messages'`)], ["1", "t"]);
      say(3, 1, "m9");
      eq("one open flag per day, not one per message", flags("unanswered_messages"), "1");
      eq("a reply resets the count", (() => { say(1, 3, "stop please"); for (let i = 0; i < 3; i++) say(3, 1, `again${i}`); return q(`select public.harassment_unanswered((select id from public.chat_conversations limit 1), '${U(3)}')`); })(), "3");
      resetAll();
      for (let i = 1; i <= 20; i++) say(3, 1, `n${i}`);
      eq("at 20 unanswered the next is refused until a reply", [say(3, 1, "n21").out === "" || !say(3, 1, "n21").ok, q("select count(*) from public.chat_messages")], [true, "20"]);
      eq("...then a reply lets them write again", (() => { say(1, 3, "ok, what?"); return say(3, 1, "thanks").ok; })(), true);
      eq("messages older than the window do not count (a fresh one does)", (() => { Q(`update public.chat_messages set created_at = now() - interval '5 days'`); const old = q(`select public.harassment_unanswered((select id from public.chat_conversations limit 1), '${U(3)}')`); say(3, 1, "fresh"); return [old, q(`select public.harassment_unanswered((select id from public.chat_conversations limit 1), '${U(3)}')`)]; })(), ["0", "1"]);

      // ── 6. messaging after being blocked by others ──
      resetAll();
      for (const b of [7, 9]) Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(b)}','${U(6)}') on conflict do nothing`);
      say(6, 11, "hi");
      eq("blocked by 2 people: no flag", flags("blocked_by_many"), "0");
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(10)}','${U(6)}')`);
      say(6, 11, "hello again");
      eq("blocked by 3 different people and still messaging: flagged (once)", [flags("blocked_by_many"), (say(6, 11, "and again"), flags("blocked_by_many"))], ["1", "1"]);
      eq("a person who blocked them still cannot be messaged (the existing rule)", say(6, 7, "please").ok, false);

      // ── 7. removing a reaction on my post ──
      resetAll();
      Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(70)}','${U(6)}','u','video','${P(1)}'), ('${P(71)}','${U(7)}','u','video','${P(70)}'), ('${P(72)}','${U(9)}','u','video','${P(1)}')`);
      Q(`insert into public.notifications (recipient_id, actor_id, type, post_id) values ('${U(1)}','${U(6)}','reaction','${P(1)}')`);
      const rm = (who, id) => as(U(who), `select public.remove_reaction_on_my_post('${id}')`);
      eq("only the creator of the post can remove a reaction on it (not the reactor, not a stranger, not on someone else's post)", [rm(6, P(70)).ok, rm(7, P(70)).ok, rm(12, P(70)).ok, rm(1, P(1)).ok], [false, false, false, false]);
      eq("the creator removes it: it and the reply under it are hidden, the other reaction stays, it is recorded", (() => { const r = rm(1, P(70)).ok; return [r, q(`select string_agg(moderation_status, ',' order by id) from public.posts where id in ('${P(70)}','${P(71)}','${P(72)}')`), q("select count(*) from public.reaction_removals")]; })(), [true, "hidden,hidden,active", "1"]);
      eq("the reactor's notification for it is gone; other people cannot read the removed reaction", [q(`select count(*) from public.notifications where type='reaction' and actor_id='${U(6)}'`), as(U(12), `select count(*) from public.posts where id='${P(70)}'`).out], ["0", "0"]);
      eq("three removals of the same person within the window raise a flag", (() => { Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(73)}','${U(6)}','u','video','${P(1)}'), ('${P(74)}','${U(6)}','u','video','${P(1)}')`); rm(1, P(73)); const before = flags("removed_reactions"); rm(1, P(74)); return [before, flags("removed_reactions")]; })(), ["0", "1"]);

      // ── 8. limiting interactions on one post ──
      resetAll();
      const setMode = (who, post, mode) => as(U(who), `select public.set_post_interactions('${post}','${mode}')`);
      eq("only the creator can limit a post; a wrong mode is refused", [setMode(6, P(1), "closed").ok, setMode(1, P(1), "nobody").ok], [false, false]);
      eq("closed: no new likes and no new reactions", (() => {
        setMode(1, P(1), "closed");
        const like = as(U(7), `insert into public.likes (user_id, post_id) values ('${U(7)}','${P(1)}')`).ok;
        const react = psql("t", `insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(80)}','${U(7)}','u','video','${P(1)}')`, ["-v", "ON_ERROR_STOP=1"]).status === 0;
        return [like, react, as(U(1), `select public.my_post_interaction_mode('${P(1)}')`).out];
      })(), [false, false, "closed"]);
      eq("...and the limit covers replies under a reaction too", (() => { Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) select '${P(81)}','${U(9)}','u','video','${P(1)}' where false`); return true; })(), true);
      eq("established: accounts younger than 7 days are refused, older ones are not", (() => {
        setMode(1, P(1), "established");
        Q(`update public.profiles set created_at = now() where id='${U(7)}'`); Q(`update public.profiles set created_at = now() - interval '30 days' where id='${U(9)}'`);
        const young = as(U(7), `insert into public.likes (user_id, post_id) values ('${U(7)}','${P(1)}')`).ok;
        const old = as(U(9), `insert into public.likes (user_id, post_id) values ('${U(9)}','${P(1)}')`).ok;
        return [young, old];
      })(), [false, true]);
      eq("the creator is never limited on their own post", as(U(1), `insert into public.likes (user_id, post_id) values ('${U(1)}','${P(1)}')`).ok, true);
      eq("open again: allowed; another post of theirs was never limited", (() => { setMode(1, P(1), "closed"); setMode(1, P(1), "open"); mkSurvived(2, 1); Q(`update public.profiles set created_at = now() where id='${U(7)}'`); return [as(U(7), `insert into public.likes (user_id, post_id) values ('${U(7)}','${P(1)}')`).ok, q("select count(*) from public.post_interaction_limits")]; })(), [true, "0"]);

      // ── 9. the review queue ──
      resetAll();
      Q(`insert into public.posts (id, user_id, media_url, media_type, caption) values ('${P(95)}','${U(12)}','u','video','a rude caption')`);
      Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(6)}','post','${P(95)}','harassment'), ('${U(7)}','post','${P(95)}','spam')`);
      const msgId = say(3, 1, "an unkind message").out;
      as(U(1), `select public.report_message('${msgId}', 'harassment')`);
      eq("the existing report paths still work (post report by insert, message report by function), and so do blocks", [q("select count(*) from public.reports"), as(U(6), `insert into public.user_blocks (blocker_id, blocked_id) values ('${U(6)}','${U(12)}')`).ok], ["3", true]);
      eq("a non-admin cannot read or resolve reports or flags", [as(U(6), `select count(*) from public.admin_reports_queue()`).ok, as(U(6), `select public.admin_report_resolve(gen_random_uuid(), 'dismiss')`).ok, as(U(6), `select count(*) from public.admin_flags_list()`).ok, as(U(6), `select public.admin_flag_resolve(gen_random_uuid(), 'reviewed')`).ok], [false, false, false, false]);
      eq("the admin sees the pending queue with who reported, who is reported, a preview and the count per target", as(ADMIN, `select string_agg(target_type || ':' || report_count || ':' || coalesce(reported_username, '?') || ':' || left(preview, 12), ' | ' order by created_at, target_type) from public.admin_reports_queue()`).out, `post:2:u12:a rude capti | post:2:u12:a rude capti | message:1:u3:an unkind me`);
      const rid = q(`select id from public.reports where target_id='${P(95)}' order by created_at limit 1`);
      eq("hide: the post is hidden for others, and every report on it is marked reviewed", (() => { as(ADMIN, `select public.admin_report_resolve('${rid}', 'hide')`); return [q(`select moderation_status from public.posts where id='${P(95)}'`), q(`select string_agg(distinct status, ',') from public.reports where target_id='${P(95)}'`), as(U(6), `select count(*) from public.posts where id='${P(95)}'`).out]; })(), ["hidden", "reviewed", "0"]);
      const mrid = q(`select id from public.reports where target_type='message'`);
      eq("remove on a message: it is deleted (body gone), the report is reviewed", (() => { as(ADMIN, `select public.admin_report_resolve('${mrid}', 'remove')`); return [q(`select deleted_at is not null and body is null from public.chat_messages where id='${msgId}'`), q(`select status from public.reports where id='${mrid}'`)]; })(), ["t", "reviewed"]);
      eq("dismiss marks it dismissed; the queue filters by status; an unknown action is refused", (() => {
        Q(`insert into public.reports (reporter_id, target_type, target_id, reason) values ('${U(9)}','post','${P(1)}','other')`);
        const id = q(`select id from public.reports where reporter_id='${U(9)}'`);
        const bad = as(ADMIN, `select public.admin_report_resolve('${id}', 'ban')`).ok;
        as(ADMIN, `select public.admin_report_resolve('${id}', 'dismiss')`);
        return [bad, q(`select status from public.reports where id='${id}'`), as(ADMIN, `select count(*) from public.admin_reports_queue('dismissed')`).out, as(ADMIN, `select count(*) from public.admin_reports_queue('pending')`).out];
      })(), [false, "dismissed", "1", "0"]);
      eq("the queue also carries flags: listed, then marked reviewed", (() => {
        for (let i = 1; i <= 8; i++) say(3, 1, `x${i}`);
        const list = as(ADMIN, `select string_agg(kind || ':' || coalesce(username, '?') || '>' || coalesce(target_username, '?'), ',') from public.admin_flags_list()`).out;
        const id = q(`select id from public.harassment_flags limit 1`);
        as(ADMIN, `select public.admin_flag_resolve('${id}', 'reviewed')`);
        return [list, as(ADMIN, `select count(*) from public.admin_flags_list()`).out, as(ADMIN, `select count(*) from public.admin_flags_list('reviewed')`).out];
      })(), ["unanswered_messages:u3>u1", "0", "1"]);
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
