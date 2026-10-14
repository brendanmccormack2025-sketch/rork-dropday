#!/usr/bin/env node
/**
 * Friends and direct messages (supabase/migration-friends-messages.sql), run for real on a scratch PostgreSQL: a mock of
 * Supabase's auth / vault / cron, the app's schema.sql and every migration the feature builds on (the trial engine, known
 * connections, survived profile, hide ended), then the friends migration twice. Checks the rules the app relies on:
 * invite links, requests, who may message whom, blocks, what may be sent, and that a view that came from a message never
 * counts toward a verdict. Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-friends-sql.mjs
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

      const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const asUser = (uid, sql) => psql("t", `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
      const out = (r) => r.stdout.trim().split("\n").filter((l) => l && !/^SET$/.test(l)).pop() ?? "";
      const as = (uid, sql) => { const r = asUser(uid, sql); return { ok: r.status === 0, out: out(r), err: r.stderr }; };
      const mkUser = (n, birth = "1990-01-01") => Q(`insert into auth.users (id, raw_user_meta_data) values ('${U(n)}','{"username":"u${n}"}') on conflict do nothing; update public.profiles set birthdate='${birth}', created_at = now() - interval '100 hours' where id='${U(n)}'`);
      const wipe = () => Q(`delete from public.message_post_opens; delete from public.chat_messages; delete from public.chat_reads; delete from public.chat_conversations; delete from public.friend_requests; delete from public.friendships; delete from public.invite_versions; delete from public.user_blocks; delete from public.hide_from_list; delete from public.contact_hashes; delete from public.user_phone_hash; delete from public.notifications; delete from public.reports; delete from public.post_view_stats; delete from public.post_raw_views; delete from public.post_qualified_views; delete from public.likes; delete from public.posts; delete from public.trial_assignments; delete from public.trial_post_state`);
      for (let i = 1; i <= 9; i++) mkUser(i);
      mkUser(10, "2012-06-01"); mkUser(11, "2011-03-01");         // two minors
      const friends = (a, b) => q(`select count(*) from public.friendships where user_a=least('${U(a)}'::uuid,'${U(b)}') and user_b=greatest('${U(a)}'::uuid,'${U(b)}')`) === "1";
      const friendCount = () => q(`select count(*) from public.friendships`);

      // ── 1. invite links ──
      wipe();
      const tokenA = as(U(1), "select public.my_invite_token()").out;
      ok("a personal token: 32 hex id . version . 32 hex signature", /^[0-9a-f]{32}\.1\.[0-9a-f]{32}$/.test(tokenA));
      eq("the token is stable (asking again gives the same link)", as(U(1), "select public.my_invite_token()").out, tokenA);
      eq("the signature is an HMAC-SHA256 of 'id.version' with the Vault secret", tokenA.split(".")[2], createHmac("sha256", "test-invite-secret-0123456789-abcdefghijklmnopqrstuvwxyz").update(`${U(1).replace(/-/g, "")}.1`).digest("hex").slice(0, 32));
      ok("opening it as another user makes them friends at once", as(U(2), `select public.redeem_invite('${tokenA}')`).out === U(1) && friends(1, 2));
      eq("mutual: both see each other in their friend lists", [as(U(1), "select count(*) from public.my_friends() where id = '" + U(2) + "'").out, as(U(2), "select count(*) from public.my_friends() where id = '" + U(1) + "'").out], ["1", "1"]);
      as(U(2), `select public.redeem_invite('${tokenA}')`); as(U(2), `select public.redeem_invite('${tokenA}')`);
      eq("opening it again changes nothing: still one friendship, one notification", [friendCount(), q(`select count(*) from public.notifications where recipient_id='${U(1)}' and type='friend_accept'`)], ["1", "1"]);
      ok("the same link works for other people (it is a personal link), each becomes a friend of its owner only", as(U(3), `select public.redeem_invite('${tokenA}')`).ok && friends(1, 3) && !friends(2, 3) && friendCount() === "2");
      const bad = (label, tok) => ok(`rejected: ${label}`, !as(U(4), `select public.redeem_invite('${tok}')`).ok && !friends(4, 1) && !friends(4, 5));
      const [idA, verA, sigA] = tokenA.split(".");
      const tokenB = as(U(5), "select public.my_invite_token()").out;
      bad("a flipped signature", `${idA}.${verA}.${sigA.replace(/^./, sigA[0] === "0" ? "1" : "0")}`);
      bad("user 5's id with user 1's signature (forged to befriend 5)", `${U(5).replace(/-/g, "")}.${verA}.${sigA}`);
      bad("a made-up version", `${idA}.2.${sigA}`);
      bad("a signature of all zeros", `${idA}.${verA}.${"0".repeat(32)}`);
      bad("garbage", "hello");
      bad("an empty token", "");
      bad("a token with SQL in it", `${idA}.1.${sigA}'; delete from public.friendships; --`);
      eq("nothing was created by the forgeries", friendCount(), "2");
      ok("your own link cannot be opened by you", !as(U(1), `select public.redeem_invite('${tokenA}')`).ok);
      ok("not signed in: the functions are not callable", psql("t", `set role anon; select public.redeem_invite('${tokenB}')`, ["-v", "ON_ERROR_STOP=1"]).status !== 0);
      const rotated = as(U(1), "select public.rotate_my_invite()").out;
      ok("rotating gives a new link and kills the old one", rotated !== tokenA && /\.2\./.test(rotated) && !as(U(6), `select public.redeem_invite('${tokenA}')`).ok && as(U(6), `select public.redeem_invite('${rotated}')`).ok && friends(1, 6));
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(5)}','${U(7)}')`);
      ok("a blocked person cannot become a friend through the link", !as(U(7), `select public.redeem_invite('${tokenB}')`).ok && !friends(5, 7));
      ok("the invite is not usable for someone who deleted... (a token for a user that does not exist)", !as(U(4), `select public.redeem_invite('${"f".repeat(32)}.1.${"0".repeat(32)}')`).ok);

      // ── 2. requests ──
      wipe();
      eq("search: a prefix finds people, never yourself", as(U(1), "select string_agg(username, ',' order by username) from public.search_people('u1')").out, "u10,u11");
      ok("search needs 2 letters and treats % and _ as plain characters", as(U(1), "select count(*) from public.search_people('u')").out === "0" && as(U(1), "select count(*) from public.search_people('u%')").out === "0");
      eq("request: sent -> pending, the other sees it", [as(U(1), `select public.send_friend_request('${U(2)}')`).out, as(U(2), "select count(*) from public.my_friend_requests() where direction = 'incoming'").out, as(U(1), `select relation from public.search_people('u2')`).out], ["requested", "1", "requested"]);
      ok("accepting makes them friends and clears the request", as(U(2), `select public.respond_friend_request('${U(1)}', true)`).ok && friends(1, 2) && q("select count(*) from public.friend_requests") === "0");
      as(U(1), `select public.send_friend_request('${U(3)}')`);
      as(U(3), `select public.respond_friend_request('${U(1)}', false)`);
      ok("declining removes it and makes no friendship", !friends(1, 3) && q("select count(*) from public.friend_requests") === "0");
      as(U(4), `select public.send_friend_request('${U(5)}')`);
      eq("both asked each other: that is a yes", [as(U(5), `select public.send_friend_request('${U(4)}')`).out, friends(4, 5)], ["friends", true]);
      ok("only the addressee can answer", (() => { as(U(6), `select public.send_friend_request('${U(7)}')`); return !as(U(8), `select public.respond_friend_request('${U(6)}', true)`).ok && !as(U(6), `select public.respond_friend_request('${U(6)}', true)`).ok; })());
      ok("not yourself, not a stranger id", !as(U(1), `select public.send_friend_request('${U(1)}')`).ok && !as(U(1), `select public.send_friend_request('${U(99)}')`).ok);
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(8)}','${U(9)}')`);
      ok("a blocked person cannot send a request, and the blocker cannot either", !as(U(9), `select public.send_friend_request('${U(8)}')`).ok && !as(U(8), `select public.send_friend_request('${U(9)}')`).ok);
      eq("search hides people blocked either way", as(U(9), "select count(*) from public.search_people('u8')").out, "0");
      ok("under 18: an adult cannot send a request to a minor", !as(U(1), `select public.send_friend_request('${U(10)}')`).ok && q("select count(*) from public.friend_requests where addressee_id='" + U(10) + "'") === "0");
      ok("...but a minor can send one to an adult, and a minor to a minor", as(U(10), `select public.send_friend_request('${U(1)}')`).ok && as(U(10), `select public.send_friend_request('${U(11)}')`).ok);
      ok("friend lists and requests are private (RLS)", as(U(9), "select count(*) from public.friendships").out === "0" && as(U(9), "select count(*) from public.friend_requests").out === "0");
      ok("clients cannot write the tables directly", !as(U(1), `insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(9)}')`).ok && !as(U(1), `insert into public.friend_requests (requester_id, addressee_id) values ('${U(1)}','${U(9)}')`).ok);

      // ── 3. messages ──
      wipe();
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}'), ('${U(2)}','${U(3)}')`);
      ok("friends can message", as(U(1), `select public.send_message('${U(2)}', 'hello')`).ok);
      ok("non-friends cannot (no conversation is made either)", !as(U(1), `select public.send_message('${U(3)}', 'hi')`).ok && !as(U(1), `select public.send_message('${U(9)}', 'hi')`).ok && q("select count(*) from public.chat_conversations") === "1");
      ok("not yourself, not empty, not too long", !as(U(1), `select public.send_message('${U(1)}', 'x')`).ok && !as(U(1), `select public.send_message('${U(2)}', '   ')`).ok && !as(U(1), `select public.send_message('${U(2)}', '${"x".repeat(2001)}')`).ok);
      ok("a friend of a friend still cannot read the chat (RLS)", as(U(3), "select count(*) from public.chat_messages").out === "0" && as(U(3), "select count(*) from public.chat_conversations").out === "0");
      eq("the two people read it", [as(U(1), "select count(*) from public.chat_messages").out, as(U(2), "select count(*) from public.chat_messages").out], ["1", "1"]);
      ok("nobody writes messages directly", !as(U(1), `insert into public.chat_messages (conversation_id, sender_id, body) select id, '${U(1)}', 'forged' from public.chat_conversations`).ok && !as(U(2), `update public.chat_messages set body='edited'`).ok && !as(U(2), `delete from public.chat_messages`).ok);
      ok("a stranger cannot read by id either", as(U(9), `select count(*) from public.chat_messages where sender_id='${U(1)}'`).out === "0");
      eq("unread: the receiver has 1, the sender 0", [as(U(2), "select public.my_unread_messages()").out, as(U(1), "select public.my_unread_messages()").out], ["1", "0"]);
      eq("a message notification is made, one while unread", [(as(U(1), `select public.send_message('${U(2)}', 'again')`), q(`select count(*) from public.notifications where recipient_id='${U(2)}' and type='message' and read is not true`))], ["1"]);
      as(U(2), `select public.mark_conversation_read('${U(1)}')`);
      eq("reading clears the count and the notification", [as(U(2), "select public.my_unread_messages()").out, q(`select count(*) from public.notifications where recipient_id='${U(2)}' and type='message' and read is not true`)], ["0", "0"]);
      const mid = q(`select id from public.chat_messages where body='hello'`);
      ok("only the sender deletes their message; it stays gone for both", !as(U(2), `select public.delete_my_message('${mid}')`).ok === false && q(`select count(*) from public.chat_messages where id='${mid}' and deleted_at is null`) === "1" && as(U(1), `select public.delete_my_message('${mid}')`).ok && q(`select count(*) from public.chat_messages where id='${mid}' and deleted_at is not null and body is null`) === "1");
      ok("report: the receiver can report; the sender cannot report their own; a stranger cannot", (() => { const m2 = q(`select id from public.chat_messages where body='again'`); return !as(U(1), `select public.report_message('${m2}', 'spam')`).ok && !as(U(9), `select public.report_message('${m2}', 'spam')`).ok && as(U(2), `select public.report_message('${m2}', 'harassment')`).ok && q(`select count(*) from public.reports where target_type='message' and target_id='${m2}'`) === "1" && as(U(2), `select public.report_message('${m2}', 'harassment')`).ok && q(`select count(*) from public.reports where target_type='message'`) === "1"; })());
      // blocks
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(2)}','${U(1)}')`);
      ok("blocked: neither side can send, the chat disappears for both", !as(U(1), `select public.send_message('${U(2)}', 'x')`).ok && !as(U(2), `select public.send_message('${U(1)}', 'x')`).ok && as(U(1), "select count(*) from public.chat_messages").out === "0" && as(U(2), "select count(*) from public.chat_messages").out === "0" && as(U(1), "select count(*) from public.my_conversations()").out === "0");
      eq("a blocked friend is hidden from the friend list", as(U(1), "select count(*) from public.my_friends()").out, "0");
      Q(`delete from public.user_blocks`);
      ok("unblocked: the chat is back", as(U(1), `select public.send_message('${U(2)}', 'back')`).ok && as(U(1), "select count(*) from public.chat_messages where deleted_at is null").out === "2");
      eq("conversation list shows the other person and the last text", as(U(1), "select other_id || '|' || last_text from public.my_conversations()").out, `${U(2)}|back`);

      // ── 4. sending posts ──
      wipe();
      const P = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
      const mkP = (n, creator, status, extra = "") => Q(`insert into public.posts (id, user_id, media_url, media_type) values ('${P(n)}','${creator}','u','video'); update public.posts set status='${status}', created_at=now()-interval '60 minutes', testing_started_at=now()-interval '60 minutes', checkpoint_at=now()+interval '24 hours'${status === "survived" ? ", survived_at=now()-interval '1 hour', distribution_started_at=now()-interval '1 hour', distribution_expires_at=now()+interval '23 hours'" : ""} where id='${P(n)}'` + (extra ? `; update public.posts set ${extra.replace(/^,\s*/, "")} where id='${P(n)}'` : ""));
      // creator 1; sender 2; recipients 3 (stranger to the creator), 4 (in the creator's contacts), 5 (on the hide list), 6 (the creator's friend), 7 (unknown, minor)
      Q(`insert into public.friendships (user_a, user_b) values ('${U(2)}','${U(3)}'), ('${U(2)}','${U(4)}'), ('${U(2)}','${U(5)}'), ('${U(2)}','${U(6)}'), ('${U(1)}','${U(6)}'), ('${U(1)}','${U(8)}'), ('${U(2)}','${U(10)}')`);
      const NUM = (n) => `+1415555010${n}`;
      as(U(4), `select public.set_my_phone('${NUM(4)}')`);
      as(U(1), `select public.sync_my_contacts(array['${NUM(4)}'])`);
      Q(`insert into public.hide_from_list (owner_id, hidden_user_id) values ('${U(1)}','${U(5)}')`);
      mkP(1, U(1), "survived");
      for (const r of [3, 4, 5, 6]) ok(`a survived post goes to any friend (${r})`, as(U(2), `select public.send_post_to_friend('${U(r)}', '${P(1)}')`).ok);
      mkP(2, U(1), "trial");
      Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(2)}','${U(2)}')`);   // the sender has seen it in the feed
      ok("a testing post goes to a friend the creator does not know", as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(2)}')`).ok);
      ok("...not to someone in the creator's contacts (either direction)", !as(U(2), `select public.send_post_to_friend('${U(4)}', '${P(2)}')`).ok);
      ok("...not to someone on the creator's hide list", !as(U(2), `select public.send_post_to_friend('${U(5)}', '${P(2)}')`).ok);
      ok("...not to a friend of the creator", !as(U(2), `select public.send_post_to_friend('${U(6)}', '${P(2)}')`).ok);
      eq("nothing was written by the rejected sends", q(`select count(*) from public.chat_messages where post_id='${P(2)}'`), "1");
      ok("the same holds if the creator knows the recipient by phone the other way round", (() => { as(U(3), `select public.set_my_phone('${NUM(3)}')`); Q(`delete from public.contact_hashes`); as(U(3), `select public.sync_my_contacts(array['${NUM(1)}'])`); as(U(1), `select public.set_my_phone('${NUM(1)}')`); return !as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(2)}')`).ok; })());
      Q(`delete from public.contact_hashes; delete from public.user_phone_hash; delete from public.chat_messages where post_id='${P(2)}'`);
      ok("the creator sends their own testing post to their friends", as(U(1), `select public.send_post_to_friend('${U(6)}', '${P(2)}')`).ok && as(U(1), `select public.send_post_to_friend('${U(8)}', '${P(2)}')`).ok);
      ok("...but not to someone who is not their friend", !as(U(1), `select public.send_post_to_friend('${U(9)}', '${P(2)}')`).ok);
      mkP(3, U(1), "trial");
      ok("someone who never saw the testing post cannot send it (no guessing ids)", !as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(3)}')`).ok);
      mkP(4, U(1), "survived", ", distribution_expires_at=now()-interval '1 minute'");
      mkP(5, U(1), "archived");
      mkP(6, U(1), "survived", ", moderation_status='hidden'");
      ok("an expired, archived or hidden post cannot be sent", [4, 5, 6].every((n) => !as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(n)}')`).ok));
      Q(`insert into public.posts (id, user_id, media_url, media_type, parent_post_id) values ('${P(7)}','${U(3)}','u','video','${P(1)}')`);
      ok("a reaction cannot be sent", !as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(7)}')`).ok);
      mkP(8, U(1), "survived", ", is_mature=true");
      ok("a mature post is not sent to a minor", !as(U(2), `select public.send_post_to_friend('${U(10)}', '${P(8)}')`).ok && as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(8)}')`).ok);
      ok("not to a non-friend", !as(U(2), `select public.send_post_to_friend('${U(9)}', '${P(1)}')`).ok);
      Q(`insert into public.user_blocks (blocker_id, blocked_id) values ('${U(1)}','${U(3)}')`);
      ok("a testing post is not sent to someone the creator blocked", !as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(2)}')`).ok);
      Q(`delete from public.user_blocks`);

      // availability when opening
      const msgOf = (post, to) => q(`select id from public.chat_messages where post_id='${post}' and conversation_id in (select id from public.chat_conversations where '${to}' in (user_a, user_b)) order by created_at desc limit 1`);
      const mA = msgOf(P(1), U(3));
      eq("opening a survived post says it is available", as(U(3), `select available from public.open_shared_post('${mA}')`).out, "t");
      Q(`update public.posts set moderation_status='hidden' where id='${P(1)}'`);
      eq("a post hidden later is not available any more", as(U(3), `select available from public.open_shared_post('${mA}')`).out, "f");
      Q(`update public.posts set moderation_status='active', status='expired' where id='${P(1)}'`);
      eq("...nor one that expired", as(U(3), `select available from public.open_shared_post('${mA}')`).out, "f");
      Q(`delete from public.posts where id='${P(1)}'`);
      eq("...nor one that was deleted (the message stays, the post is gone)", [as(U(3), `select available from public.open_shared_post('${mA}')`).out, q(`select count(*) from public.chat_messages where id='${mA}' and post_id is null and was_post`)], ["f", "1"]);
      ok("a stranger cannot open someone else's message", !as(U(9), `select * from public.open_shared_post('${mA}')`).ok);
      // the creator befriends the recipient later: the testing post the stranger had been sent is no longer available to them
      as(U(2), `select public.send_post_to_friend('${U(3)}', '${P(2)}')`);
      const mB = q(`select id from public.chat_messages where post_id='${P(2)}' and sender_id='${U(2)}' order by created_at desc limit 1`);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(3)}') on conflict do nothing`);
      eq("a testing post sent by someone else stops being available once the recipient is known to its creator", as(U(3), `select available from public.open_shared_post('${mB}')`).out, "f");

      // ── 5. friends are known people ──
      wipe();
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}')`);
      eq("the friend branch of known_connections: both directions", q(`select count(*) from public.known_connections where source='friend'`), "2");
      ok("so a friend of the creator is silenced for the creator's testing posts", q(`select public.trial_is_silenced('${U(1)}','${U(2)}')`) === "t" && q(`select public.trial_is_silenced('${U(2)}','${U(1)}')`) === "t");
      ok("a stranger is not", q(`select public.trial_is_silenced('${U(1)}','${U(9)}')`) === "f");
      ok("clients cannot read known_connections", !as(U(1), "select * from public.known_connections").ok);

      // ── 6. views that came from a message never count ──
      wipe();
      for (let i = 20; i <= 30; i++) mkUser(i);
      Q(`insert into public.friendships (user_a, user_b) values ('${U(20)}','${U(21)}'), ('${U(20)}','${U(22)}')`);
      mkP(1, U(1), "survived");
      mkP(10, U(1), "trial");
      Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(10)}','${U(20)}'), ('${P(10)}','${U(25)}')`);
      Q(`insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms) values ('${P(10)}','${U(25)}', 9000, 12000)`);
      Q(`insert into public.post_qualified_views (post_id, viewer_id) values ('${P(10)}','${U(25)}')`);
      const viewers = (post) => q(`select coalesce(string_agg(viewer_id::text, ',' order by viewer_id), '') from public.trial_post_score_details('${post}')`);
      const before = viewers(P(10));
      ok("(setup) the genuine viewer 25 is in the verdict", before.includes(U(25)));
      as(U(20), `select public.send_post_to_friend('${U(21)}', '${P(10)}')`);
      ok("(setup) the sender has seen it; the post goes to a friend the creator does not know", q(`select count(*) from public.chat_messages where post_id='${P(10)}'`) === "1");
      const mm = q(`select id from public.chat_messages where post_id='${P(10)}'`);
      eq("opening it records the source", [as(U(21), `select available from public.open_shared_post('${mm}')`).out, q(`select count(*) from public.message_post_opens where post_id='${P(10)}' and viewer_id='${U(21)}'`)], ["t", "1"]);
      const vc0 = q(`select view_count from public.posts where id='${P(10)}'`);
      as(U(21), `select public.record_view_progress('${P(10)}', 12000, 12000, true)`);
      as(U(21), `select public.record_raw_view('${P(10)}')`);
      as(U(21), `select public.record_post_share('${P(10)}')`);
      Q(`insert into public.likes (user_id, post_id) values ('${U(21)}','${P(10)}')`);
      Q(`insert into public.posts (user_id, media_url, media_type, parent_post_id) values ('${U(21)}','u','video','${P(10)}')`);
      eq("watch time, impression, share: no row in any view table", [q(`select count(*) from public.post_view_stats where viewer_id='${U(21)}'`), q(`select count(*) from public.post_raw_views where viewer_id='${U(21)}'`), q(`select count(*) from public.post_qualified_views where viewer_id='${U(21)}'`)], ["0", "0", "0"]);
      eq("the view counter did not move", q(`select view_count from public.posts where id='${P(10)}'`), vc0);
      ok("they are not exposed, so the engine does not treat the post as seen by them", q(`select public.trial_exposed('${P(10)}','${U(21)}')`) === "f");
      eq("the verdict's viewer list is unchanged (their like and reaction have no viewer row to count on)", viewers(P(10)), before);
      ok("a trigger, not just the functions: a direct insert is refused too", (() => { Q(`insert into public.post_raw_views (post_id, viewer_id) values ('${P(10)}','${U(21)}')`); return q(`select count(*) from public.post_raw_views where viewer_id='${U(21)}'`) === "0"; })());
      ok("a genuine feed viewer still counts", (() => { as(U(26), `select public.record_view_progress('${P(10)}', 9000, 12000, false)`); return viewers(P(10)).includes(U(26)); })());
      eq("a person who saw it in the feed BEFORE it was sent keeps that view", [as(U(20), `select 1`).ok, q(`select count(*) from public.post_raw_views where viewer_id='${U(20)}' and post_id='${P(10)}'`)], [true, "1"]);

      // ── 7. RLS isolation, overall ──
      wipe();
      Q(`insert into public.friendships (user_a, user_b) values ('${U(1)}','${U(2)}'), ('${U(3)}','${U(4)}')`);
      as(U(1), `select public.send_message('${U(2)}', 'secret 1-2')`); as(U(3), `select public.send_message('${U(4)}', 'secret 3-4')`);
      eq("each person sees only their own chat", [1, 2, 3, 4, 5].map((u) => as(U(u), "select count(*) from public.chat_messages").out), ["1", "1", "1", "1", "0"]);
      eq("...and only their own conversations, reads, friendships", [as(U(1), "select count(*) from public.chat_conversations").out, as(U(5), "select count(*) from public.chat_conversations").out, as(U(5), "select count(*) from public.chat_reads").out, as(U(1), "select count(*) from public.friendships").out], ["1", "0", "0", "1"]);
      ok("the anon role has no access at all", ["chat_messages", "chat_conversations", "friendships", "friend_requests", "message_post_opens", "invite_versions"].every((t) => psql("t", `set role anon; select count(*) from public.${t}`, ["-v", "ON_ERROR_STOP=1"]).status !== 0));
      ok("message_post_opens and invite_versions are not readable by clients", !as(U(1), "select * from public.message_post_opens").ok && !as(U(1), "select * from public.invite_versions").ok);
      eq("conversations never mix: the list shows only your own", [as(U(1), "select count(*) from public.my_conversations()").out, as(U(3), "select count(*) from public.my_conversations()").out], ["1", "1"]);
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
