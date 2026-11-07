#!/usr/bin/env node
/**
 * scripts/apply-migrations.mjs against a stand-in Management API: dry run sends nothing, a missing Vault pepper stops it before
 * any migration, only the three files run in order each inside begin/commit, a failing file stops the rest, the token is never
 * printed, and nothing else (ship.sh, functions, EAS) is touched.
 *   node --experimental-strip-types --no-warnings scripts/test-apply-migrations.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { FILES, wrapInTransaction } from "./apply-migrations.mjs";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const script = new URL("./apply-migrations.mjs", import.meta.url).pathname;
const SECRET = "sbp_TOPSECRETTOKEN";

function runScript(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withServer(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const query = JSON.parse(body).query;
      seen.push({ auth: req.headers.authorization, query });
      const [code, payload] = handler(query, seen.length);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

eq("the seven files, in this order, and no others", FILES, ["migration-live-snapshot.sql", "migration-known-connections.sql", "migration-stranger-only.sql", "migration-spotlight.sql", "migration-harassment.sql", "migration-recovery.sql", "migration-sanctions.sql"]);
eq("a file is wrapped in one transaction", wrapInTransaction("select 1;\n\n"), "begin;\nselect 1;\ncommit;\n");
const order = readFileSync(new URL("../supabase/MIGRATIONS_ORDER.txt", import.meta.url), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
eq("they are the last seven of MIGRATIONS_ORDER.txt, same order", order.slice(-7), FILES);

const dry = await runScript(["--dry"], { SUPABASE_ACCESS_TOKEN: SECRET, SUPABASE_API_BASE: "http://127.0.0.1:1" });
eq("--dry: exit 0, lists the pepper check and the seven files in order, sends nothing (the API base is unreachable)", [dry.status, /trial_contact_pepper/.test(dry.stdout), FILES.every((f) => dry.stdout.includes(f)), FILES.map((f) => dry.stdout.indexOf(f)).every((v, i, a) => i === 0 || v > a[i - 1])], [0, true, true, true]);
eq("--dry needs no token and prints none", [(await runScript(["--dry"], { SUPABASE_ACCESS_TOKEN: "" })).status, dry.stdout.includes(SECRET)], [0, false]);
eq("no token: refused (exit 2)", (await runScript([], { SUPABASE_ACCESS_TOKEN: "" })).status, 2);
eq("an unknown option is refused", (await runScript(["--force"], { SUPABASE_ACCESS_TOKEN: SECRET })).status, 2);

await withServer(() => [200, [{ n: 0 }]], async (base, seen) => {
  const r = await runScript([], { SUPABASE_ACCESS_TOKEN: ` ${SECRET}\n`, SUPABASE_API_BASE: base });
  eq("no Vault pepper: stops with the instructions (exit 2) and applied NOTHING", [r.status, /vault\.create_secret/.test(r.stderr), seen.length, /trial_contact_pepper/.test(seen[0]?.query ?? "")], [2, true, 1, true]);
  eq("the token is never printed", [r.stdout.includes("TOPSECRET"), r.stderr.includes("TOPSECRET")], [false, false]);
});

await withServer((q) => [200, q.startsWith("select count(*)::int") ? [{ n: 1 }] : []], async (base, seen) => {
  const r = await runScript([], { SUPABASE_ACCESS_TOKEN: SECRET, SUPABASE_API_BASE: base });
  eq("with the pepper: pepper check first, then exactly the seven files in order, each begin ... commit, bearer token sent", [r.status, seen.length, /vault/.test(seen[0].query), seen.slice(1).every((s, i) => s.query === wrapInTransaction(readFileSync(new URL(`../supabase/${FILES[i]}`, import.meta.url), "utf8"))), seen.every((s) => s.auth === `Bearer ${SECRET}`)], [0, 8, true, true, true]);
  eq("it prints what it applied and that ship.sh etc. were not run; no token", [FILES.every((f) => r.stdout.includes(f)), /Not run: ship\.sh/.test(r.stdout), r.stdout.includes("TOPSECRET")], [true, true, false]);
});

await withServer((q, n) => (q.startsWith("select count(*)::int") ? [200, [{ n: 1 }]] : n === 3 ? [400, { message: "syntax error at or near x" }] : [200, []]), async (base, seen) => {
  const r = await runScript([], { SUPABASE_ACCESS_TOKEN: SECRET, SUPABASE_API_BASE: base });
  eq("the second file fails: exit 1, its error shown, the third is NOT run", [r.status, /syntax error at or near x/.test(r.stderr), /rolled back/.test(r.stdout), seen.length, /migration-stranger-only/.test(r.stderr)], [1, true, true, 3, true]);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
