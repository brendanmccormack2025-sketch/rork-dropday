#!/usr/bin/env node
/** The release script and its lists: every listed file exists, known-connections is last, no old migration that would overwrite newer ones. */
import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("../", import.meta.url).pathname;
const entries = (f) => readFileSync(root + f, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim().split(/\s+/)[0]).filter(Boolean);
const migrations = entries("supabase/MIGRATIONS_ORDER.txt");
const functions = entries("supabase/FUNCTIONS.txt");

eq("every listed migration exists", migrations.filter((f) => !existsSync(root + "supabase/" + f)), []);
eq("migration-known-connections.sql is last", migrations[migrations.length - 1], "migration-known-connections.sql");
eq("no duplicates", new Set(migrations).size, migrations.length);
const defines = (f) => /create or replace function public\.run_survival_checkpoint\(\)/i.test(readFileSync(root + "supabase/" + f, "utf8"));
eq("the only listed file that defines run_survival_checkpoint() is the engine (older definitions are excluded)", migrations.filter(defines), ["migration-trial-engine.sql"]);
const idx = (f) => migrations.indexOf(f);
eq("dependency order: engine before survived-profile before hide-ended before known-connections", idx("migration-trial-engine.sql") < idx("migration-survived-profile.sql") && idx("migration-survived-profile.sql") < idx("migration-hide-ended.sql") && idx("migration-hide-ended.sql") < idx("migration-known-connections.sql"), true);
eq("prerequisites (age tier, blocks / reports) come before the engine", idx("migration-age-gating.sql") < idx("migration-trial-engine.sql") && idx("migration-moderation.sql") < idx("migration-trial-engine.sql"), true);
eq("every listed function has a folder with an index.ts", functions.filter((f) => !existsSync(root + `supabase/functions/${f}/index.ts`)), []);
eq("delete-media is deployed", functions.includes("delete-media"), true);
const sh = readFileSync(root + "ship.sh", "utf8");
const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });
const ship = (e, args = ["msg"]) => spawnSync("bash", [root + "ship.sh", ...args], { env: env(e), encoding: "utf8" });

eq("ship.sh is valid bash", spawnSync("bash", ["-n", root + "ship.sh"]).status, 0);
eq("no psql and no SUPABASE_DB_URL any more", [/psql/.test(sh.replace(/#.*$/gm, "")), /SUPABASE_DB_URL/.test(sh)], [false, false]);
eq("ship.sh runs migrations through the API runner, deploys with npx --yes, publishes with eas", [/node "\$SQL_RUNNER" file "supabase\/\$f"/.test(sh), /npx --yes supabase functions deploy "\$f" --project-ref "\$PROJECT_REF" --use-api/.test(sh), /PROJECT_REF="tfdjymogbtfavdzgfqas"/.test(sh), /npx --yes eas-cli update --channel production --environment production --message "\$MESSAGE" --non-interactive/.test(sh)], [true, true, true, true]);
eq("ship.sh never prints the token (no echo / set -x of it)", [/set -x/.test(sh), /echo[^\n]*(?<!\\)\$\{?SUPABASE_ACCESS_TOKEN/.test(sh), /printf[^\n]*(?<!\\)\$\{?SUPABASE_ACCESS_TOKEN[^)]*\n/.test(sh.split("\n").filter((l) => !l.includes("tr -d")).join("\n"))], [false, false, false]);

const noToken = ship({});
eq("without SUPABASE_ACCESS_TOKEN it stops at the first step and names the variable", [noToken.status !== 0, /SUPABASE_ACCESS_TOKEN is not set/.test(noToken.stderr), /FAILED at step: check arguments and environment/.test(noToken.stderr)], [true, true, true]);
const badToken = ship({ SUPABASE_ACCESS_TOKEN: "eyJhbGciNotAnSbpToken" });
eq("a token that is not sbp_ is refused (the migrations need it) and is not echoed", [badToken.status !== 0, /must start with sbp_/.test(badToken.stderr), (badToken.stderr + badToken.stdout).includes("eyJhbGci")], [true, true, false]);
const dry = (token) => ship({ SHIP_DRY_RUN: "1", SUPABASE_ACCESS_TOKEN: token });
const clean = dry("sbp_TOPSECRETTOKEN");
eq("dry run: every migration through the API in order, then the function, then the update; no secret in the output", [clean.status, migrations.every((m) => clean.stdout.includes(`supabase/${m}`)), clean.stdout.indexOf("migration-known-connections.sql") < clean.stdout.indexOf("deploy function delete-media"), clean.stdout.includes("TOPSECRET"), clean.stderr.includes("TOPSECRET")], [0, true, true, false, false]);
eq("the function deploy uses server-side bundling (--use-api)", /functions deploy delete-media --project-ref tfdjymogbtfavdzgfqas --use-api/.test(clean.stdout), true);
{
  // per-function flags from FUNCTIONS.txt are passed through
  const fs = await import("node:fs");
  const orig = fs.readFileSync(root + "supabase/FUNCTIONS.txt", "utf8");
  fs.writeFileSync(root + "supabase/FUNCTIONS.txt", orig.replace(/^delete-media.*$/m, "delete-media --no-verify-jwt   # test"));
  const flagged = dry("sbp_TOPSECRETTOKEN");
  fs.writeFileSync(root + "supabase/FUNCTIONS.txt", orig);
  eq("flags written after the name in FUNCTIONS.txt are included", /deploy delete-media --project-ref tfdjymogbtfavdzgfqas --use-api --no-verify-jwt/.test(flagged.stdout), true);
}
{
  const out = clean.stdout;
  const i = (x) => out.indexOf(x);
  eq("dry run: dry run of delete-media, then Vault key, then the schedule file, all after the deploy and before the update", [i("deploy function delete-media") < i("delete-media: dry run"), i("supabase-service.mjs dry-run delete-media") < i("supabase-service.mjs vault-sync"), i("vault-sync") < i("(supabase/schedule-delete-media.sql)"), i("(supabase/schedule-delete-media.sql)") < i("publish the app update"), /scheduled:\s+delete-media/.test(out)], [true, true, true, true, true]);
  eq("FUNCTIONS.txt names the schedule file and it exists", [/^delete-media\s+schedule=supabase\/schedule-delete-media\.sql/m.test(readFileSync(root + "supabase/FUNCTIONS.txt", "utf8")), existsSync(root + "supabase/schedule-delete-media.sql")], [true, true]);
}
const messy = dry("\n  sbp_TOPSECRETTOKEN \r\n");
eq("a pasted token with leading / trailing newlines and spaces still works", [messy.status, /skipping/.test(messy.stdout), messy.stdout.includes("TOPSECRET")], [0, false, false]);

// ── pull first, then re-exec: the run uses the freshly pulled script and lists ──
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const git = (cwd, ...a) => { const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr); return r.stdout; };
  const tmp = fs.mkdtempSync(os.tmpdir() + "/ship-reexec-");
  const origin = tmp + "/origin.git", a = tmp + "/a", b = tmp + "/b";
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, a);
  fs.mkdirSync(a + "/supabase");
  fs.writeFileSync(a + "/ship.sh", sh);
  fs.writeFileSync(a + "/supabase/MIGRATIONS_ORDER.txt", "old.sql\n");
  fs.writeFileSync(a + "/supabase/FUNCTIONS.txt", "f1\n");
  git(a, "add", "-A"); git(a, "commit", "-q", "-m", "one"); git(a, "push", "-q", "origin", "HEAD:main");
  git(tmp, "clone", "-q", "-b", "main", origin, b);
  // the new version of the repo: a new migration in the list AND a changed script that proves it is the one running
  const fresh = sh.replace('command -v node >/dev/null 2>&1 || fail "node is not installed"', 'echo "FRESH-SCRIPT"; echo "LIST:$(tr -d \'\\n\' < "$MIGRATIONS_FILE")"; echo "REEXEC=${SHIP_REEXEC:-}"; exit 0');
  fs.writeFileSync(a + "/ship.sh", fresh);
  fs.writeFileSync(a + "/supabase/MIGRATIONS_ORDER.txt", "old.sql\nnew.sql\n");
  git(a, "add", "-A"); git(a, "commit", "-q", "-m", "two"); git(a, "push", "-q", "origin", "HEAD:main");
  const run = (e) => spawnSync("bash", [b + "/ship.sh", "msg"], { env: env({ SUPABASE_ACCESS_TOKEN: "sbp_TOPSECRETTOKEN", ...e }), encoding: "utf8" });
  const r = run({});
  eq("the run pulls first, then re-execs: the pulled script and the NEW migration list are the ones used", [r.status, /FRESH-SCRIPT/.test(r.stdout), /LIST:old\.sql\s*new\.sql/.test(r.stdout), /REEXEC=1/.test(r.stdout), r.stdout.indexOf("git pull") < r.stdout.indexOf("FRESH-SCRIPT")], [0, true, true, true, true]);
  eq("the pull happens once (the guard stops a loop) and the token is not printed", [(r.stdout.match(/==> git pull/g) || []).length, (r.stdout + r.stderr).includes("TOPSECRET")], [1, false]);
  // already up to date, old script in a fresh clone of the old commit: guard variable set -> no second pull / exec
  const guarded = run({ SHIP_REEXEC: "1" });
  eq("with the guard variable set it does not pull or re-exec again", [/==> git pull/.test(guarded.stdout), /re-running ship\.sh/.test(guarded.stdout)], [false, false]);
  // a failing pull stops the run before anything else
  fs.writeFileSync(b + "/local.txt", "x"); fs.writeFileSync(b + "/supabase/MIGRATIONS_ORDER.txt", "diverged\n"); git(b, "commit", "-q", "-am", "local"); 
  git(a, "commit", "-q", "--allow-empty", "-m", "three"); git(a, "push", "-q", "origin", "HEAD:main");
  const nff = run({});
  eq("a pull that cannot fast-forward stops the run at the git pull step", [nff.status !== 0, /FAILED at step: git pull/.test(nff.stderr), /FRESH-SCRIPT/.test(nff.stdout)], [true, true, false]);
  eq("bad arguments / token still fail before any pull", [/==> git pull/.test(noToken.stdout), /==> git pull/.test(badToken.stdout)], [false, false]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── the SQL runner against a local mock of the Management API ──
const http = await import("node:http");
const requests = [];
let mode = "ok";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
    if (mode === "error") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ message: 'relation "public.nope" does not exist' })); }
    else if (mode === "413") { res.writeHead(413); res.end("Payload Too Large"); }
    else { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify([{ n: 0 }])); }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// async (spawnSync would block this process, and with it the mock server)
const run = (args, tokenValue = "\nsbp_RUNNERSECRET\n") => new Promise((resolve) => {
  const c = spawn("node", [root + "scripts/supabase-sql.mjs", ...args], { env: env({ SUPABASE_ACCESS_TOKEN: tokenValue, SUPABASE_API_BASE: base }) });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
  c.on("close", (status) => resolve({ status, stdout, stderr }));
});
const first = migrations[0];
const ok1 = await run(["file", root + "supabase/" + first]);
const sent = requests[0];
eq("a migration is POSTed to /v1/projects/<ref>/database/query with the bearer token (whitespace stripped) and {\"query\": <file>}", [ok1.status, sent.method, sent.url, sent.auth, sent.type, JSON.parse(sent.body).query === readFileSync(root + "supabase/" + first, "utf8")], [0, "POST", "/v1/projects/tfdjymogbtfavdzgfqas/database/query", "Bearer sbp_RUNNERSECRET", "application/json", true]);
const tricky = "select $$a'b\"c\\d \u00e9$$;";
requests.length = 0;
await run(["query", tricky]);
eq("the JSON body survives quotes, dollar quoting and unicode in the SQL", JSON.parse(requests[0].body).query === tricky, true);
mode = "error";
const bad = await run(["file", root + "supabase/" + first]);
eq("an API error: its message is printed, the exit code is 1, the token is not", [bad.status, /API error \(HTTP 400\): relation "public\.nope" does not exist/.test(bad.stderr), (bad.stderr + bad.stdout).includes("RUNNERSECRET")], [1, true, false]);
mode = "413";
const big = await run(["file", root + "supabase/" + first]);
eq("HTTP 413 says the migration is too large for one request", [big.status, /TOO LARGE for one request/.test(big.stderr)], [1, true]);
mode = "ok";
requests.length = 0;
const q = await run(["query", "select count(*) as n from cron.job"]);
eq("a query prints the result rows as JSON", [q.status, q.stdout.trim()], [0, '[{"n":0}]']);
requests.length = 0;
const tooBigFile = root + "supabase/.tmp-too-big.sql";
(await import("node:fs")).writeFileSync(tooBigFile, "-- " + "x".repeat(1_100_000));
const huge = await run(["file", tooBigFile]);
(await import("node:fs")).unlinkSync(tooBigFile);

// ── the service-role helper against a mock Management API + functions host ──
{
  const seen = [];
  let fnStatus = 200;
  let keys = [{ name: "anon", type: "legacy", api_key: "ANONKEY" }, { name: "service_role", type: "legacy", api_key: "SERVICE.ROLE-KEY" }, { name: "default", type: "secret", api_key: "sb_secret_NEWKEY" }];
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith("/v1/projects/tfdjymogbtfavdzgfqas/api-keys")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(keys)); }
      else if (req.url.startsWith("/functions/v1/delete-media")) { res.writeHead(fnStatus, { "content-type": "application/json" }); res.end(fnStatus === 200 ? '{"dryRun":true,"wouldDelete":{"post-videos":3}}' : '{"message":"boom"}'); }
      else if (req.url.endsWith("/database/query")) { res.writeHead(201); res.end("[]"); }
      else { res.writeHead(404); res.end("{}"); }
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mbase = `http://127.0.0.1:${mock.address().port}`;
  const svc = (args) => new Promise((resolve) => {
    const c = spawn("node", [root + "scripts/supabase-service.mjs", ...args], { env: env({ SUPABASE_ACCESS_TOKEN: "\nsbp_SVCSECRET\n", SUPABASE_API_BASE: mbase, SUPABASE_FUNCTIONS_BASE: mbase }) });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const d = await svc(["dry-run", "delete-media"]);
  const call = seen.find((x) => x.url.startsWith("/functions/"));
  eq("dry run: POSTs the function WITHOUT ?run=1 using the service role key, prints the answer, never the keys", [d.status, call.method, call.url, call.auth, d.stdout.trim(), (d.stdout + d.stderr).includes("SERVICE.ROLE-KEY"), (d.stdout + d.stderr).includes("SVCSECRET")], [0, "POST", "/functions/v1/delete-media", "Bearer SERVICE.ROLE-KEY", '{"dryRun":true,"wouldDelete":{"post-videos":3}}', false, false]);
  seen.length = 0;
  const v = await svc(["vault-sync"]);
  const q = JSON.parse(seen.find((x) => x.url.endsWith("/database/query")).body).query;
  eq("vault-sync writes the key to Vault idempotently (update or create) and prints neither key", [v.status, /vault\.update_secret/.test(q), /vault\.create_secret\('SERVICE\.ROLE-KEY', 'service_role_key'\)/.test(q), (v.stdout + v.stderr).includes("SERVICE.ROLE-KEY"), (v.stdout + v.stderr).includes("SVCSECRET")], [0, true, true, false, false]);
  keys = keys.filter((k) => k.name !== "service_role");
  seen.length = 0;
  const n = await svc(["dry-run", "delete-media"]);
  eq("without a legacy service_role key the sb_secret_ key is used; only key names / kinds are printed", [n.status, seen.find((x) => x.url.startsWith("/functions/")).auth, /using the sb_secret_ key/.test(n.stderr), /default\(secret\)/.test(n.stderr), (n.stdout + n.stderr).includes("sb_secret_NEWKEY")], [0, "Bearer sb_secret_NEWKEY", true, true, false]);
  const fn = readFileSync(root + "supabase/functions/delete-media/index.ts", "utf8");
  eq("delete-media authorizes both key kinds itself (own key or a proven service-level key) and FUNCTIONS.txt deploys it with --no-verify-jwt", [/sb_secret_\|eyJ/.test(fn), /auth\.admin\.listUsers/.test(fn), /^delete-media\s.*--no-verify-jwt/m.test(readFileSync(root + "supabase/FUNCTIONS.txt", "utf8"))], [true, true, true]);
  fnStatus = 500;
  const f = await svc(["dry-run", "delete-media"]);
  eq("a failing dry run exits 1 with the message (so ship.sh does not schedule)", [f.status, /HTTP 500\): boom/.test(f.stderr)], [1, true]);
  mock.close();
}
server.close();
eq("a file over the size limit is refused before any request is made", [huge.status, /TOO LARGE for one request/.test(huge.stderr), requests.length], [1, true, 0]);
eq("the biggest listed migration fits in one request", Math.max(...migrations.map((m) => readFileSync(root + "supabase/" + m).length)) < 1_000_000, true);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
