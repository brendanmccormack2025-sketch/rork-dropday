#!/usr/bin/env node
/**
 * The graduation migration, run for real on a scratch PostgreSQL (a mock of Supabase's auth schema and roles, the
 * app's real supabase/schema.sql, then supabase/migration-graduation.sql twice). Checks the enforcement the app relies
 * on: who may post, what stays allowed, that clients cannot change the status, and that the audit is written.
 * Skipped (not failed) on a machine without PostgreSQL.
 *   node --experimental-strip-types --no-warnings scripts/test-graduation-sql.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/14/bin", "/usr/local/bin", "/usr/bin"].find((d) => existsSync(join(d, "initdb")));
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const run = (cmd, args, opts = {}) => spawnSync(asRoot && opts.asPostgres ? "runuser" : cmd, asRoot && opts.asPostgres ? ["-u", "postgres", "--", cmd, ...args] : args, { encoding: "utf8" });

const migration = read("../supabase/migration-graduation.sql");

// ── static checks (always) ──
{
  ok("columns: status with its check, reason, time, admin, and the three links", /creator_status text not null default 'active'/.test(migration) && /check \(creator_status in \('active', 'graduated', 'restricted'\)\)/.test(migration) && /graduation_reason text/.test(migration) && /graduated_at timestamptz/.test(migration) && /graduated_by uuid/.test(migration) && /instagram_url text/.test(migration) && /tiktok_url text/.test(migration) && /youtube_url text/.test(migration));
  ok("audit table with old/new status, reason, who, when", /create table if not exists public\.creator_status_audit/.test(migration) && /old_status text/.test(migration) && /new_status text not null/.test(migration) && /changed_by uuid/.test(migration) && /changed_at timestamptz not null default now\(\)/.test(migration));
  ok("idempotent: every create is guarded", !/create table public\./.test(migration) && !/create policy "[^"]+"\s+on public\.posts\s+as restrictive[^;]*;\s*$/m.test("") );
}

if (!BIN) {
  console.log("SKIP  PostgreSQL not installed on this machine: the database checks were not run");
} else {
  const dir = mkdtempSync(join(tmpdir(), "pgt-"));
  if (asRoot) chownSync(dir, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), -1);
  const data = join(dir, "data");
  const port = String(54300 + Math.floor(Math.random() * 500));
  const initdb = run(join(BIN, "initdb"), ["-D", data, "-A", "trust"], { asPostgres: true });
  const start = run(join(BIN, "pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir}`, "-l", join(dir, "log"), "-w", "start"], { asPostgres: true });
  const psql = (db, sql, extra = []) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-A", "-t", "-d", db, ...extra, "-c", sql], { encoding: "utf8" });
  const psqlFile = (db, file) => spawnSync("psql", ["-h", dir, "-p", port, "-U", "postgres", "-X", "-q", "-d", db, "-f", file], { encoding: "utf8" });
  try {
    if (initdb.status !== 0 || start.status !== 0) {
      console.log("SKIP  could not start a scratch PostgreSQL: the database checks were not run");
    } else {
      psql("postgres", "create database t");
      const U = (n) => `00000000-0000-0000-0000-00000000000${n}`;
      const setup = `
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema auth;
        create table auth.users (id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb);
        create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
        grant usage on schema auth to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;`;
      psql("t", setup);
      // the app's real schema (its first GRANT block runs before the tables exist, so it is run twice, as documented)
      const schemaPath = new URL("../supabase/schema.sql", import.meta.url).pathname;
      psqlFile("t", schemaPath); psqlFile("t", schemaPath);
      psql("t", `
        create table public.group_posts (id uuid primary key default gen_random_uuid(), group_id uuid, user_id uuid not null references public.profiles(id), media_url text);
        alter table public.group_posts enable row level security;
        create policy gp_ins on public.group_posts for insert to authenticated with check (auth.uid()=user_id);
        grant insert on public.group_posts to authenticated;
        create table public.messages (id uuid primary key default gen_random_uuid(), sender_id uuid not null, body text);
        alter table public.messages enable row level security;
        create policy m_ins on public.messages for insert to authenticated with check (auth.uid()=sender_id);
        grant insert on public.messages to authenticated;`);
      const migPath = new URL("../supabase/migration-graduation.sql", import.meta.url).pathname;
      const m1 = psqlFile("t", migPath);
      const m2 = psqlFile("t", migPath);
      eq("the migration applies cleanly, and again (idempotent)", [m1.stderr.includes("ERROR"), m2.stderr.includes("ERROR")], [false, false]);

      // (the schema's trigger creates each profile from the sign-up metadata)
      const seed = psql("t", `insert into auth.users (id, raw_user_meta_data) values
        ('${U(1)}','{"username":"alice"}'),('${U(2)}','{"username":"bigbob"}'),('${U(3)}','{"username":"rita"}'),('${U(4)}','{"username":"newbie"}');`); if (seed.status !== 0) console.log('SEED ERR', seed.stderr);
      // As a signed-in client (the role PostgREST uses): returns { ok, error }
      const asClient = (uid, sql) => {
        const r = psql("t", `set role authenticated; set request.jwt.claim.sub = '${uid}'; ${sql}`, ["-v", "ON_ERROR_STOP=1"]);
        return { ok: r.status === 0, error: (r.stderr || "").split("\n").find((l) => /ERROR/.test(l)) ?? "" };
      };
      const post = (uid, parent = "null") => `insert into public.posts (user_id, media_url, media_type, parent_post_id) values ('${uid}', 'u', 'video', ${parent})`;

      eq("a new profile is 'active' by default", psql("t", `select creator_status from public.profiles where id='${U(1)}'`).stdout.trim(), "active");
      ok("an ACTIVE user can post", asClient(U(1), post(U(1))).ok);
      const root = psql("t", "select id from public.posts limit 1").stdout.trim();
      ok("(setup) a root post exists to react to", /^[0-9a-f-]{36}$/.test(root));

      eq("admin snippet: graduate by username (case-insensitive), with a reason", psql("t", "select public.admin_set_creator_status('BigBob', 'graduated', 'Reached 100k followers')").stdout.trim(), "BigBob is now graduated (Reached 100k followers)");
      eq("admin snippet: restrict", psql("t", "select public.admin_set_creator_status('rita', 'restricted', 'Under review')").stdout.trim(), "rita is now restricted (Under review)");

      // graduated
      const g = asClient(U(2), post(U(2)));
      ok("a GRADUATED user cannot post (root post), with the message the app maps", !g.ok && /POSTING_GRADUATED/.test(g.error));
      ok("a graduated user cannot post to a group either", !asClient(U(2), `insert into public.group_posts (user_id, media_url) values ('${U(2)}','u')`).ok);
      ok("a graduated user CAN react (a post with a parent)", asClient(U(2), post(U(2), `'${root}'`)).ok);
      ok("a graduated user CAN message", asClient(U(2), `insert into public.messages (sender_id, body) values ('${U(2)}','hi')`).ok);
      ok("a graduated user CAN like", asClient(U(2), `insert into public.likes (user_id, post_id) values ('${U(2)}', '${root}')`).ok);
      ok("a graduated user CAN follow", asClient(U(2), `insert into public.follows (follower_id, followee_id) values ('${U(2)}','${U(1)}')`).ok);
      ok("a graduated user can still edit their own profile (bio)", asClient(U(2), `update public.profiles set bio='hello' where id='${U(2)}'`).ok);
      eq("(their existing posts and profile are untouched)", psql("t", "select count(*) from public.posts").stdout.trim(), "2");

      // restricted
      const r = asClient(U(3), post(U(3)));
      ok("a RESTRICTED user cannot post, with its own message", !r.ok && /POSTING_RESTRICTED/.test(r.error));
      ok("a restricted user CAN react and message", asClient(U(3), post(U(3), `'${root}'`)).ok && asClient(U(3), `insert into public.messages (sender_id, body) values ('${U(3)}','hi')`).ok);

      // clients cannot change status / graduation fields / admin links
      ok("a client cannot set their own creator_status", !asClient(U(2), `update public.profiles set creator_status='active' where id='${U(2)}'`).ok);
      ok("a client cannot clear graduation_reason or graduated_at", !asClient(U(2), `update public.profiles set graduation_reason=null where id='${U(2)}'`).ok && !asClient(U(2), `update public.profiles set graduated_at=null where id='${U(2)}'`).ok);
      ok("a client cannot set the admin links", !asClient(U(1), `update public.profiles set instagram_url='https://instagram.com/x' where id='${U(1)}'`).ok);
      ok("an active client cannot graduate themselves", !asClient(U(1), `update public.profiles set creator_status='graduated' where id='${U(1)}'`).ok);
      ok("a client cannot create a profile that is already graduated or has admin links (the insert is forced to the defaults)", (() => {
        psql("t", `insert into auth.users (id, raw_user_meta_data) values ('${U(5)}', '{"username":"sneaky"}'); delete from public.profiles where id='${U(5)}';`);
        asClient(U(5), `insert into public.profiles (id, username, creator_status, instagram_url, graduated_at) values ('${U(5)}','sneaky2','graduated','https://instagram.com/x', now())`);
        return psql("t", `select creator_status || ':' || coalesce(instagram_url,'-') || ':' || (graduated_at is null) from public.profiles where id='${U(5)}'`).stdout.trim() === "active:-:true";
      })());
      ok("a client cannot run the admin functions", !asClient(U(1), "select public.admin_set_creator_status('alice','graduated','x')").ok);
      eq("(nothing changed)", psql("t", "select creator_status from public.profiles where username in ('alice','bigbob') order by username").stdout.trim().split("\n"), ["active", "graduated"]);

      // audit
      const audit = psql("t", "select user_id::text, old_status, new_status, reason from public.creator_status_audit order by id").stdout.trim().split("\n");
      eq("the audit has a row per change, with old/new status and the reason", audit, [`${U(2)}|active|graduated|Reached 100k followers`, `${U(3)}|active|restricted|Under review`]);
      eq("restoring writes another audit row and clears graduated_at", [psql("t", "select public.admin_set_creator_status('bigbob','active','Restored after review')").stdout.trim(), psql("t", `select old_status || '>' || new_status || ':' || reason from public.creator_status_audit order by id desc limit 1`).stdout.trim(), psql("t", `select graduated_at is null from public.profiles where id='${U(2)}'`).stdout.trim()], ["bigbob is now active (Restored after review)", "graduated>active:Restored after review", "t"]);
      ok("a RESTORED user can post again", asClient(U(2), post(U(2))).ok);
      ok("an unchanged status writes no audit row", (() => {
        const before = psql("t", "select count(*) from public.creator_status_audit").stdout.trim();
        psql("t", `update public.profiles set bio='again' where id='${U(2)}'`);
        return psql("t", "select count(*) from public.creator_status_audit").stdout.trim() === before;
      })());
      ok("clients cannot read or write the audit table", !asClient(U(1), "select * from public.creator_status_audit").ok && !asClient(U(1), "insert into public.creator_status_audit (user_id,new_status) values ('" + U(1) + "','x')").ok);

      // links
      eq("admin snippet: set links (https only, right hosts)", psql("t", "select public.admin_set_creator_links('bigbob', 'https://www.instagram.com/bigbob', 'https://www.tiktok.com/@bigbob', 'https://www.youtube.com/@bigbob')").stdout.trim(), "links updated for bigbob");
      eq("(stored)", psql("t", `select instagram_url || ' ' || tiktok_url || ' ' || youtube_url from public.profiles where id='${U(2)}'`).stdout.trim(), "https://www.instagram.com/bigbob https://www.tiktok.com/@bigbob https://www.youtube.com/@bigbob");
      ok("a non-https or wrong-host link is rejected", psql("t", "select public.admin_set_creator_links('bigbob', 'http://instagram.com/x')").status !== 0 && psql("t", "select public.admin_set_creator_links('bigbob', null, 'https://evil.example/@x')").status !== 0 && psql("t", "select public.admin_set_creator_links('bigbob', 'javascript:alert(1)')").status !== 0);
      eq("null leaves a link alone, '' clears it", [psql("t", "select public.admin_set_creator_links('bigbob', null, '', null)").status, psql("t", `select coalesce(tiktok_url,'-') || ' ' || instagram_url from public.profiles where id='${U(2)}'`).stdout.trim()], [0, "- https://www.instagram.com/bigbob"]);
      ok("a reason is required", psql("t", "select public.admin_set_creator_status('bigbob','graduated','  ')").status !== 0);
      ok("an unknown user is an error, not silence", psql("t", "select public.admin_set_creator_status('nobody','graduated','x')").status !== 0);
    }
  } finally {
    run(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { asPostgres: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
