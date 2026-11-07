#!/usr/bin/env node
/**
 * Applies ONLY the stranger-only and Spotlight migrations to the live database, in this order, each in its own transaction:
 *   supabase/migration-live-snapshot.sql, supabase/migration-known-connections.sql, supabase/migration-stranger-only.sql,
 *   supabase/migration-spotlight.sql
 * It never runs ship.sh, never deploys functions and never publishes an app update.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-migrations.mjs          check the Vault pepper, apply the four files
 *   node scripts/apply-migrations.mjs --dry                                   print what it would run (no token, no network)
 *
 * First it checks that the Vault secret trial_contact_pepper exists (contacts and email hashing need it) and stops with a
 * clear message if not (nothing is applied). Each file is sent as ONE request wrapped in begin/commit: if a file fails,
 * the database rolls it back, the script stops, and the files after it are not run. All four files are idempotent, so after
 * fixing the cause you can simply run it again. The token comes from SUPABASE_ACCESS_TOKEN (whitespace stripped) and is never
 * printed. Exit 0 ok, 1 an API / SQL error, 2 bad usage or missing token / pepper.
 * SUPABASE_API_BASE and SUPABASE_PROJECT_REF exist for the tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.SUPABASE_API_BASE || "https://api.supabase.com").replace(/\/+$/, "");
const REF = process.env.SUPABASE_PROJECT_REF || "tfdjymogbtfavdzgfqas";
const TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || "").replace(/\s+/g, "");
const MAX_BYTES = 1_000_000;

export const FILES = ["migration-live-snapshot.sql", "migration-known-connections.sql", "migration-stranger-only.sql", "migration-spotlight.sql"];
export const PEPPER_QUERY = "select count(*)::int as n from vault.decrypted_secrets where name = 'trial_contact_pepper' and coalesce(decrypted_secret, '') <> ''";
export const PEPPER_HELP = `The Vault secret 'trial_contact_pepper' does not exist, so nothing was applied.
Create it once in the Supabase SQL editor (use a long random value and never change it afterwards, or every stored hash stops matching):
  select vault.create_secret('<64+ random characters>', 'trial_contact_pepper');
Then run this script again.`;

/** What is sent for one file: the whole file inside one transaction. */
export const wrapInTransaction = (sql) => `begin;\n${sql.replace(/\s+$/, "")}\ncommit;\n`;

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function api(sql) {
  let res;
  try {
    res = await fetch(`${BASE}/v1/projects/${REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch (e) {
    die(`request failed: ${e?.message || e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.trim().slice(0, 2000) || "(empty response)";
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error || msg;
    } catch {
      /* plain text */
    }
    return { ok: false, status: res.status, message: msg };
  }
  try {
    return { ok: true, rows: JSON.parse(text) };
  } catch {
    return { ok: true, rows: [] };
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  for (const a of args) if (a !== "--dry") die(`unknown option ${a} (only --dry exists)`, 2);
  const dry = args.includes("--dry");
  const dir = process.env.MIGRATIONS_DIR || join(root, "supabase");
  const files = FILES.map((name) => {
    let sql;
    try {
      sql = readFileSync(join(dir, name), "utf8");
    } catch (e) {
      return die(`cannot read ${name}: ${e.message}`, 2);
    }
    const bytes = Buffer.byteLength(JSON.stringify({ query: wrapInTransaction(sql) }));
    if (bytes > MAX_BYTES) die(`${name} is too large for one request (${bytes} bytes)`, 2);
    return { name, sql, bytes };
  });

  if (dry) {
    console.log(`DRY RUN: nothing is sent. Project ${REF}.\n`);
    console.log("1. check the Vault secret trial_contact_pepper exists (stop with a message if not):");
    console.log(`     ${PEPPER_QUERY}`);
    files.forEach((f, i) => console.log(`${i + 2}. apply supabase/${f.name} (${f.bytes} bytes) as: begin; <file>; commit;`));
    console.log("\nNot run: ship.sh, function deploys, EAS update.");
    process.exit(0);
  }

  if (!TOKEN) die("SUPABASE_ACCESS_TOKEN is not set (it is never printed)", 2);
  console.log(`Project ${REF}: checking the Vault secret trial_contact_pepper ...`);
  const pep = await api(PEPPER_QUERY);
  if (!pep.ok) die(`could not check the Vault secret (HTTP ${pep.status}): ${pep.message}\nNothing was applied.`, 1);
  if (!(Number(pep.rows?.[0]?.n) > 0)) die(PEPPER_HELP, 2);
  console.log("  found.");

  const applied = [];
  for (const f of files) {
    process.stdout.write(`Applying supabase/${f.name} (${f.bytes} bytes) ... `);
    const r = await api(wrapInTransaction(f.sql));
    if (!r.ok) {
      console.log("FAILED (rolled back)");
      die(`${f.name}: ${r.message}\nApplied before this: ${applied.length ? applied.join(", ") : "nothing"}. Not run: ${files.slice(applied.length).map((x) => x.name).join(", ")}.`, 1);
    }
    console.log("ok");
    applied.push(f.name);
  }
  console.log(`\nApplied, in order: ${applied.join(" -> ")}.\nNot run: ship.sh, function deploys, EAS update.`);
}
