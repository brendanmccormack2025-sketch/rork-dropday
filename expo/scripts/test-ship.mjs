#!/usr/bin/env node
/** The release script and its lists: every listed file exists, known-connections is last, no old migration that would overwrite newer ones. */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
eq("ship.sh is valid bash", spawnSync("bash", ["-n", root + "ship.sh"]).status, 0);
eq("ship.sh uses the exact commands asked for", [/psql "\$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f/.test(sh), /npx --yes supabase functions deploy "\$f" --project-ref "\$PROJECT_REF"/.test(sh), /PROJECT_REF="tfdjymogbtfavdzgfqas"/.test(sh), /npx --yes eas-cli update --channel production --environment production --message "\$MESSAGE" --non-interactive/.test(sh)], [true, true, true, true]);
eq("ship.sh never prints the secrets (no echo / set -x of the variables)", [/set -x/.test(sh), /echo[^\n]*(?<!\\)\$\{?SUPABASE_(DB_URL|ACCESS_TOKEN)/.test(sh), /printf[^\n]*(?<!\\)\$\{?SUPABASE_(DB_URL|ACCESS_TOKEN)/.test(sh)], [false, false, false]);
const noEnv = spawnSync("bash", [root + "ship.sh", "m"], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8" });
eq("without SUPABASE_DB_URL it stops at the first step and names the variable, not its value", [noEnv.status !== 0, /SUPABASE_DB_URL is not set/.test(noEnv.stderr), /FAILED at step: check arguments and environment/.test(noEnv.stderr)], [true, true, true]);
const dryEnv = (token) => ({ PATH: process.env.PATH, HOME: process.env.HOME, SHIP_DRY_RUN: "1", SUPABASE_DB_URL: "postgres://u:TOPSECRET@h/db", ...(token === undefined ? {} : { SUPABASE_ACCESS_TOKEN: token }) });
const dryNoToken = spawnSync("bash", [root + "ship.sh", "msg"], { env: dryEnv(undefined), encoding: "utf8" });
const dryBadToken = spawnSync("bash", [root + "ship.sh", "msg"], { env: dryEnv("eyJhbGciNotAnSbpToken"), encoding: "utf8" });
const skipOk = (r) => r.status === 0 && /skipping function deploy/.test(r.stdout) && !/deploy function delete-media/.test(r.stdout) && migrations.every((m) => r.stdout.includes(m)) && /eas-cli update/.test(r.stdout) && !r.stdout.includes("eyJhbGci");
eq("no token, or a token that is not sbp_: prints 'skipping function deploy' and still runs the migrations and the update", [skipOk(dryNoToken), skipOk(dryBadToken)], [true, true]);
const dry = spawnSync("bash", [root + "ship.sh", "msg"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, SHIP_DRY_RUN: "1", SUPABASE_DB_URL: "postgres://u:TOPSECRET@h/db", SUPABASE_ACCESS_TOKEN: "sbp_TOPSECRETTOKEN" }, encoding: "utf8" });
eq("with an sbp_ token a dry run lists every migration and function in order and leaks no secret", [dry.status, dry.stdout.includes("TOPSECRET"), dry.stderr.includes("TOPSECRET"), migrations.every((m) => dry.stdout.includes(m)), dry.stdout.indexOf("migration-known-connections.sql") < dry.stdout.indexOf("deploy function delete-media")], [0, false, false, true, true]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
