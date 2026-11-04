#!/usr/bin/env node
/**
 * STRANGER-ONLY distribution (supabase/migration-stranger-only.sql, with migration-known-connections.sql), run for real on a scratch
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

      // ── 1. who is known ──
      setup();
      eq("known_connections: phone (both directions), email, friend, hide list", q(`select string_agg(source || ':' || other_id::text, ',' order by source, other_id) from public.known_connections where user_id='${U(1)}'`),
        [`contact:${U(2)}`, `contact:${U(8)}`, `email:${U(5)}`, `friend:${U(3)}`, `hide_list:${U(4)}`].join(","));
      eq("...and from the other side: B, H, E and C all know A (contacts, email and friends are mutual rows)", q(`select count(*) from public.known_connections where other_id='${U(1)}'`), "4");
      ok("emails match case-insensitively and a raw address is nowhere in the database", (() => {
        as(U(1), `select public.sync_my_contact_emails(array['USER5@EXAMPLE.TEST'])`);
        const same = q(`select count(*) from public.known_connections where user_id='${U(1)}' and source='email'`) === "1";
        const raw = q(`select count(*) from public.contact_email_hashes where hash like '%@%'`) === "0" && q(`select count(*) from public.user_email_hash where hash like '%@%'`) === "0";
        as(U(1), `select public.sync_my_contact_emails(array['${emailOf(5)}', 'Someone.Else@Example.Test'])`);
        return same && raw;
      })());
      eq("an invalid address is skipped without echoing it", [as(U(1), `select public.sync_my_contact_emails(array['not an email', 'a@b'])`).out, as(U(1), `select public.sync_my_contact_emails(array['not an email'])`).err.includes("not an email")], ["0", false]);
      as(U(1), `select public.sync_my_contact_emails(array['${emailOf(5)}', 'Someone.Else@Example.Test'])`);
      ok("a new match appears by itself: someone who signs up AFTER the contact list was synced is known at once", (() => {
        Q(`insert into auth.users (id, raw_user_meta_data, email) values ('${U(20)}','{"username":"late"}','someone.else@example.test')`);
        const known = q(`select count(*) from public.known_connections where user_id='${U(1)}' and other_id='${U(20)}'`) === "1";
        Q(`delete from auth.users where id='${U(20)}'`);
        return known;
      })());
      ok("changing an account's email updates its hash (the trigger)", (() => {
        Q(`update auth.users set email='moved@example.test' where id='${U(5)}'`);
        const gone = q(`select count(*) from public.known_connections where user_id='${U(1)}' and other_id='${U(5)}'`) === "0";
        Q(`update auth.users set email='${emailOf(5)}' where id='${U(5)}'`);
        return gone && q(`select count(*) from public.known_connections where user_id='${U(1)}' and other_id='${U(5)}'`) === "1";
      })());
      ok("clients cannot read any of it", ["known_connections", "contact_hashes", "contact_email_hashes", "user_email_hash", "user_phone_hash"].every((t) => !as(U(2), `select count(*) from public.${t}`).ok));
      eq("deleting my privacy data removes my email hashes too", (() => { as(U(8), `select public.sync_my_contact_emails(array['x@y.zz'])`); as(U(8), `select public.delete_my_privacy_data()`); return [q(`select count(*) from public.contact_email_hashes where owner_id='${U(8)}'`), q(`select count(*) from public.user_email_hash where user_id='${U(8)}'`)]; })(), ["0", "0"]);
      ok("set_my_email_hash (the safety net at sign-in) reads the account's email from the token and never fails without one", (() => {
        const noEmail = as(U(8), `select public.set_my_email_hash()`).ok;
        const withEmail = psql("t", `set role authenticated; set request.jwt.claim.sub='${U(8)}'; set request.jwt.claims='{"email":"${emailOf(8)}"}'; select public.set_my_email_hash()`, ["-v", "ON_ERROR_STOP=1"]).status === 0;
        return noEmail && withEmail && q(`select count(*) from public.user_email_hash where user_id='${U(8)}'`) === "1";
      })());

      // ── 2. the feed: trial posts ──
      setup();
      mkTrial(1, 1);
      eq("a trial post is assigned to strangers only (phone, reverse phone, email, friend and hide list are never in the audience)", q(`select string_agg(viewer_id::text, ',' order by viewer_id) from public.trial_assignments where post_id='${P(1)}'`).split(",").filter((u) => !!u).every((u) => [6, 7, 9, 10, 11, 12, 13].map(U).includes(u)), true);
      for (const [who, n] of Object.entries(KNOWN)) ok(`${who}: the trial post is not in their feed`, !feed(U(n)).includes(P(1)));
      ok("a stranger gets it in their feed", STRANGERS.every((n) => feed(U(n)).includes(P(1))));
      ok("a known person cannot read it around the feed either (RLS on posts)", Object.values(KNOWN).every((n) => as(U(n), `select count(*) from public.posts where id='${P(1)}'`).out === "0"));

      // ── 3. the feed: survived posts (every tier) ──
      setup();
      mkSurvived(2, 1, 1);            // fresh
      mkSurvived(3, 1, 80);           // older
      mkSurvived(4, 12, 1);           // somebody else's, the stranger L=12, A knows nobody about L
      for (const [who, n] of Object.entries(KNOWN)) ok(`${who}: no survived post of A, fresh or older, in their feed`, !feed(U(n)).includes(P(2)) && !feed(U(n)).includes(P(3)));
      ok("known people still get survived posts of OTHER creators who do not know them", Object.values(KNOWN).every((n) => feed(U(n)).includes(P(4))));
      ok("strangers get A's fresh and older survived posts", STRANGERS.every((n) => feed(U(n)).includes(P(2)) && feed(U(n)).includes(P(3))));
      eq("order for a stranger: fresh survivors before older ones", (() => { const f = feed(U(6)); return f.indexOf(P(2)) < f.indexOf(P(3)); })(), true);
      ok("nobody sees their own posts in their feed", !feed(U(1)).includes(P(2)) && !feed(U(1)).includes(P(3)));
      Q(`insert into public.viewer_creator_affinity (viewer_id, creator_id, score) select '${U(2)}'::uuid, '${U(1)}'::uuid, 100::double precision union all select '${U(3)}'::uuid, '${U(1)}'::uuid, 100 union all select '${U(4)}'::uuid, '${U(1)}'::uuid, 100 union all select '${U(5)}'::uuid, '${U(1)}'::uuid, 100 union all select '${U(6)}'::uuid, '${U(1)}'::uuid, 100`);
      ok("the affinity boost cannot bring a known creator back (high affinity, still excluded); a stranger's boost still works", [2, 3, 4, 5].every((n) => !feed(U(n)).includes(P(2))) && feed(U(6))[0] === P(2));
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(6)}','${U(1)}')`);
      ok("blocks still apply on top (a blocked creator is not in the feed)", !feed(U(6)).includes(P(2)));
      Q(`delete from public.user_blocks`);
      Q(`update public.posts set moderation_status='hidden' where id='${P(2)}'`);
      ok("moderation still applies", !feed(U(6)).includes(P(2)) && feed(U(6)).includes(P(3)));
      Q(`update public.posts set moderation_status='active' where id='${P(2)}'`);
      eq("when a stranger has seen everything the page is empty (\"all caught up\" in the app); nothing leaks in", (() => {
        for (const n of [2, 3, 4]) Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(n)}','${U(9)}') on conflict do nothing`);
        const all = feed(U(9));
        return [all.length >= 3, as(U(9), `select count(*) from public.get_feed_engine(100, 0, array['${P(2)}','${P(3)}','${P(4)}']::uuid[]) where post_id is not null`).out];
      })(), [true, "0"]);

      // ── 4. the profile stays open ──
      setup();
      mkSurvived(2, 1, 1); mkTrial(1, 1);
      for (const [who, n] of Object.entries(KNOWN)) {
        eq(`${who}: A's profile shows the survived post (and never the testing one)`, as(U(n), `select coalesce(string_agg(post_id::text, ','), '') from public.profile_posts('${U(1)}')`).out, P(2));
        ok(`${who}: the survived post can be read directly`, as(U(n), `select count(*) from public.posts where id='${P(2)}'`).out === "1");
      }

      // ── 5. Explore, creator search, suggested creators ──
      setup();
      mkSurvived(2, 1, 1);          // A has a survived post
      mkSurvived(5, 6, 1); mkSurvived(6, 7, 1); mkSurvived(7, 2, 1); mkSurvived(8, 3, 1); mkSurvived(9, 4, 1); mkSurvived(10, 5, 1);   // F, G, B, C, D, E too
      Q(`insert into public.likes (user_id, post_id) values ('${U(9)}','${P(2)}'), ('${U(10)}','${P(2)}'), ('${U(1)}','${P(2)}')`);
      const ids = (uid, sql) => as(uid, sql).out.split(",").filter(Boolean).sort();
      const explore = (uid) => ids(uid, `select coalesce(string_agg(id, ','), '') from public.get_explore_creators()`);
      const suggested = (uid) => ids(uid, `select coalesce(string_agg(id::text, ','), '') from public.suggested_creators(50)`);
      const search = (uid, text) => ids(uid, `select coalesce(string_agg(id::text, ','), '') from public.search_creators('${text}')`);
      for (const [who, n] of Object.entries({ B: 2, C: 3, D: 4, E: 5, H: 8 })) {
        ok(`${who} (knows A): A is not in Explore, suggestions or search`, !explore(U(n)).includes(U(1)) && !suggested(U(n)).includes(U(1)) && !search(U(n), "u1").includes(U(1)) && !search(U(n), "Name1").includes(U(1)));
      }
      ok("a stranger finds A in Explore, suggestions and search", [explore(U(9)), suggested(U(9)), search(U(9), "u1"), search(U(9), "name1")].every((l) => l.includes(U(1))));
      ok("never the person themselves", ![explore(U(6)), suggested(U(6)), search(U(6), "u6")].some((l) => l.includes(U(6))));
      ok("A (the creator) does not get the people who know A either (contacts and friends are mutual; the hide list is one way)", ![explore(U(1)), suggested(U(1)), search(U(1), "u")].some((l) => [2, 3, 5, 8].some((n) => l.includes(U(n)))));
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(9)}','${U(6)}')`);
      ok("blocked either way: not in Explore / suggestions / search", ![explore(U(9)), suggested(U(9)), search(U(9), "u6")].some((l) => l.includes(U(6))) && ![explore(U(6)), suggested(U(6)), search(U(6), "u9")].some((l) => l.includes(U(9))));
      Q(`delete from public.user_blocks`);
      ok("search treats % and _ as plain characters and needs a character", search(U(9), "%").length === 0 && search(U(9), "").length === 0);
      eq("anon gets nothing", [psql("t", "set role anon; select * from public.get_explore_creators()", ["-v", "ON_ERROR_STOP=1"]).status !== 0, psql("t", "set role anon; select * from public.search_creators('u')", ["-v", "ON_ERROR_STOP=1"]).status !== 0], [true, true]);
      ok("a person with no survived post is not in Explore / suggestions (but is searchable by a stranger)", !explore(U(9)).includes(U(13)) && !suggested(U(9)).includes(U(13)) && search(U(9), "u13").includes(U(13)));

      // ── 6. sharing posts ──
      setup();
      mkSurvived(2, 1, 1); mkTrial(1, 1);
      for (const [a, b] of [[1, 2], [1, 4], [6, 7], [6, 2], [6, 3], [6, 8], [6, 1]]) Q(`insert into public.friendships (user_a, user_b) values (least('${U(a)}'::uuid, '${U(b)}'), greatest('${U(a)}'::uuid, '${U(b)}')) on conflict do nothing`);
      const send = (from, to, post) => as(U(from), `select public.send_post_to_friend('${U(to)}', '${P(post)}')`).ok;
      ok("the creator sends their OWN trial post to a friend, and their own survived post", send(1, 2, 1) && send(1, 4, 2) && send(1, 2, 2));
      Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(6)}') on conflict do nothing`);
      ok("a stranger sends A's survived post to their own stranger friend", send(6, 7, 2));
      ok("...but NOT to a friend who is a known person of A: a contact (B), a friend of A (C), a reverse contact (H), A's hide-list person is never a friend here", !send(6, 2, 2) && !send(6, 3, 2) && !send(6, 8, 2));
      ok("...nor A's trial post to them", !send(6, 2, 1) && !send(6, 3, 1) && !send(6, 8, 1));
      ok("...nor to A themselves", !send(6, 1, 2));
      ok("a stranger sends A's trial post (which they have seen) to a stranger friend", send(6, 7, 1));
      ok("...but not one they have not seen (no guessing ids)", (() => { Q(`delete from public.post_raw_views where viewer_id='${U(6)}' and post_id='${P(1)}'`); return !send(6, 7, 1); })());
      eq("the list \"Send to friend\" offers is the same rule (A's survived post, from F)", as(U(6), `select coalesce(string_agg(id::text, ',' order by id), '') from public.friends_for_post('${P(2)}')`).out, [U(1), U(7)].sort().join(",").replace(U(1) + ",", "").replace(new RegExp(`,?${U(1)}`), ""));
      ok("availability at open time follows the same rule: a survived post sent by a stranger stops being available when the recipient later becomes known to its creator", (() => {
        const m = q(`select id from public.chat_messages where post_id='${P(2)}' and sender_id='${U(6)}' and conversation_id in (select id from public.chat_conversations where '${U(7)}' in (user_a, user_b)) order by created_at desc limit 1`);
        const before = as(U(7), `select available from public.open_shared_post('${m}')`).out === "t";
        Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(7)}') on conflict do nothing`);
        const after = as(U(7), `select available from public.open_shared_post('${m}')`).out === "f";
        Q(`delete from public.friendships where user_a='${U(1)}' and user_b='${U(7)}'`);
        return before && after;
      })());
      ok("the creator's own post, sent to their friend, stays available to that friend (the creator sent it)", (() => {
        const m = q(`select id from public.chat_messages where post_id='${P(1)}' and sender_id='${U(1)}' order by created_at desc limit 1`);
        return as(U(2), `select available from public.open_shared_post('${m}')`).out === "t";
      })());
      ok("a friend who opened the creator's trial post from a message never counts toward its verdict (views refused)", (() => {
        as(U(2), `select public.record_view_progress('${P(1)}', 9000, 12000, true)`);
        return q(`select count(*) from public.post_view_stats where viewer_id='${U(2)}'`) === "0";
      })());

      // ── 7. the trial: cap, no 'incomplete', failed posts deleted ──
      setup();
      mkTrial(1, 1);
      eq("a new post's trial ends 72 h after it starts (trial cap, a config value)", q(`select round(extract(epoch from (checkpoint_at - testing_started_at)) / 3600) from public.posts where id='${P(1)}'`), "72");
      Q(`update public.trial_engine_config set max_test_hours = 48`);
      mkTrial(2, 1);
      eq("...and follows the config for the next post", q(`select round(extract(epoch from (checkpoint_at - testing_started_at)) / 3600) from public.posts where id='${P(2)}'`), "48");
      Q(`update public.trial_engine_config set max_test_hours = 72`);
      Q(`update public.trial_engine_config set min_exhausted_viewers = 5`);
      const pastCap = (n) => Q(`update public.posts set created_at = now() - interval '80 hours', testing_started_at = now() - interval '80 hours' where id='${P(n)}'; update public.posts set checkpoint_at = testing_started_at + interval '72 hours' where id='${P(n)}'`);
      const evalPost = (n, bar = 0.3) => q(`select public.trial_evaluate_post('${P(n)}', ${bar})`);
      const decision = (n) => q(`select coalesce(decision, '-') from public.trial_post_state where post_id='${P(n)}'`);
      const status = (n) => q(`select coalesce((select status from public.posts where id='${P(n)}'), 'DELETED')`);
      eq("24 h in, with one stranger who saw it: still on trial (it used to become 'incomplete' here)", (() => {
        Q(`update public.posts set created_at = now() - interval '25 hours', testing_started_at = now() - interval '25 hours' where id='${P(1)}'`);
        Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(6)}')`);
        Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${P(1)}','${U(6)}', 8000, 12000) on conflict do nothing`);
        return [evalPost(1), status(1), decision(1)];
      })(), ["testing", "trial", "-"]);
      ok("...and it is still assigned to strangers (the cap, not 24 h, ends distribution)", q(`select count(*) from public.trial_assignments where post_id='${P(1)}' and released_at is null`) !== "0");
      // at the cap: survives when it meets the bar
      setup(); mkTrial(1, 1);
      for (const n of [6, 7, 9]) { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(n)}')`); Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms, completed) values ('${P(1)}','${U(n)}', 9000, 12000, true)`); Q(`insert into public.likes (user_id, post_id) values ('${U(n)}','${P(1)}')`); }
      pastCap(1);
      eq("at the cap, loved by the strangers who saw it: it survives (and is not deleted)", [evalPost(1), status(1)], ["survived", "survived"]);
      eq("a survived post is never deleted, whatever is asked", (() => { Q(`select public.trial_delete_failed_post('${P(1)}')`); return status(1); })(), "survived");
      // at the cap: nobody saw it -> deleted
      setup(); mkTrial(1, 1);
      Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(11)}','${U(6)}','https://x.supabase.co/storage/v1/object/public/drops/r11.mp4','video','${P(1)}')`);
      Q(`insert into public.notifications (recipient_id, actor_id, type, post_id) values ('${U(1)}','${U(6)}','reaction','${P(1)}')`);
      Q(`insert into public.likes (user_id, post_id) values ('${U(7)}','${P(1)}')`);
      pastCap(1);
      eq("at the cap with nobody who responded: the verdict is 'failed' and the post is DELETED", [evalPost(1), status(1)], ["failed", "DELETED"]);
      eq("...its reaction, likes, assignments and notifications are gone", [status(11), q(`select count(*) from public.likes where post_id='${P(1)}'`), q(`select count(*) from public.trial_assignments where post_id='${P(1)}'`), q(`select count(*) from public.notifications where post_id='${P(1)}'`)], ["DELETED", "0", "0", "0"]);
      eq("...its media (and its reaction's) is queued for the delete-media job", q(`select string_agg(path, ',' order by path) from public.trial_media_delete_queue`), "p1.mp4,r11.mp4");
      eq("...and the anonymous number behind the moving bar is kept (no post, no person)", [q(`select count(*) from public.trial_bar_samples where decision='failed'`), q(`select count(*) from information_schema.columns where table_name='trial_bar_samples' and column_name in ('post_id','user_id')`)], ["1", "0"]);
      // a failed-by-confidence post is deleted too
      setup(); mkTrial(1, 1);
      for (const n of [6, 7, 9, 10, 11]) { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(n)}')`); Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${P(1)}','${U(n)}', 300, 12000)`); }
      const v = evalPost(1);
      ok("five strangers swiped past it: judged and failed -> deleted", v === "failed" && status(1) === "DELETED");
      // the shared copy of a deleted post
      setup(); mkTrial(1, 1);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}') on conflict do nothing`);
      as(U(1), `select public.send_post_to_friend('${U(2)}', '${P(1)}')`);
      Q(`select public.trial_hide_post('${P(1)}'); delete from public.posts where id='${P(1)}'`);
      const mid = q(`select id from public.chat_messages where sender_id='${U(1)}' order by created_at desc limit 1`);
      eq("a shared post that was deleted shows 'isn't available' and the message stays", [as(U(2), `select available from public.open_shared_post('${mid}')`).out, q(`select count(*) from public.chat_messages where id='${mid}' and post_id is null and was_post`)], ["f", "1"]);
      // borderline: stays on trial
      setup(); mkTrial(1, 1);
      Q(`update public.trial_engine_config set min_exhausted_viewers = 1`);
      const viewersForBorderline = [6, 7, 9, 10, 11, 12, 13];
      for (const [i, n] of viewersForBorderline.entries()) { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(n)}')`); Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${P(1)}','${U(n)}', ${i < 5 ? 9000 : 100}, 12000)`); }
      Q(`update public.trial_assignments set released_at = null`);
      const bv = evalPost(1);
      ok("a borderline post (pool exhausted, not clearly good or bad) stays on trial instead of becoming 'incomplete'", bv === "testing" && status(1) === "trial" && decision(1) === "-");
      ok("no verdict path produces 'incomplete' any more", !/verdict := 'incomplete'|decision = 'incomplete'.*trial_apply/.test(readFileSync(so, "utf8").replace(/--.*$/gm, "").replace(/elsif p_decision = 'incomplete'[\s\S]*?end if;/, "")));

      // ── 8. nothing else can bypass: the old feed function and the client fallback ──
      eq("get_feed_engine has no legacy path and no reference to the dashboard get_feed", q(`select prosrc like '%get_feed(%' or prosrc like '%engine_mode%' from pg_proc where proname='get_feed_engine'`), "f");
      eq("not signed in: nothing", psql("t", "set role anon; select * from public.get_feed_engine(10, 0)", ["-v", "ON_ERROR_STOP=1"]).stdout.trim().split("\n").filter((l) => l && l !== "SET").length, 0);
      ok("the internals are not callable by apps", ["trial_creators_who_know(gen_random_uuid())", "stranger_creator_ids()", "trial_delete_failed_post(gen_random_uuid())", "chat_can_send_post(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", "trial_is_silenced(gen_random_uuid(), gen_random_uuid())"].every((f) => !as(U(6), `select public.${f}`).ok));
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
