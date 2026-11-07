#!/usr/bin/env node
/**
 * SPOTLIGHT (supabase/migration-spotlight.sql) on top of the stranger-only migrations, run for real on a scratch PostgreSQL (same
 * harness as test-stranger-only-sql.mjs). Admin-only offers, the creator's consent (full / strangers / decline), and the exposure
 * rule on every surface: the Spotlight section, the feed boost and the profile badge; rotation, expiry, withdrawal.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-spotlight-sql.mjs
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
      const offer = (creator = 1, post = 1, cat = CAT, who = ADMIN) => as(who, `select public.admin_spotlight_offer('${U(creator)}','${P(post)}','${cat}')`);
      const respond = (pick, choice, who = U(1)) => as(who, `select public.respond_spotlight_offer('${pick}','${choice}')`);
      const spot = (uid) => as(uid, `select coalesce(string_agg(post_id::text, ','), '') from public.get_spotlight(10)`).out.split(",").filter(Boolean);
      const badge = (uid, creator = 1) => as(uid, `select coalesce(string_agg(category || ':' || active::text, ','), '') from public.profile_spotlight('${U(creator)}')`).out;
      const reset = () => { setup(); Q(`delete from public.spotlight_picks; delete from public.notifications`); mkSurvived(1, 1); mkSurvived(2, 12, 2); for (const n of [7, 9, 10]) Q(`insert into public.likes (user_id, post_id) values ('${U(n)}','${P(2)}')`); };   // P(2) is the better-liked post: without a boost it leads

      // ── 1. only an admin ──
      reset();
      eq("a non-admin cannot use any admin function", [as(U(6), `select count(*) from public.admin_spotlight_creators('')`).ok, as(U(6), `select public.admin_spotlight_offer('${U(1)}','${P(1)}','${CAT}')`).ok, as(U(6), `select count(*) from public.admin_spotlight_list()`).ok, as(U(6), `select public.admin_spotlight_withdraw(gen_random_uuid())`).ok, as(U(6), `select count(*) from public.admin_spotlight_posts('${U(1)}')`).ok], [false, false, false, false, false]);
      eq("an admin finds creators with survived posts (and their posts)", [as(ADMIN, `select count(*) from public.admin_spotlight_creators('u12')`).out, as(ADMIN, `select count(*) from public.admin_spotlight_creators('')`).out, as(ADMIN, `select count(*) from public.admin_spotlight_posts('${U(1)}')`).out], ["1", "2", "1"]);
      eq("the tables are closed to apps", ["spotlight_picks", "spotlight_admins", "spotlight_config"].map((t) => as(U(6), `select count(*) from public.${t}`).ok), [false, false, false]);
      eq("internals are not callable by apps", [as(U(6), `select public.spotlight_eligible('${U(1)}','full','${U(6)}')`).ok, as(U(6), `select public.spotlight_expire()`).ok, as(U(6), `select public.spotlight_is_admin()`).ok], [false, false, false]);

      // ── 2. what can be offered ──
      mkTrial(3, 1);
      eq("only a survived post of that creator, and a known category", [offer(1, 3).ok, offer(1, 2).ok, offer(1, 1, "best_dressed").ok], [false, false, false]);
      Q(`update public.posts set media_deleted_at = now() where id='${P(2)}'`); Q(`update public.posts set media_deleted_at = null where id='${P(2)}'`);
      eq("all six categories exist", ["creator_of_the_day", "rising_creators", "most_creative", "best_storytelling", "most_improved", "community_favorite"].map((c) => q(`select ('${c}' in ('creator_of_the_day','rising_creators','most_creative','best_storytelling','most_improved','community_favorite'))::text`)), Array(6).fill("true"));

      // ── 3. an offer shows NOTHING to anyone, and tells the creator ──
      reset();
      const o = offer();
      ok("the admin can offer", o.ok && /^[0-9a-f-]{36}$/.test(o.out));
      const PICK = o.out;
      eq("the creator gets one in-app notification (spotlight_offer), nobody else does", [q(`select count(*) from public.notifications where type='spotlight_offer' and recipient_id='${U(1)}' and post_id='${P(1)}'`), q(`select count(*) from public.notifications where type='spotlight_offer'`)], ["1", "1"]);
      eq("the creator sees the open offer", as(U(1), `select status || ':' || category from public.my_spotlight_offers()`).out, `offered:${CAT}`);
      eq("BEFORE consent nothing is shown: no section for anyone (strangers, friend, contact, email, hidden), no badge, no boost", [[6, 7, 2, 3, 5, 8, 4].map((n) => spot(U(n)).length).join(","), badge(U(6)), feed(U(6))[0] === P(1) ? "boosted" : "not boosted"], ["0,0,0,0,0,0,0", "", "not boosted"]);
      eq("nobody else can answer someone's offer", [respond(PICK, "full", U(6)).ok, respond(PICK, "full", ADMIN).ok], [false, false]);
      eq("a second offer to the same creator is refused (rotation)", offer().ok, false);

      // ── 4. strangers-only ──
      eq("the creator says strangers-only", respond(PICK, "strangers").out, "strangers");
      eq("an offer can be answered once", respond(PICK, "full").ok, false);
      eq("the Spotlight section: every stranger sees it", STRANGERS.map((n) => spot(U(n)).join(",")), Array(5).fill(P(1)));
      eq("...and NO known connection does: phone contact, reverse phone, email contact, friend, hide list", [2, 8, 5, 3, 4].map((n) => spot(U(n)).length), [0, 0, 0, 0, 0]);
      eq("the badge shows to a stranger and to the creator, not to a known connection", [badge(U(6)), badge(U(1)), badge(U(2)), badge(U(3)), badge(U(4)), badge(U(5))], [`${CAT}:true`, `${CAT}:true`, "", "", "", ""]);
      eq("the boost: the picked post leads a stranger's feed, ahead of a post with more likes", feed(U(6)).slice(0, 2), [P(1), P(2)]);
      eq("...a known connection's feed never has it (strangers-only keeps the Phase 1 rule)", [2, 3, 5, 8, 4].map((n) => feed(U(n)).includes(P(1))), [false, false, false, false, false]);
      eq("...and once the stranger has seen it, it stops leading (a boost, not a loop)", (() => { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(1)}','${U(6)}')`); return feed(U(6))[0] === P(1); })(), false);
      eq("the creator's own section and feed do not show their own pick", [spot(U(1)).length, feed(U(1)).includes(P(1))], [0, false]);
      eq("a blocked pair is excluded both ways", (() => { Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(7)}','${U(1)}')`); const r = [spot(U(7)).length, feed(U(7)).includes(P(1)), badge(U(7))]; Q(`delete from public.user_blocks`); return r; })(), [0, false, ""]);

      // ── 5. full spotlight ──
      reset();
      const full = offer().out;
      eq("the creator says full", respond(full, "full").out, "full");
      eq("full: strangers AND friends and contacts see the section (phone, reverse phone, email, friend)", [6, 7, 2, 8, 5, 3].map((n) => spot(U(n)).join(",")), Array(6).fill(P(1)));
      eq("full: but NEVER someone on the creator's hide list", [spot(U(4)).length, feed(U(4)).includes(P(1)), badge(U(4))], [0, false, ""]);
      eq("full: the friend's feed carries the picked post, and ONLY that one (the creator's other survived posts stay out of known people's feeds)", (() => { mkSurvived(5, 1, 3); return [feed(U(3)).includes(P(1)), feed(U(3)).includes(P(5)), feed(U(2)).includes(P(1)), feed(U(8)).includes(P(1)), feed(U(5)).includes(P(1))]; })(), [true, false, true, true, true]);
      eq("full: the badge shows to a friend and a stranger", [badge(U(3)), badge(U(6))], [`${CAT}:true`, `${CAT}:true`]);
      eq("full: a stranger's feed leads with it too", feed(U(9))[0], P(1));

      // ── 6. decline ──
      reset();
      const dec = offer().out;
      eq("the creator declines", respond(dec, "decline").out, "declined");
      eq("declined: nothing anywhere, no badge", [[6, 2].map((n) => spot(U(n)).length).join(","), badge(U(6)), feed(U(6))[0] === P(1)], ["0,0", "", false]);
      eq("declined: the creator is not offered again within the rotation (nobody is pestered)", offer().ok, false);
      eq("a choice outside full / strangers / decline is refused", (() => { reset(); const x = offer().out; return respond(x, "everyone").ok; })(), false);

      // ── 7. rotation ──
      reset();
      const r1 = offer().out; respond(r1, "strangers");
      eq("rotation: not again within 30 days (config)", offer().ok, false);
      Q(`update public.spotlight_picks set created_at = now() - interval '31 days', starts_at = now() - interval '31 days', ends_at = now() - interval '28 days'`);
      eq("rotation: after rotation_days the same creator can be offered again", offer().ok, true);
      reset(); Q(`update public.spotlight_config set rotation_days = 7`);
      const r2 = offer().out; respond(r2, "strangers");
      Q(`update public.spotlight_picks set created_at = now() - interval '8 days'`);
      eq("rotation follows the config value", offer().ok, true);
      Q(`update public.spotlight_config set rotation_days = 30`);
      reset(); const w = offer().out; as(ADMIN, `select public.admin_spotlight_withdraw('${w}')`);
      eq("a withdrawn offer does not count against the creator", offer().ok, true);
      reset(); const ex = offer().out; Q(`update public.spotlight_picks set created_at = now() - interval '4 days' where id='${ex}'`);
      eq("an offer nobody answered expires (72 h), can no longer be answered, and does not count against the creator", [respond(ex, "full").ok, as(U(1), `select count(*) from public.my_spotlight_offers()`).out, q(`select status from public.spotlight_picks where id='${ex}'`), offer().ok], [false, "0", "expired", true]);

      // ── 8. expiry, badge window, withdrawal, gone posts ──
      reset();
      const e1 = offer().out; respond(e1, "strangers");
      eq("active for spotlight_hours (72)", q(`select round(extract(epoch from (ends_at - starts_at)) / 3600) from public.spotlight_picks where id='${e1}'`), "72");
      Q(`update public.spotlight_picks set ends_at = now() - interval '1 minute', starts_at = now() - interval '73 hours' where id='${e1}'`);
      eq("after it ends: gone from the section and the boost; the badge stays (inactive) for badge_days, for strangers only", [spot(U(6)).length, feed(U(6))[0] === P(1), q(`select status from public.spotlight_picks where id='${e1}'`), badge(U(6)), badge(U(2))], [0, false, "ended", `${CAT}:false`, ""]);
      Q(`update public.spotlight_picks set starts_at = now() - interval '31 days', ends_at = now() - interval '28 days' where id='${e1}'`);
      eq("after badge_days the badge is gone", badge(U(6)), "");
      reset(); const w2 = offer().out; respond(w2, "full");
      eq("withdrawing an active Spotlight removes it at once", (() => { const before = spot(U(6)).length; as(ADMIN, `select public.admin_spotlight_withdraw('${w2}')`); return [before, spot(U(6)).length, spot(U(3)).length, badge(U(6))]; })(), [1, 0, 0, ""]);
      reset(); const g1 = offer().out; respond(g1, "full");
      eq("a post that is taken down (moderation) leaves the section and the boost at once, and returns with it (media of a survived post is never deleted)", (() => {
        Q(`update public.posts set moderation_status = 'removed' where id='${P(1)}'`); const a = [spot(U(6)).length, feed(U(6)).includes(P(1))]; Q(`update public.posts set moderation_status = 'active' where id='${P(1)}'`);
        return [a, spot(U(6)).length];
      })(), [[0, false], 1]);
      eq("a minor does not get a mature post", (() => { Q(`update public.posts set is_mature = true where id='${P(1)}'`); const r = spot(U(13)).length; Q(`update public.posts set is_mature = false where id='${P(1)}'`); return r; })(), 0);
      eq("not signed in: nothing", psql("t", "set role anon; select * from public.get_spotlight(5)", ["-v", "ON_ERROR_STOP=1"]).status !== 0, true);
      eq("deleting the post removes the pick with it", (() => { Q(`delete from public.posts where id='${P(1)}'`); return q(`select count(*) from public.spotlight_picks`); })(), "0");

      // ── 9. the feed is otherwise untouched ──
      reset();
      eq("no Spotlight at all: a stranger's feed is the stranger-only feed (the survived posts, no known creators)", feed(U(6)).sort(), [P(1), P(2)].sort());
      eq("...and a known connection of the creator still does not get the creator's posts", [feed(U(2)).includes(P(1)), feed(U(3)).includes(P(1)), feed(U(4)).includes(P(1)), feed(U(5)).includes(P(1))], [false, false, false, false]);
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
