#!/usr/bin/env node
/**
 * The push migration (supabase/migration-push.sql), run for real on a scratch PostgreSQL (Supabase's auth / vault / cron mocked, the
 * app's schema and the migrations it builds on, friends, then push twice): token saving and moving, settings, which
 * notifications are claimed and which skipped (and why), like milestones, message previews never for minors, retry back-off,
 * token cleanup, tickets, and who may call what. Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-push-sql.mjs
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
      const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const asUser = (uid, sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
      const as = (uid, sql) => { const r = asUser(uid, sql); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "", err: r.stderr }; };
      const asRole = (role, sql) => { const r = psql("t", `set role ${role}; ${sql}`, ["-v", "ON_ERROR_STOP=1"]); return { ok: r.status === 0, out: r.stdout.trim().split("\n").filter((l) => l && l !== "SET").pop() ?? "" }; };
      const mkUser = (n, birth = "1990-01-01") => Q(`insert into auth.users (id, raw_user_meta_data) values ('${U(n)}','{"username":"u${n}"}') on conflict do nothing; update public.profiles set birthdate='${birth}', display_name='Name${n}', created_at = now() - interval '100 hours' where id='${U(n)}'`);
      for (let i = 1; i <= 9; i++) mkUser(i);
      mkUser(10, "2012-06-01");     // a minor
      const TOK = (n) => `ExponentPushToken[tok${n}]`;

      // a notification that exists BEFORE push does: it must never be pushed
      Q(`insert into public.notifications (recipient_id, actor_id, type) values ('${U(1)}','${U(2)}','follow')`);

      // ── the friends migration, then push ──
      Q(`insert into vault.secrets values ('tryal_invite_secret', 'test-invite-secret-0123456789-abcdefghijklmnopqrstuvwxyz')`);
      const f1 = psqlFile("t", join(sqlDir, "migration-friends-messages.sql"));
      eq("(base) the friends migration applies", /ERROR/.test(f1.stderr), false);
      const pm = join(sqlDir, "migration-push.sql");
      const p1 = psqlFile("t", pm);
      Q(`insert into public.notifications (recipient_id, actor_id, type) values ('${U(1)}','${U(2)}','friend_request')`);
      const p2 = psqlFile("t", pm);
      if (/ERROR/.test(p1.stderr + p2.stderr)) console.log((p1.stderr + p2.stderr).split("\n").filter((l) => /ERROR/.test(l)).slice(0, 6).join("\n"));
      eq("the push migration applies cleanly, and again (idempotent)", [/ERROR/.test(p1.stderr), /ERROR/.test(p2.stderr)], [false, false]);
      eq("rows that existed before are marked skipped (no flood); a row made after the first run is not, and a second run leaves it alone", [q(`select push_skip_reason from public.notifications where type='follow'`), q(`select coalesce(push_skip_reason,'-') from public.notifications where type='friend_request'`)], ["before push existed", "-"]);
      const resetN = () => Q(`delete from public.notifications; delete from public.push_like_milestones; delete from public.likes; delete from public.posts; delete from public.chat_messages; delete from public.chat_conversations; delete from public.friendships; delete from public.user_blocks; delete from public.push_prefs; delete from public.push_tokens; delete from public.push_tickets`);
      const addN = (type, { to = 1, from = 2, post = null, ageMin = 0, read = false } = {}) => q(`insert into public.notifications (recipient_id, actor_id, type, post_id, read, created_at) values ('${U(to)}', ${from ? `'${U(from)}'` : "null"}, '${type}', ${post ? `'${post}'` : "null"}, ${read}, now() - interval '${ageMin} minutes') returning id`).split("\n")[0];
      const claim = () => { const r = psql("t", "select public.push_claim_batch(200)", ["-v", "ON_ERROR_STOP=1"]); if (r.status !== 0) console.log("CLAIM ERR:", r.stderr.split("\n").find((l) => /ERROR/.test(l))); return JSON.parse(r.stdout.trim() || "[]"); };
      const skipOf = (id) => q(`select coalesce(push_skip_reason, '-') from public.notifications where id='${id}'`);
      const P = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const mkPost = (n, creator = 1) => Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(n)}','${U(creator)}','u','video') on conflict do nothing`);

      // ── 1. tokens ──
      resetN();
      ok("a signed-in person saves their token", as(U(1), `select public.register_push_token('${TOK(1)}', 'ios')`).ok && q(`select count(*) from public.push_tokens where user_id='${U(1)}'`) === "1");
      ok("saving it again is one row", as(U(1), `select public.register_push_token('${TOK(1)}', 'ios')`).ok && q(`select count(*) from public.push_tokens`) === "1");
      ok("the same phone, another person signs in: the token moves to them", as(U(2), `select public.register_push_token('${TOK(1)}', 'ios')`).ok && q(`select user_id from public.push_tokens where token='${TOK(1)}'`) === U(2));
      ok("a token that is not an Expo token is refused", ["abc", "ExpoPushToken[]", "ExponentPushToken[a b]", "x'); drop table public.push_tokens; --"].every((t) => !as(U(1), `select public.register_push_token('${t.replace(/'/g, "''")}', 'ios')`).ok));
      ok("signed out: not callable", !asRole("anon", `select public.register_push_token('${TOK(2)}', 'ios')`).ok);
      ok("a person cannot read tokens (their own either): only the server can", as(U(2), "select count(*) from public.push_tokens").ok === false);
      ok("a person removes only their own token", (() => { as(U(1), `select public.remove_push_token('${TOK(1)}')`); const still = q(`select count(*) from public.push_tokens`) === "1"; as(U(2), `select public.remove_push_token('${TOK(1)}')`); return still && q(`select count(*) from public.push_tokens`) === "0"; })());

      // ── 2. settings ──
      ok("no row: defaults (everything on, previews off)", as(U(1), "select enabled::text || survived::text || reactions::text || likes::text || friends::text || messages::text || message_preview::text from public.get_push_prefs()").out === "truetruetruetruetruetruefalse");
      ok("setting one switch changes only it", as(U(1), `select public.set_push_prefs('{"likes": false}')`).ok && as(U(1), "select likes::text || messages::text from public.get_push_prefs()").out === "falsetrue");
      ok("it is per person", as(U(3), "select likes::text from public.get_push_prefs()").out === "true");
      ok("a bad value is refused", !as(U(1), `select public.set_push_prefs('{"likes": "maybe"}')`).ok);
      ok("not signed in: not callable", !asRole("anon", "select * from public.get_push_prefs()").ok);

      // ── 3. what is pushed ──
      resetN();
      const tokens = (u, ...n) => n.forEach((i) => Q(`insert into public.push_tokens (token, user_id) values ('${TOK(i)}','${U(u)}')`));
      const ids = { surv: addN("verdict_survived", { from: null }), react: addN("reaction", { post: P(1) }), freq: addN("friend_request"), facc: addN("friend_accept"), follow: addN("follow"), fps: addN("followed_post_survived", { from: null }) };
      mkPost(1);
      let out = claim();
      eq("no token: nothing to send, every row is skipped with the reason", [out.length, Object.values(ids).map(skipOf).sort()], [0, ["no token", "no token", "no token", "no token", "type is not pushed", "type is not pushed"]]);
      resetN(); tokens(1, 1);
      const ids2 = { surv: addN("verdict_survived", { from: null }), react: addN("reaction", { post: P(1) }), freq: addN("friend_request"), facc: addN("friend_accept"), follow: addN("follow"), fps: addN("followed_post_survived", { from: null }) };
      mkPost(1);
      out = claim();
      eq("with a token: survived, reaction, friend request, friend accept are claimed; follow / followed_post_survived are not", out.map((r) => r.type).sort(), ["friend_accept", "friend_request", "reaction", "verdict_survived"]);
      ok("each carries the name, the token, the post and the attempt", out.every((r) => r.tokens.join() === TOK(1) && r.attempts === 1) && out.find((r) => r.type === "reaction").actor_name === "Name2" && out.find((r) => r.type === "reaction").post_id === P(1));
      eq("the rest are skipped for good", [ids2.follow, ids2.fps].map(skipOf), ["type is not pushed", "type is not pushed"]);
      eq("a claimed row is not claimed again at once (retry in 2 minutes)", claim().length, 0);
      Q(`update public.notifications set push_retry_at = now() - interval '1 second' where id='${ids2.surv}'`);
      eq("...but a claimed row that was never reported comes back, with attempt 2", claim().map((r) => [r.type, r.attempts]), [["verdict_survived", 2]]);
      Q(`select public.push_mark_sent(array['${ids2.surv}', '${ids2.react}']::uuid[])`);
      Q(`update public.notifications set push_retry_at = now() - interval '1 second'`);
      eq("sent rows are never claimed again", claim().map((r) => r.type).sort(), ["friend_accept", "friend_request"]);

      // ── settings are respected ──
      resetN(); tokens(1, 1); mkPost(1);
      addN("reaction", { post: P(1) }); addN("friend_request"); addN("verdict_survived", { from: null });
      Q(`insert into public.push_prefs (user_id, reactions) values ('${U(1)}', false)`);
      eq("one kind switched off: only that kind is skipped ('user setting')", [claim().map((r) => r.type).sort(), q(`select push_skip_reason from public.notifications where type='reaction'`)], [["friend_request", "verdict_survived"], "user setting"]);
      resetN(); tokens(1, 1); mkPost(1);
      addN("reaction", { post: P(1) }); addN("friend_request");
      Q(`insert into public.push_prefs (user_id, enabled) values ('${U(1)}', false)`);
      eq("everything off: nothing is sent, all skipped", [claim().length, q(`select string_agg(distinct push_skip_reason, ',') from public.notifications`)], [0, "user setting"]);
      for (const [type, col] of [["verdict_survived", "survived"], ["friend_request", "friends"], ["friend_accept", "friends"], ["message", "messages"], ["like", "likes"]]) {
        resetN(); tokens(1, 1); mkPost(1);
        Q(`insert into public.likes (user_id, post_id) values ('${U(2)}','${P(1)}')`);
        const id = addN(type, { post: P(1), from: type === "verdict_survived" ? null : 2 });
        Q(`insert into public.push_prefs (user_id, ${col}) values ('${U(1)}', false)`);
        ok(`the '${col}' switch controls ${type}`, claim().length === 0 && skipOf(id) === "user setting");
      }

      // ── other skips ──
      resetN(); tokens(1, 1); mkPost(1);
      const own = addN("reaction", { from: 1, post: P(1) });
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(1)}','${U(3)}')`);
      const blocked = addN("friend_request", { from: 3 });
      const fresh = addN("friend_request", { from: 4 });
      const old = addN("friend_request", { from: 5, ageMin: 60 * 25 });
      eq("claims: not your own action, not someone blocked, not older than a day", [claim().map((r) => r.id), skipOf(own), skipOf(blocked), skipOf(old)], [[fresh], "own action", "blocked", "-"]);

      // ── like milestones: 1, 5, 10, 25, each once ──
      resetN(); tokens(1, 1); mkPost(1);
      const likeN = (n) => { for (let i = 0; i < n; i++) Q(`insert into auth.users (id, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}','{"username":"liker${i}"}') on conflict do nothing; insert into public.likes (user_id, post_id) values ('00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}','${P(1)}') on conflict do nothing`); };
      const step = (target) => { likeN(target); const id = addN("like", { post: P(1) }); const r = claim(); return [r.length ? r[0].milestone : null, skipOf(id)]; };
      eq("1 like -> milestone 1", step(1)[0], 1);
      eq("3 likes (a repeat row): not a milestone", step(3), [null, "not a like milestone"]);
      eq("5 likes -> milestone 5", step(5)[0], 5);
      eq("7 likes: not a milestone", step(7)[1], "not a like milestone");
      eq("10 likes -> milestone 10", step(10)[0], 10);
      eq("12 likes: not a milestone", step(12)[1], "not a like milestone");
      eq("25 likes -> milestone 25", step(25)[0], 25);
      eq("40 likes: nothing more", step(40)[1], "not a like milestone");
      resetN(); tokens(1, 1); mkPost(1);
      likeN(6); addN("like", { post: P(1) });
      eq("rows processed late: 6 likes by the time it runs -> milestone 5 (not 1), once", [claim().map((r) => r.milestone), (() => { addN("like", { post: P(1) }); return claim().length; })()], [[5], 0]);
      resetN(); tokens(1, 1); mkPost(1);
      likeN(2); const l1 = addN("like", { post: P(1) }), l2 = addN("like", { post: P(1) });
      eq("two like rows of the same moment -> one push, the other skipped", [claim().length, [l1, l2].map(skipOf).sort()], [1, ["-", "not a like milestone"]]);

      // ── messages: name only, text never for a minor ──
      resetN(); tokens(1, 1); tokens(10, 10);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}'), ('${U(2)}','${U(10)}')`);
      mkPost(1, 2);
      as(U(2), `select public.send_message('${U(1)}', 'see you at 8')`);
      as(U(2), `select public.send_message('${U(10)}', 'secret for the teen')`);
      let m = claim().filter((r) => r.type === "message");
      eq("a message row: sender name, no text by default (the database sends none)", [m.length, m.map((r) => r.preview), m.map((r) => r.last_was_post), m.map((r) => r.actor_name)], [2, [null, null], [false, false], ["Name2", "Name2"]]);
      resetN(); tokens(1, 1); tokens(10, 10);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}'), ('${U(2)}','${U(10)}')`);
      Q(`insert into public.push_prefs (user_id, message_preview) values ('${U(1)}', true), ('${U(10)}', true)`);
      as(U(2), `select public.send_message('${U(1)}', 'see you at 8')`);
      as(U(2), `select public.send_message('${U(10)}', 'secret for the teen')`);
      m = claim().filter((r) => r.type === "message");
      eq("previews ON: an adult gets the text, a MINOR never does (the text does not even leave the database)", [m.find((r) => r.recipient_id === U(1)).preview, m.find((r) => r.recipient_id === U(10)).preview, m.find((r) => r.recipient_id === U(10)).recipient_minor], ["see you at 8", null, true]);
      resetN(); tokens(1, 1);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}')`);
      Q(`insert into public.push_prefs (user_id, message_preview) values ('${U(1)}', true)`);
      mkPost(7, 2); Q(`update public.posts set status='survived', distribution_expires_at = now() + interval '5 hours' where id='${P(7)}'`);
      as(U(2), `select public.send_post_to_friend('${U(1)}', '${P(7)}')`);
      m = claim().filter((r) => r.type === "message");
      eq("a shared post: 'post', and never a text even with previews on", [m[0].last_was_post, m[0].preview], [true, null]);
      resetN(); tokens(1, 1);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}')`);
      as(U(2), `select public.send_message('${U(1)}', 'read already')`);
      as(U(1), `select public.mark_conversation_read('${U(2)}')`);
      Q(`update public.notifications set read = true where type='message'`);
      eq("a message already read is not pushed", [claim().length, q(`select push_skip_reason from public.notifications where type='message'`)], [0, "already read"]);
      resetN(); tokens(1, 1);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}')`);
      as(U(2), `select public.send_message('${U(1)}', 'one')`); as(U(2), `select public.send_message('${U(1)}', 'two')`); as(U(2), `select public.send_message('${U(1)}', 'three')`);
      eq("three messages from one friend while unread = one notification row (so one push)", q(`select count(*) from public.notifications where type='message'`), "1");

      // ── results: sent, retry with back-off, give up ──
      resetN(); tokens(1, 1);
      const nid = addN("friend_request");
      claim();
      Q(`select public.push_mark_retry(array['${nid}']::uuid[], 'MessageRateExceeded')`);
      eq("retry after the 1st attempt: in about a minute, the reason is kept", [q(`select extract(epoch from (push_retry_at - now()))::int between 40 and 61 from public.notifications where id='${nid}'`), q(`select push_error from public.notifications where id='${nid}'`)], ["t", "MessageRateExceeded"]);
      const expected = [[2, "between 240 and 301"], [3, "between 840 and 901"], [4, "between 3540 and 3601"]];
      for (const [attempt, range] of expected) {
        Q(`update public.notifications set push_retry_at = now() - interval '1 second' where id='${nid}'`);
        claim();
        Q(`select public.push_mark_retry(array['${nid}']::uuid[], 'down')`);
        ok(`back-off after attempt ${attempt}`, q(`select extract(epoch from (push_retry_at - now()))::int ${range} from public.notifications where id='${nid}'`) === "t" && q(`select push_attempts from public.notifications where id='${nid}'`) === String(attempt));
      }
      Q(`update public.notifications set push_retry_at = now() - interval '1 second' where id='${nid}'`);
      claim(); Q(`select public.push_mark_retry(array['${nid}']::uuid[], 'still down')`);
      eq("after the 5th attempt it is given up on, with the reason, and never claimed again", [q(`select push_skip_reason from public.notifications where id='${nid}'`), claim().length], ["gave up: still down", 0]);
      resetN(); tokens(1, 1);
      const nid2 = addN("friend_request"); claim();
      Q(`select public.push_mark_skipped(array['${nid2}']::uuid[], 'every token was invalid')`);
      eq("skipped: kept with the reason", skipOf(nid2), "every token was invalid");

      // ── token cleanup and receipts ──
      resetN(); tokens(1, 1, 2); tokens(2, 3);
      eq("DeviceNotRegistered: the tokens are removed, others stay, the count comes back", [q(`select public.push_remove_tokens(array['${TOK(1)}','${TOK(3)}','${TOK(99)}'])`), q("select string_agg(token, ',') from public.push_tokens")], ["2", TOK(2)]);
      Q(`select public.push_save_tickets('[{"id":"T-old","token":"${TOK(2)}"},{"id":"T-new","token":"${TOK(2)}"},{"id":"T-ancient","token":"${TOK(2)}"},{"token":"no id"}]'::jsonb)`);
      Q(`update public.push_tickets set created_at = now() - interval '10 minutes' where ticket_id='T-old'; update public.push_tickets set created_at = now() - interval '30 hours' where ticket_id='T-ancient'`);
      eq("tickets: saved; only those older than 5 minutes are due; older than a day are dropped; one without an id is ignored", [q("select string_agg(ticket_id, ',') from public.push_due_tickets(300)"), q("select count(*) from public.push_tickets")], ["T-old", "2"]);
      Q(`select public.push_finish_tickets(array['T-old'])`);
      eq("finished tickets are deleted", q("select string_agg(ticket_id, ',') from public.push_tickets"), "T-new");

      // ── who may call what ──
      for (const fn of ["push_claim_batch(200)", "push_mark_sent(array[]::uuid[])", "push_mark_retry(array[]::uuid[], 'x')", "push_mark_skipped(array[]::uuid[], 'x')", "push_remove_tokens(array['x'])", "push_save_tickets('[]')", "push_due_tickets(10)", "push_finish_tickets(array['x'])"]) {
        ok(`${fn.split("(")[0]}: not callable by a signed-in person or anon`, !as(U(1), `select public.${fn}`).ok && !asRole("anon", `select public.${fn}`).ok);
      }
      ok("the service role can call them", asRole("service_role", "select public.push_claim_batch(1)").ok && asRole("service_role", "select public.push_due_tickets(1)").ok);
      ok("the push tables are closed to clients", ["push_tokens", "push_prefs", "push_tickets", "push_like_milestones"].every((t) => !as(U(1), `select count(*) from public.${t}`).ok));
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
