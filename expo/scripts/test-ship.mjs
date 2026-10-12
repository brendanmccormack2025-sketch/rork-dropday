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
eq("ship.sh runs migrations through the API runner, deploys with npx --yes, publishes with eas", [/node "\$SQL_RUNNER" file "supabase\/\$f"/.test(sh), /npx --yes supabase functions deploy "\$f" --project-ref "\$PROJECT_REF"/.test(sh), /PROJECT_REF="tfdjymogbtfavdzgfqas"/.test(sh), /npx --yes eas-cli update --channel production --environment production --message "\$MESSAGE" --non-interactive/.test(sh)], [true, true, true, true]);
eq("ship.sh never prints the token (no echo / set -x of it)", [/set -x/.test(sh), /echo[^\n]*(?<!\\)\$\{?SUPABASE_ACCESS_TOKEN/.test(sh), /printf[^\n]*(?<!\\)\$\{?SUPABASE_ACCESS_TOKEN[^)]*\n/.test(sh.split("\n").filter((l) => !l.includes("tr -d")).join("\n"))], [false, false, false]);

const noToken = ship({});
eq("without SUPABASE_ACCESS_TOKEN it stops at the first step and names the variable", [noToken.status !== 0, /SUPABASE_ACCESS_TOKEN is not set/.test(noToken.stderr), /FAILED at step: check arguments and environment/.test(noToken.stderr)], [true, true, true]);
const badToken = ship({ SUPABASE_ACCESS_TOKEN: "eyJhbGciNotAnSbpToken" });
eq("a token that is not sbp_ is refused (the migrations need it) and is not echoed", [badToken.status !== 0, /must start with sbp_/.test(badToken.stderr), (badToken.stderr + badToken.stdout).includes("eyJhbGci")], [true, true, false]);
const dry = (token) => ship({ SHIP_DRY_RUN: "1", SUPABASE_ACCESS_TOKEN: token });
const clean = dry("sbp_TOPSECRETTOKEN");
eq("dry run: every migration through the API in order, then the function, then the update; no secret in the output", [clean.status, migrations.every((m) => clean.stdout.includes(`supabase/${m}`)), clean.stdout.indexOf("migration-known-connections.sql") < clean.stdout.indexOf("deploy function delete-media"), clean.stdout.includes("TOPSECRET"), clean.stderr.includes("TOPSECRET")], [0, true, true, false, false]);
const messy = dry("\n  sbp_TOPSECRETTOKEN \r\n");
eq("a pasted token with leading / trailing newlines and spaces still works", [messy.status, /skipping/.test(messy.stdout), messy.stdout.includes("TOPSECRET")], [0, false, false]);

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
server.close();
eq("a file over the size limit is refused before any request is made", [huge.status, /TOO LARGE for one request/.test(huge.stderr), requests.length], [1, true, 0]);
eq("the biggest listed migration fits in one request", Math.max(...migrations.map((m) => readFileSync(root + "supabase/" + m).length)) < 1_000_000, true);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
